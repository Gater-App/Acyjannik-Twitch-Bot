import http from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { FeatureStore, type CustomCommand, type QuestPolicy, type QuestStatus, type SeasonalEvent, type WidgetType } from './feature-store.js';
import { communityWidgetHtml, ARCADE_CARD, ARCADE_REWARDS_CARD, ARCADE_REWARDS_SCRIPT, ARCADE_SCRIPT, QUEST_POLL_CARD, QUEST_POLL_SCRIPT, VAULT_CARD, VAULT_SCRIPT } from './dashboard-community-ui.js';
import { SPARK_CARD, SPARK_SCRIPT } from './conversation-spark-ui.js';
import { MINI_GAME_CARD, MINI_GAME_SCRIPT } from './mini-games-ui.js';
import { CHANNEL_POINTS_CARD, CHANNEL_POINTS_SCRIPT } from './channel-points-ui.js';
import type { MiniGames } from './mini-games.js';
import type { CommunityArcade } from './community-arcade.js';
import type { ChannelPointsService } from './channel-points.js';
import { DEFAULT_CHANNEL_POINTS_SETTINGS } from './channel-points.js';
import type { Logger } from './logger.js';
import { DEFAULT_SPARK_CONFIG, normalizeSparkConfig, SPARK_QUESTION_POOLS } from './conversation-spark.js';
import { DASHBOARD_UX_V3_SCRIPT, ELIO_STATUS_SCRIPT } from './dashboard-ux.js';
import { EIGHT_BALL_SETTINGS_SCRIPT } from './eight-ball-ui.js';
import { chooseEightBallAnswer, DEFAULT_EIGHT_BALL_SETTINGS } from './eight-ball-answers.js';
import { ChatResponsePolicy, DEFAULT_CHAT_RESPONSE_SETTINGS } from './chat-response-policy.js';
import type { ChatCategory } from './chat-message-format.js';
import { DEFAULT_HELP_AVAILABILITY, type HelpAvailability } from './help.js';
import { renderPublicHelpPage } from './public-help.js';
import { CommunityTips, COMMUNITY_TIP_CATEGORIES } from './community-tips.js';
import { AutomaticChatMessages, AUTO_CHAT_ACTIVITY_THRESHOLD } from './automatic-chat-messages.js';
import type { SpotifySongRequests } from './song-requests.js';
import type { CommunityVault } from './community-vault.js';
import { SONG_REQUESTS_CARD, SONG_REQUESTS_SCRIPT } from './song-requests-ui.js';
import { formatPublicChatMessage } from './chat-message-format.js';
import { AUTOMATIC_CHAT_HINTS_UI_SCRIPT } from './automatic-chat-hints-ui.js';
import { BOT_RESTART_COOLDOWN_MS, BOT_RESTART_MARKER_TTL_MS, type BotLifecycle } from './bot-lifecycle.js';
import { ViewerCommunityPortal } from './community-portal.js';
import { RateLimitBuckets, setRateLimitHeaders, trustedClientAddress, type RateLimitDecision } from './request-limits.js';
import { PRANKS_CARD, PRANKS_SCRIPT, moderatorPranksPage } from './moderator-pranks-ui.js';
import { MEMORY_CATEGORIES, memoriesModerationPage } from './community-memories.js';
import { communityIdeasAdminPage } from './community-ideas.js';
import { LIVE_CONTROL_PAGE } from './live-control.js';
import type { ModeratorPranks, PrankKind } from './moderator-pranks.js';
import type { EventWeights } from './types.js';
import type { TwitchVipService } from './twitch-vip.js';
import { VipExperience } from './vip-experience.js';
import { VIP_ADMIN_CARD, VIP_ADMIN_SCRIPT, VIP_MODERATOR_CARD, VIP_MODERATOR_SCRIPT } from './vip-experience-ui.js';

interface Session { userId: string; login: string; csrf: string; expiresAt: number; role: 'admin'|'moderator'; }
interface RuntimeStatus { twitchConnected: boolean; channel: string; startedAt: number; lastError?: string; queued?: number; suppressed?: number; streamLive?: boolean|undefined; streamStatusCheckedAt?: number; streamSnapshot?:{title?:string;gameName?:string;viewerCount?:number;startedAt?:string}; lastChatReceiveAt?:number; lastBotChatSendAt?:number; lastBotChatSendErrorAt?:number; chatResponse?: { profile: string; suppressed: number; deferred: number }; }
interface TokenValidation { client_id: string; user_id: string; login: string; }
interface HelixUser { id: string; login: string; display_name: string; }
type DashboardQuestSettings = QuestPolicy & { enabled: boolean; chatEnabled: boolean; channelPointsEnabled: boolean;
  modsCanModerate: boolean; modsCanSkip: boolean; moderatorUserIds: string[] };
type DashboardPollSettings = { enabled: boolean; durationMs: number; allowVoteChange: boolean; ignoredUserIds: string[] };

const DASHBOARD_POLLING_SCRIPT = `(()=>{
const activeFlights=new Map(),shortCache=new Map();window.dashboardRetryUntil=0;
window.fetch=((original)=>async(input,init={})=>{const method=(init.method||'GET').toUpperCase(),url=new URL(typeof input==='string'?input:input.url,location.href);
if(method!=='GET'||url.origin!==location.origin||!/^\\/dashboard\\/api\\//u.test(url.pathname)){const response=await original(input,init);if(method!=='GET'&&url.origin===location.origin&&/^\\/dashboard\\/api\\//u.test(url.pathname)&&response.ok)shortCache.clear();return response;}
const key=url.pathname+url.search,now=Date.now(),cached=shortCache.get(key);if(cached&&now-cached.at<1500)return cached.response.clone();
if(activeFlights.has(key))return (await activeFlights.get(key)).clone();
const flight=(async()=>{const response=await original(input,init);if(response.status===429){const seconds=Math.min(60,Math.max(1,Number(response.headers.get('Retry-After'))||5));window.dashboardRetryUntil=Math.max(window.dashboardRetryUntil,Date.now()+seconds*1000)}else if(response.ok)shortCache.set(key,{at:Date.now(),response:response.clone()});return response})();activeFlights.set(key,flight);
try{return (await flight).clone()}finally{activeFlights.delete(key)}})(window.fetch.bind(window));
window.dashboardPollVisible=(target)=>{if(document.visibilityState==='hidden')return false;const node=typeof target==='string'?document.querySelector(target):target;if(!node)return false;for(let p=node;p&&p!==document.body;p=p.parentElement)if(p.hidden)return false;return node.getClientRects().length>0};
window.dashboardPoll=(target,fn,interval)=>{let running=false;const run=async()=>{if(running||!window.dashboardPollVisible(target)||Date.now()<window.dashboardRetryUntil)return;running=true;try{await fn()}finally{running=false}};const timer=setInterval(run,interval);const wake=()=>{if(document.visibilityState!=='hidden')void run()};document.addEventListener('visibilitychange',wake);window.addEventListener('dashboard:viewchange',wake);queueMicrotask(wake);return timer};
})();`;
const DASHBOARD_FAIRNESS_SCRIPT = `(()=>{const root=document.querySelector('#halloween-fairness');if(!root)return;fetch('/dashboard/api/fairness').then(r=>r.json().then(d=>{if(!r.ok)throw Error(d.error||'Nicht verfügbar');root.replaceChildren();const p=document.createElement('p');p.textContent='Aktive Quelle: '+d.source+' · Summe der Gewichte: '+d.total;root.append(p);const ul=document.createElement('ul');for(const [name,weight] of Object.entries(d.weights)){const li=document.createElement('li');li.textContent=name+': Gewicht '+weight+' ('+(100*weight/d.total).toFixed(2)+' %)';ul.append(li)}root.append(ul);const shares=document.createElement('p');shares.textContent='Theoretisch: Gewinn '+d.shares.positive.toFixed(2)+' % · Verlust '+d.shares.negative.toFixed(2)+' % · neutral '+d.shares.neutral.toFixed(2)+' %.';root.append(shares);const note=document.createElement('p');note.textContent=d.historyAvailable?'Beobachtete Ergebnisse sind aggregiert verfügbar.':'Historische Einzelereignisse werden nicht gespeichert; daher gibt es keine belastbare Beobachtungsstatistik.';root.append(note)})).catch(e=>root.textContent='Fairness-Daten konnten nicht geladen werden: '+e.message)})();`;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DISCORD_DEFAULTS={enabled:false,accountLinkEnabled:false,elioEnabled:false,discordDropsEnabled:false,ideasChannelId:'',rewardsChannelId:'',liveChannelId:'',dropChannelId:'',notifyIdeas:true,notifyLevels:false,notifyDrops:false,notifyQuests:false,notifySeasonal:false,notifyLive:false};
const DISCORD_PAGE=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf" content="__CSRF__"><title>Discord-Verbindung</title><style nonce="__NONCE__">:root{color-scheme:dark;font:16px system-ui;background:#11131b;color:#eef0f8}body{margin:0}main{max-width:820px;margin:auto;padding:24px 16px}.card{background:#1b1e29;border:1px solid #333746;border-radius:14px;padding:18px}label{display:block;margin:12px 0}input{display:block;width:100%;max-width:440px;padding:10px;border-radius:8px;background:#10121a;color:white;border:1px solid #44495d}input[type=checkbox]{display:inline-block;width:18px;height:18px;vertical-align:middle;margin-right:8px}button{padding:11px 15px;background:#7652bd;color:white;border:0;border-radius:8px;min-height:44px;cursor:pointer}#notice{min-height:1.5em;color:#c7a9ff}.muted{color:#aeb2c3}a{color:#cbb2ff}</style></head><body><main><p><a href="/dashboard">← Zurück zum Dashboard</a></p><h1>Discord-Verbindung</h1><p class="muted">Der Twitch-Bot bleibt führend für Ideen und Community-Daten. Hier ordnest du Zielkanäle zu und schaltest ausgewählte Hinweise frei.</p><p id="notice" role="status"></p><section class="card"><form id="form"><label><input name="enabled" type="checkbox"> Integration aktivieren</label><label><input name="accountLinkEnabled" type="checkbox"> Twitch- und Discord-Konten verknüpfen</label><label><input name="elioEnabled" type="checkbox"> Elio in Discord aktivieren</label><label><input name="discordDropsEnabled" type="checkbox"> Mystery Drops mit Discord teilen</label><p class="muted">Mit /verknuepfen in Discord kann ein Mitglied sein Twitch-Konto sicher verbinden. Dies ändert keine XP und führt keine Konten zusammen.</p><label>Ideenkanal-ID<input name="ideasChannelId" inputmode="numeric" placeholder="Discord-Kanal-ID"></label><label>Belohnungskanal-ID<input name="rewardsChannelId" inputmode="numeric" placeholder="Optional"></label><label>Live-Hinweis-Kanal-ID<input name="liveChannelId" inputmode="numeric" placeholder="Optional"></label><label>Mystery-Drop-Kanal-ID<input name="dropChannelId" inputmode="numeric" placeholder="Optional"></label><h2>Hinweise</h2><label><input name="notifyIdeas" type="checkbox"> Ideen und Statusänderungen</label><label><input name="notifyLevels" type="checkbox"> Besondere Levelaufstiege</label><label><input name="notifyDrops" type="checkbox"> Mystery-Drops</label><label><input name="notifyQuests" type="checkbox"> Quest-Abschlüsse</label><label><input name="notifySeasonal" type="checkbox"> Saison-Events</label><label><input name="notifyLive" type="checkbox"> Twitch-Live-Status</label><button type="submit">Einstellungen speichern</button></form><h2>Vorschau (wird nicht gesendet)</h2><ul class="muted"><li>💡 Neue Community-Idee wartet auf Prüfung.</li><li>✨ Ein Community-Mitglied hat einen besonderen Levelaufstieg erreicht.</li><li>🔴 Jannik ist live – oder der Stream ist beendet.</li></ul><div id="stats" class="muted"></div><h2>Fehlgeschlagene Zustellungen</h2><ul id="failures" class="muted"></ul><p class="muted">Kanal-IDs kannst du in Discord über Entwicklermodus → Rechtsklick auf den Kanal → „Kanal-ID kopieren“ ermitteln. Es wird keine Testnachricht gesendet. Die Auswahl wird aktuell manuell eingetragen.</p></section></main><script nonce="__NONCE__">(()=>{const form=document.querySelector('#form'),notice=document.querySelector('#notice'),csrf=document.querySelector('meta[name=csrf]').content,stats=document.querySelector('#stats'),failures=document.querySelector('#failures');async function load(){const r=await fetch('/dashboard/api/discord');const d=await r.json();if(!r.ok)throw Error(d.error||'Laden fehlgeschlagen');for(const [k,v] of Object.entries(d.settings)){const el=form.elements.namedItem(k);if(el)el.type==='checkbox'?el.checked=Boolean(v):el.value=String(v||'')}stats.textContent='Bot: '+(d.connection.connected?'online':'keine aktuelle Verbindung')+' · letzter Kontakt: '+(d.connection.lastSeen?new Date(d.connection.lastSeen).toLocaleString('de-DE'):'noch keiner')+' · '+(d.serviceConfigured?'Integrationsschlüssel vorhanden':'Integrationsschlüssel fehlt')+' · Zustellung: '+d.outbox.pending+' offen · '+d.outbox.dead+' fehlgeschlagen · '+d.outbox.delivered+' zugestellt';failures.replaceChildren();for(const item of d.failures||[]){const li=document.createElement('li'),text=document.createElement('span'),button=document.createElement('button');text.textContent=item.type+' · '+item.attempts+' Versuche · '+(item.lastError||'Kein Fehlertext');button.type='button';button.textContent='Erneut zustellen';button.dataset.retryId=item.id;li.append(text,button);failures.append(li)}if(!failures.childElementCount){const li=document.createElement('li');li.textContent='Keine endgültig fehlgeschlagenen Zustellungen.';failures.append(li)}}failures.addEventListener('click',async e=>{const button=e.target.closest('button[data-retry-id]');if(!button)return;button.disabled=true;try{const r=await fetch('/dashboard/api/discord/retry',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({id:button.dataset.retryId})}),d=await r.json();if(!r.ok)throw Error(d.error||'Erneuter Versuch fehlgeschlagen');notice.textContent='Zustellung wird erneut versucht.';await load()}catch(err){notice.textContent=err.message;button.disabled=false}});form.addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));for(const el of form.querySelectorAll('input[type=checkbox]'))data[el.name]=el.checked;try{const r=await fetch('/dashboard/api/discord/settings',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)}),d=await r.json();if(!r.ok)throw Error(d.error||'Speichern fehlgeschlagen');notice.textContent='Einstellungen gespeichert.';await load()}catch(err){notice.textContent=err.message}});load().catch(e=>notice.textContent=e.message)})();</script></body></html>`;
const STREAMER_PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#11131b"><meta name="csrf" content="__CSRF__"><title>Streamer-Steuerung</title><style nonce="__NONCE__">:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#101116;color:#eef0f8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 85% 0,#30234a 0,transparent 35%),#101116}main{max-width:980px;margin:auto;padding:24px 20px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1{font-size:1.4rem;margin:0}a{color:#c6a8ff}.toolbar{display:flex;gap:8px;align-items:center}.status{color:#aaaec0;font-size:.9rem}.group{margin:22px 0}.group h2{font-size:1rem;color:#c6a8ff;margin:0 0 9px}.row{display:grid;grid-template-columns:42px minmax(130px,1fr) minmax(120px,1.4fr) auto;gap:12px;align-items:center;padding:12px 14px;background:#1b1d29;border:1px solid #303342;border-radius:12px;margin:8px 0}.icon{font-size:1.35rem;text-align:center}.name{font-weight:700}.state{color:#b8bbca;font-size:.92rem}.actions{display:flex;gap:6px;justify-content:flex-end}button{font:inherit;color:#fff;background:#7652bd;border:0;border-radius:9px;padding:10px 14px;cursor:pointer;min-height:42px}button.secondary{background:#292b39}button.danger{background:#8c3d50}button:disabled{opacity:.45;cursor:not-allowed}.notice{min-height:24px;color:#f2d5ac}.compact{font-size:.86rem}@media(max-width:620px){main{padding:14px 10px}.row{grid-template-columns:34px 1fr auto;gap:8px;padding:10px}.state{grid-column:2;grid-row:2}.actions{grid-column:3;grid-row:1/3;flex-direction:column}.actions button{padding:8px;font-size:.87rem}header{align-items:flex-start}.toolbar{flex-direction:column;align-items:flex-end}}@media(max-width:380px){.row{grid-template-columns:30px 1fr}.actions{grid-column:1/-1;grid-row:auto;flex-direction:row;justify-content:flex-start;margin-left:38px}.state{grid-column:2}}</style></head><body><main><header><div><h1>🎛 Streamer-Steuerung</h1><div id="stream-status" class="status">Status wird geladen …</div></div><div class="toolbar"><a href="/dashboard">Dashboard</a><button id="compact" class="secondary" type="button">Kompakt</button></div></header><div id="notice" class="notice" role="status"></div><section class="group"><h2>Gerade aktiv</h2><div id="active"></div></section><section class="group"><h2>Spiele &amp; Aktionen</h2><div id="games"></div></section><section class="group"><h2>Saison-Events &amp; Quests</h2><div id="community"></div></section></main><script nonce="__NONCE__">(()=>{const csrf=document.querySelector('meta[name=csrf]').content,el=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),seconds=t=>Math.max(0,Math.ceil((Number(t||0)-Date.now())/1000)),phaseName=p=>({registration:'Anmeldung läuft',role_distribution:'Rollen werden verteilt',playing:'Diskussion läuft',voting:'Abstimmung läuft',results:'Ergebnis',finished:'Beendet'}[p]||'Bereit'),busy=new Set();async function api(path,method='GET',body){const r=await fetch('/dashboard/api/'+path,{method,headers:{'Content-Type':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':csrf})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json().catch(()=>({error:'Antwort konnte nicht gelesen werden.'}));if(!r.ok)throw Error(d.error||'Aktion fehlgeschlagen.');return d}function button(label,action,kind='',disabled=false){return '<button type="button" class="'+kind+'" data-action="'+esc(action)+'" '+(disabled?'disabled':'')+'>'+esc(label)+'</button>'}function row(icon,name,state,actions=''){return '<article class="row"><div class="icon">'+icon+'</div><div class="name">'+esc(name)+'</div><div class="state">'+esc(state)+'</div><div class="actions">'+actions+'</div></article>'}async function update(){try{const [s,m,a,e,q]=await Promise.all(['status','minigames','arcade','events','quests'].map(x=>api(x)));const imp=m.state?.imposter,det=m.state?.detective,drop=a.drop?.drop,liveDrop=drop&&['announced','claiming','resolving'].includes(drop.status),wheel=a.wheel,active=[];if(imp)active.push(row('🎭','Chat-Imposter',phaseName(imp.phase)+' · '+(imp.players?.length||0)+' dabei · noch '+seconds(imp.endsAt)+' Sek.'));if(det)active.push(row('🕵️','Chat-Detektiv',(det.phase==='playing'?'Raten läuft':'Ergebnis')+' · '+det.guesses+' Tipps · noch '+seconds(det.endsAt)+' Sek.'));if(liveDrop)active.push(row('🎁','Mystery Drop',(drop.participants||0)+' Teilnehmende · '+seconds(drop.endsAt)+' s'));if(wheel.activeAction)active.push(row('🎡','Chaos Wheel',wheel.activeAction.title+' · '+seconds(wheel.activeAction.endsAt)+' s'));const guess=await api('streamer-state');if(guess.guess)active.push(row('🔢','Zahlenraten','Runde aktiv · noch '+seconds(guess.guess.expiresAt)+' Sek.'));el('active').innerHTML=active.join('')||'<p class="status">Gerade läuft kein Spiel.</p>';const impAction=!m.settings.enabled?'Minispiele deaktiviert':!imp?'Anmeldung starten':imp.phase==='registration'?'Rollen verteilen':imp.phase==='playing'?'Abstimmung starten':imp.phase==='voting'?'Abstimmung läuft':'Warten …';let gameRows=[row('🎭','Chat-Imposter',imp?phaseName(imp.phase)+' · '+(imp.players?.length||0)+' Teilnehmende':(m.settings.enabled?'Bereit':'Deaktiviert'),imp?(imp.phase==='registration'?button('Rollen verteilen','close-imposter'):imp.phase==='playing'?button('Abstimmung starten','vote-imposter'):button('Abbrechen','cancel-imposter','danger')):button(impAction,'start-imposter', '',!m.settings.enabled)),row('🕵️','Chat-Detektiv',det?'Raten läuft · '+det.guesses+' Tipps':'Bereit',det?button('Runde beenden','end-detective','danger'):button(m.settings.enabled?'Runde starten':'Minispiele deaktiviert','start-detective','',!m.settings.enabled)),row('🎁','Mystery Drop',liveDrop?'Aktiv · '+(drop.participants||0)+' Teilnehmende · noch '+seconds(drop.endsAt)+' Sek.':'Bereit · Zuschauer schreiben !claim',liveDrop?'':button('Drop starten','start-drop')),row('🎡','Chaos Wheel',wheel.autoPilotEnabled?'Automatik aktiv · '+(wheel.reason||''):'Pausiert · '+(wheel.reason||''),button(wheel.canSpin?'Jetzt drehen':wheel.autoPilotEnabled?'Pausieren':'Fortsetzen',wheel.canSpin?'spin':wheel.autoPilotEnabled?'pause-wheel':'resume-wheel',wheel.canSpin?'':'secondary',!wheel.canSpin&&wheel.autoPilotEnabled))];if(!guess.guessEnabled){}else gameRows.push(row('🔢','Zahlenraten',guess.guess?'Aktiv · noch '+seconds(guess.guess.expiresAt)+' Sek.':'Start über vorhandenen Chatbefehl !startguess',guess.guess?'':'<span class="compact">Im Chat: <b>!startguess</b></span>'));el('games').innerHTML=gameRows.join('');const evts=e.events||[];el('community').innerHTML=evts.map(x=>row(x.emoji||'✨',x.name,x.active?'Aktiv':'Bereit',button(x.active?'Beenden':'Starten',x.active?'event-off:'+x.id:'event-on:'+x.id,x.active?'danger':''))).join('')+(q.active?row('📜','Aktive Quest',q.active.title+' · läuft',button('Abschließen','quest-complete:'+q.active.id,'secondary')):'');el('stream-status').textContent='Twitch-Chat: '+(s.eventSubSocket?'verbunden':'Verbindung wird aufgebaut');}catch(err){el('stream-status').textContent='Status konnte nicht geladen werden.';el('notice').textContent=err.message}}document.addEventListener('click',async ev=>{const b=ev.target.closest('[data-action]');if(!b||busy.has(b))return;const action=b.dataset.action;if(action==='cancel-imposter'||action==='end-detective'||action.startsWith('event-off:')||action.startsWith('quest-complete:'))if(!confirm('Möchtest du diese Aktion wirklich ausführen?'))return;busy.add(b);b.disabled=true;try{if(action.startsWith('event-on:')||action.startsWith('event-off:')){const [op,id]=action.split(':');await api('events','POST',{id,active:op==='event-on'})}else if(action==='quest-complete:'+action.split(':')[1])await api('quests/action','POST',{id:action.split(':')[1],action:'complete'});else if(action.startsWith('quest-complete:'))await api('quests/action','POST',{id:action.slice(15),action:'complete'});else if(action==='pause-wheel'||action==='resume-wheel'){const x=await api('arcade');await api('arcade','POST',{settings:{...x.settings,wheelAutoPilotEnabled:action==='resume-wheel'}})}else if(action==='start-drop'||action==='spin')await api('arcade','POST',{action});else await api('minigames/action','POST',{action});el('notice').textContent='Aktion ausgeführt.';await update()}catch(err){el('notice').textContent=err.message}finally{busy.delete(b);b.disabled=false}});el('compact').setAttribute('aria-pressed','false');el('compact').onclick=()=>{const compact=document.body.classList.toggle('compact');el('compact').setAttribute('aria-pressed',String(compact));el('compact').textContent=compact?'Normale Ansicht':'Kompakt'};update();setInterval(update,3000)})();</script></body></html>`;
const DASHBOARD_STYLE = `.main-nav{position:fixed;inset:0 auto 0 0;width:226px;box-sizing:border-box;z-index:8;padding:94px 14px 20px;background:#10111a;border-right:1px solid #292b39;display:flex;flex-direction:column;gap:7px}.main-nav button,.main-nav a{display:flex;gap:11px;align-items:center;text-align:left;background:transparent;color:#aeb2c3;border:1px solid transparent;padding:12px 13px;border-radius:11px;margin:0;text-decoration:none}.main-nav button:hover,.main-nav a:hover{background:#211c30;color:#fff}.main-nav button[aria-current=page]{background:#2a2140;border-color:#534078;color:#f3edff}.dash-layout{margin-left:0;min-height:calc(100vh - 88px)}[hidden]{display:none!important}.dashboard-view{display:none!important}.dashboard-view[data-active=true]{display:block!important}.dashboard-view>h2{margin:8px 0 4px;font-size:1.6rem}.view-intro{margin:0 0 18px;max-width:70ch;line-height:1.55}.view-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px;align-items:start}.view-grid>.card{margin:0;min-width:0}.view-header{display:flex;justify-content:space-between;align-items:end;gap:18px;margin-bottom:16px}.view-header h2{margin:0}.subnav{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 16px}.subnav button{background:#191a25;border:1px solid #333546;color:#c7c8d4;margin:0;min-height:44px}.subnav button[aria-current=page]{background:#302344;border-color:#684aa1;color:#fff}.subpage{display:none}.subpage[data-active=true]{display:block}.subpage>.view-grid{margin:0}.dashboard-top{position:sticky;top:0;z-index:7;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 22px;margin:-28px -20px 20px;background:#11131bf2;border-bottom:1px solid #292b39;backdrop-filter:blur(14px)}.dashboard-top h1{font-size:1.1rem;margin:0}.dashboard-top #who{font-size:.82rem;margin:3px 0 0}.overview-status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.status-tile{background:#1b1d29;border:1px solid #303342;border-radius:13px;padding:14px}.status-tile strong{display:block;margin-bottom:6px}.status-tile span{color:#c9cbd6}.quick-actions{display:flex;gap:9px;flex-wrap:wrap}.quick-actions button,.streamer-entry,.portal-entry{min-height:44px}.streamer-entry,.portal-entry{display:inline-flex;align-items:center;justify-content:center;padding:9px 12px;border-radius:9px;background:#302344;border:1px solid #684aa1;color:#f3edff;text-decoration:none;white-space:nowrap}.warning-list{display:grid;gap:8px}.warning-item{padding:10px 12px;border:1px solid #5d4933;background:#282117;border-radius:10px;color:#f2d5ac}.legacy-source{display:none!important}.main-nav button,.main-nav a{font-size:.97rem}body{background:radial-gradient(ellipse at 82% -8%,#30234a 0,transparent 28%),#101116}main{max-width:1480px;margin:0 0 0 226px;padding:28px 32px}#notice{position:fixed;right:20px;bottom:18px;z-index:20;padding:10px 14px;border-radius:10px;background:#262034}#notice:empty{display:none}button:disabled{opacity:.48;cursor:not-allowed}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #d3b7ff;outline-offset:2px}#diagnostics{margin-top:14px}.diagnostic-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 18px}#game-catalog[hidden]{display:none!important}.catalog-card{cursor:pointer;transition:transform .15s,border-color .15s}.catalog-card:hover{transform:translateY(-2px);border-color:#8c69ca}.catalog-card h3{margin:0 0 5px;color:#eee6ff}.catalog-card p{margin:0}.game-subnav{display:none!important;overflow:auto;flex-wrap:nowrap;padding-bottom:6px}.game-subnav button{white-space:nowrap}.subpage-guide{display:flex;align-items:center;gap:10px;margin:0 0 12px}.subpage-guide p{margin:0;flex:1}.subpage-back{background:#191a25;border:1px solid #393d4d;color:#e5e3ee;margin:0;min-height:44px}@media(max-width:860px){.main-nav{position:sticky;top:0;inset:auto;width:auto;height:auto;padding:8px 10px;margin:-18px -12px 16px;flex-direction:row;overflow-x:auto;background:#11131bf5;border-right:0;border-bottom:1px solid #292b39}.main-nav button,.main-nav a{flex:1 1 0;min-width:0;flex-direction:column;gap:3px;justify-content:center;padding:8px 2px;font-size:.78rem;white-space:normal;text-align:center;line-height:1.15}.dash-layout{margin-left:0;min-height:0}main{margin:0;padding:18px 12px}.dashboard-top{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;gap:8px;margin:-18px -12px 16px;padding:12px}.dashboard-top>div{grid-column:1;grid-row:1;min-width:0}.dashboard-top>#logout{grid-column:2;grid-row:1}.dashboard-top .streamer-entry{grid-column:1;grid-row:2}.dashboard-top .portal-entry{grid-column:2;grid-row:2}.dashboard-top .streamer-entry,.dashboard-top .portal-entry{flex:initial;min-width:0;padding:8px;font-size:.88rem}.overview-status{grid-template-columns:repeat(2,minmax(0,1fr))}.view-header{align-items:start;flex-direction:column}.mobile-nav-label{display:inline}.subnav{overflow-x:auto;flex-wrap:nowrap;padding-bottom:6px}.subnav button{flex:0 0 auto}.view-grid{grid-template-columns:minmax(0,1fr)}.dashboard-view,.subpage,.view-grid,.card{min-width:0;max-width:100%}}@media(max-width:380px){.main-nav button,.main-nav a{font-size:.74rem;padding:7px 1px}.overview-status{gap:7px}.status-tile{padding:11px}.dashboard-top{margin-left:-12px;margin-right:-12px}.card{padding:15px}}`;
const DASHBOARD_SIMPLICITY_STYLE = `.obs-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0;list-style:none}.obs-steps li{padding:10px;background:#191a25;border:1px solid #393d4d;border-radius:10px}.obs-preview-shell{max-width:640px}.obs-preview-shell>.preview-widget{min-height:92px;display:grid;place-content:center;text-align:center}.obs-preview-shell>p{margin:.4rem 0 1rem}.obs-wizard section{margin:18px 0;padding-top:4px}.setup-checklist{display:grid;gap:8px}.setup-check-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px 12px;background:#191a25;border:1px solid #333546;border-radius:10px}.setup-check-row p{margin:3px 0 0;color:#aeb2c3;font-size:.9rem}.setup-check-row button{margin:0;min-height:40px;padding:8px 12px}.quest-flow{display:grid;gap:14px;margin:14px 0}.quest-flow>section{padding-top:10px;border-top:1px solid #343645}.quest-flow h3{margin:.2rem 0 .6rem}.quest-list{display:grid;gap:8px}.quest-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:11px;background:#191a25;border:1px solid #363847;border-radius:10px}.quest-row strong{flex:1 1 100%}.quest-row p{flex:1 1 100%;margin:0}.quest-row button{margin:0}.obs-wizard details{margin-top:12px}.quest-flow-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;padding:0;margin:0 0 16px;list-style:none}.quest-flow-steps li{display:flex;flex-direction:column;gap:4px;padding:12px;background:#211c30;border:1px solid #403454;border-radius:10px}.quest-flow-steps span{color:#b9bbca;font-size:.9rem}@media(max-width:620px){.quest-flow-steps{grid-template-columns:1fr}}@media(max-width:620px){.obs-steps{grid-template-columns:1fr}.setup-check-row{grid-template-columns:minmax(0,1fr)}.setup-check-row button{justify-self:start}.quest-row button{flex:1 1 auto}}`;
const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#11131b"><meta name="csrf" content="__CSRF__"><title>Community Bot · Admin</title><style nonce="__NONCE__">
:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#11131b;color:#eef0f8}body{margin:0;background:radial-gradient(ellipse at top right,#30234a 0,transparent 35%),#11131b}main{max-width:1100px;margin:auto;padding:28px 20px}h1{margin:0 0 8px}p{color:#aeb2c3}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:20px 0}.card{background:#1b1e29;border:1px solid #333746;border-radius:14px;padding:18px}.accent{color:#c0a0ff}input,select,textarea,button{font:inherit;color:inherit;background:#10121a;border:1px solid #44495d;border-radius:8px;padding:10px;max-width:100%;box-sizing:border-box}textarea{width:100%;min-height:70px}button{background:#7652bd;border:0;cursor:pointer;margin:4px 2px}button:hover{background:#8d6bd1}label{display:block;margin:9px 0;color:#c7cad6}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#cbd0e0}form{display:grid;gap:8px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.muted{color:#979caf;font-size:.9rem}#notice{min-height:1.4rem;color:#ffc987}.preview-widget{margin:12px 0;padding:14px;border:1px solid #b69cff;border-left:5px solid #b69cff;border-radius:12px;background:linear-gradient(130deg,rgba(19,22,32,.96),rgba(42,34,57,.9));overflow-wrap:anywhere}.preview-widget p{margin:8px 0;color:#eef0f8}.preview-widget small{color:#b6b8c6}@media(max-width:520px){main{padding:18px 12px}.card{padding:14px}}
</style></head><body><main><div class="row"><div><h1>Community Bot <span class="accent">Verwaltung</span></h1><p id="who">Geschützte Verwaltung</p></div><button id="logout">Abmelden</button></div><p id="notice" role="status"></p><p class="muted">Hier steuerst du Chatspiele und Stream-Anzeigen. Fast alles ist optional – starte nur, was du wirklich nutzen möchtest.</p><section class="grid"><article class="card"><h2>Bot-Status</h2><pre id="overview">Lade Status …</pre></article><article class="card"><h2>Funktionen ein- und ausschalten</h2><div id="modules"></div></article><article class="card"><h2>Saison-Event</h2><div id="events"></div><details><summary>Eigenes Event anlegen (optional)</summary><form id="event-form"><input name="id" placeholder="Kurze Kennung, z. B. summer" required pattern="[a-z0-9_-]{2,40}"><input name="name" placeholder="Anzeigename" required><input name="emoji" placeholder="Symbol" value="✨"><input name="command" placeholder="Chatbefehl ohne !, z. B. summerhunt" required><input name="currency" placeholder="Punkte-Wort" required><label>Wartezeit zwischen Auslösungen (Sekunden)<input name="cooldownSeconds" type="number" min="0" max="86400" step="1" value="900" required></label><button>Event speichern</button></form></details></article><article class="card"><h2>XP korrigieren (nur bei Bedarf)</h2><form id="xp-form"><input name="userId" type="hidden" required><p id="xp-user-selected" class="muted">Wähle zuerst im Bereich „Zuschauer suchen“ ein Twitch-Konto aus.</p><label>XP-Korrektur (positiv oder negativ)<input name="amount" type="number" step="1" required></label><label>Grund für die Änderung<input name="reason" required maxlength="200"></label><button type="submit" disabled>XP-Korrektur speichern</button></form><p class="muted">Nur für Korrekturen. Änderungen werden protokolliert.</p></article><article class="card"><h2>Eigene Chatbefehle (optional)</h2><pre id="commands"></pre><form id="command-form"><input name="name" placeholder="Befehlsname ohne !" required><textarea name="response" placeholder="Was soll der Bot antworten? Platzhalter: {user}, {channel}, {game}, {uptime}" required></textarea><select name="permission"><option value="everyone">Dürfen alle nutzen</option><option value="moderator">Nur Moderatoren</option><option value="broadcaster">Nur Jannik</option></select><label>Wartezeit zwischen Aufrufen (Sekunden)<input name="cooldownSeconds" type="number" min="0" max="86400" step="1" value="10" required></label><button>Befehl speichern</button></form></article><article class="card"><h2>Zuschauer suchen</h2><p class="muted">Suche nach Twitch-Namen und wähle das passende Konto für eine XP-Korrektur aus.</p><form id="users-form"><label>Twitch-Name<input name="q" placeholder="z. B. Zuschauername" required></label><button type="submit">Twitch-Konto suchen</button></form><div id="users" aria-live="polite"></div></article></section></main><script nonce="__NONCE__">
const csrf=document.querySelector('meta[name=csrf]').content,notice=document.querySelector('#notice');async function api(path,method='GET',data){const r=await fetch('/dashboard/api/'+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(data?{body:JSON.stringify(data)}:{})});const d=await r.json().catch(()=>({error:'Ungültige Serverantwort'}));if(!r.ok)throw Error(d.error||'Anfrage fehlgeschlagen');return d}function show(text){notice.textContent=text;setTimeout(()=>notice.textContent='',5000)}async function refresh(){try{const d=await api('overview');document.querySelector('#who').textContent='Angemeldet als '+d.admin.login;document.querySelector('#overview').textContent=JSON.stringify(d.status,null,2);const mods=document.querySelector('#modules');mods.replaceChildren();for(const [key,on] of Object.entries(d.status.modules||{})){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=Boolean(on);box.addEventListener('change',async()=>{try{await api('modules','POST',{key,enabled:box.checked});show('Modul gespeichert.')}catch(e){box.checked=!box.checked;show(e.message)}});label.append(box,' '+key);mods.append(label)}const ev=await api('events');const box=document.querySelector('#events');box.replaceChildren();for(const event of ev.events){const line=document.createElement('div'),text=document.createElement('span');text.textContent=event.emoji+' '+event.name+' · '+(event.active?'aktiv':'inaktiv')+' ';line.append(text);const b=document.createElement('button');b.textContent=event.active?'Beenden':'Starten';b.onclick=async()=>{try{await api('events','POST',{id:event.id,active:!event.active});show('Eventstatus gespeichert.');refresh()}catch(e){show(e.message)}};line.append(b);box.append(line)}const c=await api('commands');document.querySelector('#commands').textContent=JSON.stringify(c.commands,null,2)}catch(e){show(e.message)}}document.querySelector('#event-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownSeconds)*1000;delete v.cooldownSeconds;try{await api('events','POST',v);show('Event gespeichert.');e.currentTarget.reset();refresh()}catch(x){show(x.message)}};document.querySelector('#xp-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.amount=Number(v.amount);try{await api('xp-adjust','POST',v);show('XP-Korrektur protokolliert.');e.currentTarget.reset()}catch(x){show(x.message)}};document.querySelector('#command-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownSeconds)*1000;delete v.cooldownSeconds;try{await api('commands','POST',v);show('Chatbefehl gespeichert.');refresh()}catch(x){show(x.message)}};document.querySelector('#users-form').onsubmit=async e=>{e.preventDefault();const v=new FormData(e.currentTarget);try{const u=await api('users?q='+encodeURIComponent(v.get('q')||'')),root=document.querySelector('#users');root.replaceChildren();if(!u.users.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Kein gespeichertes Twitch-Konto gefunden.';root.append(empty)}for(const user of u.users){const row=document.createElement('p'),label=document.createElement('span'),select=document.createElement('button');label.textContent=user.displayName+' · '+user.xp+' XP ';select.type='button';select.textContent='Für Korrektur auswählen';select.onclick=()=>{document.querySelector('#xp-form [name=userId]').value=user.userId;document.querySelector('#xp-user-selected').textContent='Ausgewählt: '+user.displayName+' · aktueller Stand '+user.xp+' XP';document.querySelector('#xp-form button[type=submit]').disabled=false};row.append(label,select);root.append(row)}}catch(x){show(x.message)}};document.querySelector('#logout').onclick=async()=>{try{await api('logout','POST',{});location.reload()}catch(e){show(e.message)}};refresh();setInterval(refresh,15000);
</script></body></html>`;

const SETTINGS_CARD = `<article class="card"><h2>Community-Boss</h2><p class="muted">Starte einen gemeinsamen Bosskampf, den der Chat mit Angriffsbefehlen bestreitet.</p><form id="boss-form"><input name="name" placeholder="Bossname" value="Schattenkönig"><label>Start-Lebenspunkte <input name="hp" type="number" min="1" value="1000"></label><label>Spieldauer (Minuten) <input name="durationMinutes" type="number" min="1" max="1440" value="15" required></label><button>Bosskampf starten</button></form><button id="boss-end">Bosskampf beenden</button></article><article class="card"><details><summary>Technische Grundeinstellungen (nur bei Bedarf)</summary><p class="muted">Diese Roh-Einstellungen sind für fortgeschrittene Wartung. Für den normalen Betrieb musst du hier nichts ändern.</p><form id="settings-form"><textarea id="settings-json" rows="14" spellcheck="false" aria-label="Technische Bot-Einstellungen"></textarea><button>Einstellungen speichern</button></form></details></article><article class="card"><details><summary>Erweiterte Befehlsverwaltung</summary><div id="command-manager"></div></details></article>`;
const WELCOME_CARD = `<article class="card"><h2>Begrüßung neuer Chatter</h2><p class="muted">Optional, standardmäßig aus. Gespeichert wird nur die Twitch-ID mit erstem Begrüßungszeitpunkt, kein Chattext.</p><label><input id="welcome-enabled" type="checkbox"> Einmalige Begrüßung aktivieren</label><input id="welcome-message" maxlength="500" aria-label="Begrüßungstext"><p class="muted">Platzhalter: {user}</p><button id="welcome-save">Begrüßung speichern</button></article>`;
const WELCOME_SCRIPT = `async function loadWelcome(){try{const s=await api('welcome');document.querySelector('#welcome-enabled').checked=s.enabled;document.querySelector('#welcome-message').value=s.message}catch(e){show(e.message)}}document.querySelector('#welcome-save').onclick=async()=>{try{await api('welcome','POST',{enabled:document.querySelector('#welcome-enabled').checked,message:document.querySelector('#welcome-message').value});show('Begrüßung gespeichert.');loadWelcome()}catch(e){show(e.message)}};loadWelcome();`;
const OBS_CARD = `<article class="card obs-wizard"><h2>OBS-Einrichtung</h2><p class="muted">In wenigen Schritten von der Auswahl bis zur Browserquelle. Ein neuer Link ersetzt den bisherigen Link dieses Widgets.</p><ol class="obs-steps"><li><strong>Anzeige wählen</strong></li><li><strong>Link erstellen und prüfen</strong></li><li><strong>In OBS einfügen</strong></li></ol><section aria-labelledby="obs-choice-title"><h3 id="obs-choice-title">1. Was möchtest du im Stream zeigen?</h3><label for="obs-type">Stream-Anzeige</label><select id="obs-type"><option value="imposter">Chat-Imposter</option><option value="detective">Chat-Detektiv</option><option value="poll">Abstimmungen</option><option value="quest">Aktuelle Community-Aufgabe</option><option value="pet">Elio</option><option value="drop">Mystery Drop</option><option value="wheel">Chaos Wheel</option><option value="vault">Community-Tresor</option></select><p id="obs-description" class="muted"></p><div class="obs-preview-shell"><div id="obs-preview" class="preview-widget" aria-label="Unverbindliche Beispielvorschau"></div><p class="muted">Beispielvorschau – keine Live-Daten und keine Zuschaueraktionen.</p></div><p id="obs-size" class="phase-box"></p><p id="obs-link-status" class="phase-box" role="status">Gespeicherter Link wird geprüft …</p></section><section aria-labelledby="obs-link-title"><h3 id="obs-link-title">2. Geschützten Widget-Link vorbereiten</h3><p>Der Link ist wie ein Passwort. Ein neuer Link macht einen eventuell vorhandenen Link ungültig.</p><button id="obs-create" type="button">Link erstellen oder erneuern</button><div id="obs-result" role="status" aria-live="polite"></div><button id="obs-test" type="button" disabled>Link technisch testen</button><p id="obs-test-status" class="muted" role="status" aria-live="polite">Der Test prüft nur, ob die Widget-Seite erreichbar ist. Er kann OBS selbst nicht prüfen.</p></section><section aria-labelledby="obs-install-title"><h3 id="obs-install-title">3. Anzeige in OBS einfügen</h3><ol><li>OBS öffnen und in der gewünschten Szene bei „Quellen“ auf <strong>+</strong> klicken.</li><li><strong>Browser</strong> auswählen und einen Namen vergeben, zum Beispiel „ACY Community“.</li><li>Den oben erstellten Link in das URL-Feld kopieren.</li><li>Die empfohlene Breite und Höhe übernehmen und mit „OK“ bestätigen.</li></ol><p id="obs-install-hint" class="muted">Du kannst mehrere Anzeigen in derselben Szene platzieren. Eine kombinierte Browserquelle ist derzeit nicht eingerichtet.</p></section><details><summary>Vorhandenen Widget-Link verwalten</summary><p>Widerrufen schaltet die Browserquelle ab, die diesen Link verwendet.</p><button id="obs-revoke" class="danger" type="button">Link widerrufen</button></details></article>`;
const OBS_SCRIPT = `(()=>{const info={imposter:['Phase und Countdown der geheimen Rollenrunde.','1200 × 700','Oben rechts oder links, gut sichtbar über dem Spiel.','🎭 Chat-Imposter · Runde wird vorbereitet'],detective:['Zitat, Countdown und Auflösung – Namen bleiben bis zum Ende verborgen.','1000 × 520','Oben oder unten am Rand des Spiels.','🕵️ Chat-Detektiv · Wer hat das gesagt?'],poll:['Frage, Antwortmöglichkeiten und aktueller Abstimmungsstand.','900 × 420','Oben mittig oder neben dem Spiel.','📊 Community-Abstimmung · Deine Stimme zählt'],quest:['Die gerade aktive Community-Aufgabe.','900 × 320','Unten links oder rechts, ohne wichtige Spielelemente zu verdecken.','📜 Community-Aufgabe · Gemeinsam schaffen wir das'],pet:['Elios gemeinsamer Zustand und seine Entwicklung.','500 × 600','In einer freien Ecke der Szene.','🐱 Elio · Die Community passt auf mich auf'],drop:['Teilnahme und Ergebnis eines Mystery Drops.','900 × 400','Oben mittig, wenn ein Drop läuft.','🎁 Mystery Drop · Mit !claim teilnehmen'],wheel:['Status und Ergebnis des Chaos Wheels.','1000 × 600','Mittig, solange die Animation läuft.','🎡 Chaos Wheel · Die Community entscheidet'],vault:['Restzeit, Versuche und öffentliche Hinweise. Der Geheimcode bleibt verborgen.','900 × 440','Oben mittig, wenn der Tresor läuft.','🔐 Community-Tresor · Knackt gemeinsam den Code']};const type=document.querySelector('#obs-type'),status=document.querySelector('#obs-link-status'),preview=document.querySelector('#obs-preview'),size=document.querySelector('#obs-size'),test=document.querySelector('#obs-test'),testStatus=document.querySelector('#obs-test-status');let configured={},generatedUrl='';function render(){const [description,dimensions,position,sample]=info[type.value];document.querySelector('#obs-description').textContent=description;size.textContent='Empfohlene Größe: '+dimensions+' Pixel. Position: '+position;preview.textContent=sample;test.disabled=!generatedUrl}async function loadStatus(){try{const d=await api('widgets/status');configured=d.widgets||{};status.textContent=configured[type.value]?'✅ Ein Widget-Link ist aktiv.':'Noch kein Widget-Link eingerichtet.'}catch{status.textContent='Linkstatus ist gerade nicht prüfbar. Erstelle vorsichtshalber keinen Ersatz-Link.'}}type.addEventListener('change',()=>{generatedUrl='';document.querySelector('#obs-result').replaceChildren();testStatus.textContent='Erstelle erst einen Link für diese Anzeige.';render();loadStatus()});render();loadStatus();document.querySelector('#obs-create').onclick=async()=>{if(configured[type.value]&&!confirm('Für diese Anzeige besteht bereits ein Link. Er wird durch den neuen Link sofort ungültig. Fortfahren?'))return;try{const d=await api('widgets/token','POST',{type:type.value,action:'rotate'}),url=new URL(d.url,location.origin);if(url.origin!==location.origin||!url.pathname.startsWith('/widgets/'))throw Error('Der Link ist ungültig und wurde nicht angezeigt.');generatedUrl=url.href;const out=document.querySelector('#obs-result');out.replaceChildren();const field=document.createElement('input');field.readOnly=true;field.value=generatedUrl;field.setAttribute('aria-label','Privater OBS-Widget-Link');field.autocomplete='off';field.style.width='100%';const copy=document.createElement('button');copy.type='button';copy.textContent='Link kopieren';copy.onclick=async()=>{try{await navigator.clipboard.writeText(generatedUrl);show('Widget-Link kopiert.')}catch{field.select();show('Link markieren und manuell kopieren.')}};out.append(field,copy,document.createTextNode(' Diesen Link vertraulich behandeln.'));test.disabled=false;testStatus.textContent='Link bereit. Prüfe die Erreichbarkeit vor dem Einfügen in OBS.';show('Widget-Link erstellt.');await loadStatus()}catch(e){show(e.message)}};test.onclick=async()=>{if(!generatedUrl)return;test.disabled=true;testStatus.textContent='Widget wird geprüft …';try{const r=await fetch(generatedUrl,{method:'GET',cache:'no-store',credentials:'same-origin',redirect:'error'}),contentType=r.headers.get('content-type')||'';if(!r.ok||!contentType.includes('text/html'))throw Error('Die Widget-Seite wurde nicht erfolgreich geladen.');testStatus.textContent='✅ Die Widget-Seite ist erreichbar. OBS-Sichtbarkeit ist damit noch nicht bestätigt.'}catch{testStatus.textContent='❌ Die Widget-Seite konnte nicht bestätigt werden. Prüfe Verbindung und Link.'}finally{test.disabled=false}};document.querySelector('#obs-revoke').onclick=async()=>{if(!confirm('Diesen Widget-Link widerrufen? Die passende Browserquelle in OBS funktioniert danach nicht mehr.'))return;try{await api('widgets/token','POST',{type:type.value,action:'revoke'});generatedUrl='';document.querySelector('#obs-result').replaceChildren();test.disabled=true;testStatus.textContent='Link widerrufen.';show('Widget-Link widerrufen.');await loadStatus()}catch(e){show(e.message)}}})();`;
const DASHBOARD_WORDING_SCRIPT = `(()=>{const labels={xp:'XP und Level',events:'Saison-Events',eightBall:'8-Ball',rps:'Schere, Stein, Papier',guess:'Ratespiel',duels:'Duell-Spiel',boss:'Community-Boss',customCommands:'Eigene Chatbefehle',quests:'Community-Aufgaben',polls:'Umfragen'};function tidy(){const overview=document.querySelector('#overview');try{const d=JSON.parse(overview.textContent);overview.textContent='Twitch-Verbindung: '+(d.twitchConnected?'verbunden':'wird geprüft')+'\\nKanal: '+(d.channel||'—')+'\\nBot gestartet: '+(d.startedAt?new Date(d.startedAt).toLocaleString():'—')+(d.lastError?'\\nLetzter Hinweis: '+d.lastError:'')}catch{}for(const label of document.querySelectorAll('#modules label')){const input=label.querySelector('input'),name=label.lastChild?.textContent?.trim();if(input&&labels[name])label.lastChild.textContent=' '+labels[name]}for(const id of ['commands','users']){const node=document.querySelector('#'+id);try{const d=JSON.parse(node.textContent);if(id==='commands'&&Array.isArray(d.commands))node.textContent=d.commands.map(x=>'!'+x.name+' — '+x.response).join('\\n')||'Noch keine eigenen Chatbefehle angelegt.';else if(id==='users'&&Array.isArray(d.users))node.textContent=d.users.map(x=>(x.displayName||x.login)+' · '+x.xp+' XP').join('\\n')||'Keine Zuschauer gefunden.'}catch{}}}const observer=new MutationObserver(tidy);observer.observe(document.querySelector('main'),{childList:true,subtree:true});tidy()})();`;
const DASHBOARD_STRUCTURE_SCRIPT = `(()=>{const groups={uebersicht:document.querySelector('#diagnostic-content'),spiele:document.querySelector('#dashboard-games'),community:document.querySelector('#dashboard-community'),obs:document.querySelector('#dashboard-obs'),befehle:document.querySelector('#settings-commands'),allgemein:document.querySelector('#settings-general'),funktionen:document.querySelector('#settings-functions'),integrationen:document.querySelector('#settings-integrations'),verwaltung:document.querySelector('#settings-moderation'),diagnose:document.querySelector('#settings-diagnostics')};const byTitle=t=>Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()===t);const move=(t,g)=>{const c=byTitle(t);if(c&&g)g.append(c)};move('Bot-Status',groups.diagnose);move('Funktionen ein- und ausschalten',groups.funktionen);move('Saison-Event',groups.community);move('XP korrigieren (nur bei Bedarf)',groups.verwaltung);move('Eigene Chatbefehle (optional)',groups.befehle);move('Zuschauer suchen',groups.verwaltung);move('Begrüßung neuer Chatter',groups.community);move('Community-Quests und Umfragen',groups.community);move('Quest-Abstimmung',groups.community);move('Live-Abstimmungen',groups.community);move('Chat-Ideen',groups.community);move('Chat-Imposter & Chat-Detektiv',groups.spiele);move('Pet, Überraschung und Glücksrad',groups.spiele);move('OBS: Widgets für den Stream',groups.obs);move('Kanalpunkte',groups.integrationen);move('Community-Boss',groups.spiele);})();`;
const DASHBOARD_STATUS_SCRIPT = `(()=>{const root=document.querySelector('#dashboard-overview'),card=Array.from(document.querySelectorAll('.card')).find(x=>x.querySelector('h2')?.textContent==='Bot-Status');if(!root||!card)return;const panel=document.createElement('div');panel.className='phase-box';root.append(panel);async function update(){try{const s=await api('status'),label=v=>v==='connected'?'Verbunden':v==='disconnected'?'Nicht verbunden':v===true?'Verbindung offen':v===false?'Getrennt':'Nicht separat geprüft';panel.replaceChildren();for(const [name,value] of [['Dashboard/Bot-Dienst antwortet',s.dashboardResponding?'Ja':'Nein'],['EventSub-WebSocket',label(s.eventSubSocket)],['Eingehender Chat / Befehle',label(s.chatReceive)],['Bot darf Chat senden',label(s.botChatSend)],['Broadcaster-Anmeldung für Kanalpunkte',label(s.broadcasterOAuth)]]){const line=document.createElement('p');line.textContent=name+': '+value;panel.append(line)}if(s.lastError){const err=document.createElement('p');err.textContent='Letzter Fehler: '+s.lastError;panel.append(err)}const note=document.createElement('p');note.textContent='Ein offener WebSocket beweist noch nicht, dass Chat-Ereignisse ankommen. Unbekannte Werte werden nicht als „funktioniert“ angezeigt.';panel.append(note)}catch{panel.textContent='Status konnte gerade nicht geladen werden.'}}update();setInterval(update,15000)})();`;
const DASHBOARD_CLEANUP_SCRIPT = `(()=>{const groups=document.querySelector('#dashboard-obs');const duplicate=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()==='OBS-Widgets');if(duplicate&&groups)groups.append(duplicate);for(const h of document.querySelectorAll('main>h2'))if(['Community-Aktionen','Im Stream anzeigen','Erweiterte Einstellungen'].includes(h.textContent.trim())){h.hidden=true;if(h.nextElementSibling)h.nextElementSibling.hidden=true;if(h.nextElementSibling?.nextElementSibling)h.nextElementSibling.nextElementSibling.hidden=true}for(const s of document.querySelectorAll('main>section.grid'))if(!s.querySelector('.card'))s.hidden=true})();`;
const DASHBOARD_REMAINDER_SCRIPT = `(()=>{const settings=document.querySelector('[data-setting-page=\"diagnostics\"] .view-grid'),commands=document.querySelector('#settings-commands'),obs=document.querySelector('#dashboard-obs');for(const [node,target] of [[document.querySelector('#settings-form'),settings],[document.querySelector('#command-manager'),commands]]){const card=node?.closest('.card');if(card&&target)target.append(card)}for(const title of ['Quests über Twitch-Kanalpunkte']){const card=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()===title);const integrations=document.querySelector('[data-setting-page="integrations"] .view-grid');if(card&&integrations)integrations.append(card)}const preview=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()==='Overlay-Vorschau');if(preview&&obs)obs.append(preview);for(const section of document.querySelectorAll('main>section.grid'))if(!section.querySelector('.card'))section.hidden=true})();`;
const DASHBOARD_OBS_GUARD_SCRIPT = `document.querySelectorAll('.widget-rotate').forEach(b=>b.onclick=async()=>{if(!confirm('Neuen Link für '+b.dataset.widget+' erstellen? Der bisherige Link und die damit eingerichtete OBS-Quelle werden sofort ungültig.'))return;try{const d=await api('widgets/token','POST',{type:b.dataset.widget,action:'rotate'});document.querySelector('#widget-url').value=d.url;show('Neuer OBS-Link erstellt; die OBS-Quelle muss aktualisiert werden.')}catch(e){show(e.message)}});document.querySelectorAll('.widget-revoke').forEach(b=>b.onclick=async()=>{if(!confirm('Widget-Link widerrufen? Die bisherige OBS-Quelle funktioniert dann nicht mehr.'))return;try{await api('widgets/token','POST',{type:b.dataset.widget,action:'revoke'});document.querySelector('#widget-url').value='';show('OBS-Link widerrufen.')}catch(e){show(e.message)}});`;
const DASHBOARD_GUIDES_SCRIPT = `(()=>{const guides={'Community-Quests und Umfragen':'Was ist das? Zuschauer schlagen Aufgaben vor; du prüfst sie und startest eine Quest selbst. Für eine Chat-Umfrage gibst du Frage und Antworten ein. Zuschauer wählen mit !vote 1, !vote 2 usw. Das Ergebnis startet nichts automatisch. Du musst Questvorschläge freigeben und eine Quest manuell starten oder abschließen. Das Quest-/Umfrage-Widget zeigt den aktiven Stand.','Quest-Abstimmung':'Wähle freigegebene Aufgaben aus und starte die Abstimmung. Zuschauer stimmen mit !vote ab. Nach Ende siehst du das Ergebnis; die Gewinner-Quest wird nur nach deiner Bestätigung gestartet. OBS zeigt Frage und Stimmen.','Chat-Umfrage':'Frage und 2–5 Antworten eingeben und Umfrage starten. Zuschauer stimmen mit !vote Nummer ab. Die Umfrage endet nach dem Timer; du entscheidest danach, was passiert. Das Umfrage-Widget zeigt Stimmen und Ergebnis.','Chat-Ideen':'Der Bot erkennt vorübergehend Themen im öffentlichen Kanalchat und zeigt passende Fragen oder bestehende Aktionen zur Prüfung an. Nur freigegebene Fragen können in den Chat. Chattexte werden nicht gespeichert; private Nachrichten werden nicht ausgewertet.','Pet, Überraschung und Glücksrad':'Community-Pet: Zuschauer können das Pet mit Chatbefehlen gemeinsam entwickeln. Mystery Drop: du startest ihn hier oder das Glücksrad startet ihn automatisch; Zuschauer nehmen mit !claim teil und der Bot verteilt XP nach Ablauf. Chaos Wheel: manuelle Challenge heißt Aufgabe für dich; automatische Felder führen eine Bot-Aktion aus. Aktiviere die Funktionen erst, wenn du sie verwenden möchtest. OBS kann Pet, Drop und Wheel jeweils anzeigen.','Begrüßung neuer Chatter':'Optional: Der Bot begrüßt einen Chatter einmalig, wenn er zum ersten Mal im Kanal schreibt. Hier legst du Text und Platzhalter {user} fest. Die Begrüßung sendet der Bot automatisch; hier musst du danach nichts tun.'};for(const c of document.querySelectorAll('.card')){const h=c.querySelector('h2'),text=h&&guides[h.textContent.trim()];if(!text||c.querySelector('details[data-simple-guide]'))continue;const d=document.createElement('details');d.dataset.simpleGuide='true';const s=document.createElement('summary');s.textContent='Einfach erklärt';const p=document.createElement('p');p.textContent=text;d.append(s,p);c.insertBefore(d,c.children[1]||null)}})();`;
const DASHBOARD_STATUS_SAFE_SCRIPT = `(()=>{const root=document.querySelector('#dashboard-overview'),raw=document.querySelector('#overview');if(raw)raw.hidden=true;const panel=document.createElement('div');panel.className='phase-box';root.append(panel);async function update(){try{const s=await api('status'),label=v=>v==='connected'?'Verbunden':v===true?'Verbindung offen':v===false?'Getrennt':'Nicht separat geprüft';panel.replaceChildren();for(const [name,value] of [['Bot-Dashboard antwortet',s.dashboardResponding?'Ja':'Nein'],['Twitch-Kanal',s.channel||'Nicht bekannt'],['EventSub-Verbindung',label(s.eventSubSocket)],['Chat-Empfang / Befehle',label(s.chatReceive)],['Chat-Nachrichten senden',label(s.botChatSend)],['Kanalpunkte-Twitch-Verbindung',label(s.broadcasterOAuth)]]){const p=document.createElement('p');p.textContent=name+': '+value;panel.append(p)}if(s.errorPresent){const p=document.createElement('p');p.textContent='Technischer Hinweis vorhanden; bitte vor Livebetrieb prüfen.';panel.append(p)}const p=document.createElement('p');p.textContent='Eine offene EventSub-Verbindung allein belegt noch keinen eingehenden Chatempfang.';panel.append(p)}catch{panel.textContent='Status konnte gerade nicht geladen werden.'}}update();setInterval(update,15000)})();`;
const CHAT_RESPONSE_SCRIPT = `(()=>{const root=document.querySelector('#chat-response-settings');if(!root)return;api('chat-messages').then(s=>{root.replaceChildren();const form=document.createElement('form'),title=document.createElement('h3');title.textContent='Wie oft soll der Bot schreiben?';const select=document.createElement('select');select.name='profile';for(const [value,label] of [['calm','Ruhig'],['normal','Normal (empfohlen)'],['lively','Lebhaft']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option)}select.value=s.profile;const help=document.createElement('p');help.className='muted';help.textContent='Das Profil steuert Chat-Antworten und die vorsichtige Tipp-Häufigkeit gemeinsam. Wichtige Spielereignisse bleiben sichtbar.';const tipLabel=document.createElement('label'),tipToggle=document.createElement('input');tipToggle.type='checkbox';tipToggle.checked=Boolean(s.communityTips?.enabled);tipLabel.append(tipToggle,' Community-Tipps aktivieren');const portalLabel=document.createElement('label'),portalToggle=document.createElement('input');portalToggle.type='checkbox';portalToggle.checked=Boolean(s.communityTips?.portalEnabled);portalLabel.append(portalToggle,' Community-Portal gelegentlich im Chat vorstellen');const portalHelp=document.createElement('p');portalHelp.className='muted';portalHelp.textContent='Nur bei aktiver Chat-Unterhaltung und bestätigter Portal-Erreichbarkeit. Es gelten Profil, Tippabstand und Nachrichtenlimit.';const halloween=document.createElement('section'),hTitle=document.createElement('h3');hTitle.textContent='🎃 Halloween-Event bewerben';const hToggleLabel=document.createElement('label'),hToggle=document.createElement('input');hToggle.type='checkbox';hToggle.checked=s.communityTips?.halloweenEnabled!==false;hToggleLabel.append(hToggle,' Halloween-Erinnerungen aktivieren');const hFrequencyLabel=document.createElement('label');hFrequencyLabel.textContent='Häufigkeit';const hFrequency=document.createElement('select');for(const [value,label] of [['normal','Normal · frühestens alle 45 Minuten'],['frequent','Häufiger · frühestens alle 30 Minuten']]){const option=document.createElement('option');option.value=value;option.textContent=label;hFrequency.append(option)}hFrequency.value=s.communityTips?.halloweenFrequency||'frequent';hFrequencyLabel.append(hFrequency);const hHelp=document.createElement('p');hHelp.className='muted';hHelp.textContent='Der Bot wartet auf echten Chatverkehr, mindestens 20 Minuten Abstand und höchstens zwei Halloween-Hinweise pro Stunde. Chatprofil und allgemeines Nachrichtenlimit können die nächste Erinnerung weiter verschieben.';const hStatus=document.createElement('p'),hLast=document.createElement('p'),hNext=document.createElement('p'),hPreviewTitle=document.createElement('strong'),hPreview=document.createElement('div');for(const p of [hStatus,hLast,hNext])p.className='muted';hPreviewTitle.textContent='Nachrichten-Vorschau';halloween.append(hTitle,hToggleLabel,hFrequencyLabel,hHelp,hStatus,hLast,hNext,hPreviewTitle,hPreview);const tipInfo=document.createElement('p');tipInfo.className='muted';const preview=document.createElement('p');preview.className='muted';const names=document.createElement('textarea');names.rows=3;names.value=(s.welcomeBots||[]).join(', ');names.setAttribute('aria-label','Bots von Begrüßungen ausschließen');const label=document.createElement('label');label.textContent='Bots nicht begrüßen (Komma-getrennte Namen)';label.append(names);const save=document.createElement('button');save.textContent='Speichern';form.append(title,select,help,tipLabel,tipInfo,preview,portalLabel,portalHelp,halloween,label,save);function paint(d){const t=d.communityTips||{};tipToggle.checked=Boolean(t.enabled);portalToggle.checked=Boolean(t.portalEnabled);hToggle.checked=t.halloweenEnabled!==false;hFrequency.value=t.halloweenFrequency||'frequent';tipInfo.textContent='Community-Tipps sind '+(t.enabled?'eingeschaltet':'ausgeschaltet')+'. Nur bei bestätigtem Live-Stream, echter Chat-Aktivität und freiem Nachrichtenplan. Profil '+(t.profile==='calm'?'Ruhig: max. 1 Tipp/Stunde, 8 Chatbeiträge':t.profile==='lively'?'Lebhaft: max. 3 Tipps/Stunde, 5 Chatbeiträge':'Normal: max. 2 Tipps/Stunde, 6 Chatbeiträge')+'.';hStatus.textContent=!t.halloweenActive?'Hinweis: Das Halloween-Event ist aktuell nicht aktiv. Erinnerungen pausieren automatisch.':!t.enabled?'Community-Tipps sind ausgeschaltet; Halloween-Erinnerungen sind pausiert.':!t.halloweenEnabled?'Halloween-Erinnerungen sind ausgeschaltet.':'Halloween-Event aktiv · '+(t.halloweenSentThisHour||0)+' von '+(t.halloweenHourlyLimit||2)+' Erinnerungen in der letzten Stunde.';hLast.textContent='Letzte Halloween-Erinnerung: '+(t.halloweenLastSentAt?new Date(t.halloweenLastSentAt).toLocaleString():'noch keine');hNext.textContent='Nächster frühestmöglicher Zeitpunkt: '+(t.halloweenActive&&t.halloweenNextEarliestAt?new Date(t.halloweenNextEarliestAt).toLocaleTimeString():'erst wenn das Event aktiv ist und die Regeln erfüllt sind');hPreview.replaceChildren();for(const text of (t.halloweenPreviews||[])){const p=document.createElement('p');p.className='chat-preview';p.textContent=text;hPreview.append(p)}preview.textContent='Weitere mögliche Community-Tipps: '+((d.tipPreviews||[]).map(x=>x.text).join(' · ')||'Zurzeit keine weiteren aktivierten Themen.')};paint(s);form.onsubmit=async e=>{e.preventDefault();try{await api('chat-messages','POST',{profile:select.value,welcomeBots:names.value.split(',').map(x=>x.trim()).filter(Boolean),communityTipsEnabled:tipToggle.checked,communityPortalTipsEnabled:portalToggle.checked,communityHalloweenEnabled:hToggle.checked,communityHalloweenFrequency:hFrequency.value});const current=await api('chat-messages');paint(current);show('Chat-Nachrichten gespeichert.')}catch(err){show(err.message)}};root.append(form);const stats=document.createElement('p');stats.className='muted';root.append(stats);async function refreshStats(){try{const current=await api('chat-messages');stats.textContent='Seit Bot-Start: '+(current.suppressed||0)+' Antworten unterdrückt, '+(current.deferred||0)+' wegen Chattempo begrenzt, '+(current.queued||0)+' Nachrichten warten im Chatversand.';paint(current)}catch{stats.textContent='Versandstatus derzeit nicht verfügbar.'}}refreshStats();setInterval(refreshStats,15000)}).catch(e=>{root.textContent='Einstellungen konnten nicht geladen werden: '+e.message})})();`;
const AUTOMATIC_CHAT_MESSAGES_SCRIPT = `(()=>{const style=document.createElement('style');style.textContent='.auto-message-card{border:1px solid #393d4d;border-radius:11px;padding:14px;margin:10px 0;background:#171923}.auto-message-card h4{margin:2px 0 8px}.auto-message-card .row{display:flex;flex-wrap:wrap;gap:8px}.auto-message-card .row button{min-height:40px}#automatic-chat-form{display:grid;gap:12px;max-width:720px}#automatic-chat-form label{display:grid;gap:5px}#automatic-chat-form input,#automatic-chat-form select,#automatic-chat-form textarea{max-width:100%;padding:10px;border-radius:8px}#automatic-chat-form label:has(input[type=checkbox]){display:flex;align-items:center;gap:8px}@media(max-width:520px){.auto-message-card .row button{flex:1 1 100%}}';document.head.append(style);const root=document.querySelector('#automatic-chat-messages'),form=document.querySelector('#automatic-chat-form'),list=document.querySelector('#automatic-chat-list');if(!root||!form||!list)return;const title=form.elements.namedItem('title'),text=form.elements.namedItem('message'),interval=form.elements.namedItem('interval'),customInput=form.elements.namedItem('customInterval'),custom=form.querySelector('label[name=custom]'),enabled=form.elements.namedItem('enabled'),active=form.elements.namedItem('activeChatOnly'),id=form.elements.namedItem('id'),preview=document.querySelector('#automatic-chat-preview');function previewText(){const body=text.value.trim().replace(/^【[^】]+】\\s*/u,'');const formatted='【📢 INFO】 '+body;preview.textContent=Array.from(formatted).length<=500?formatted:'Vorschau: Nachricht ist länger als Twitch erlaubt.'}text.addEventListener('input',previewText);interval.addEventListener('change',()=>{custom.hidden=interval.value!=='custom'});form.elements.namedItem('cancel').onclick=()=>{form.reset();id.value='';custom.hidden=true;previewText()};function editor(item){id.value=item?.id||'';title.value=item?.title||'';text.value=item?.message||'';interval.value=[30,45,60,90].includes(item?.intervalMinutes)?String(item.intervalMinutes):'custom';customInput.value=item?.intervalMinutes||30;custom.hidden=interval.value!=='custom';enabled.checked=item?.enabled??true;active.checked=item?.activeChatOnly??false;previewText();form.scrollIntoView({behavior:'smooth',block:'center'})}async function refresh(){try{const data=await api('automatic-messages');list.replaceChildren();if(!data.messages.length){const p=document.createElement('p');p.className='muted';p.textContent='Noch keine eigenen Nachrichten angelegt.';list.append(p)}for(const item of data.messages){const card=document.createElement('article');card.className='auto-message-card';const heading=document.createElement('h4');heading.textContent=item.title;const sample=document.createElement('p');sample.className='chat-preview';sample.textContent=item.preview;const status=document.createElement('p');status.className='muted';status.textContent=(item.enabled?'Aktiv':'Pausiert')+' · alle '+item.intervalMinutes+' Min. · '+(item.activeChatOnly?'nur bei aktivem Chat':'ohne zusätzliche Aktivitätsschwelle')+' · zuletzt: '+(item.lastSentAt?new Date(item.lastSentAt).toLocaleString():'noch nicht gesendet')+' · frühestens: '+(item.nextEarliestAt>Date.now()?new Date(item.nextEarliestAt).toLocaleString():'jetzt, sobald Stream und Versandregeln passen')+(item.lastErrorAt?' · letzter Sendeversuch fehlgeschlagen; kontrollierter neuer Versuch nach Intervall':'');const actions=document.createElement('div');actions.className='row';for(const [label,action] of [[item.enabled?'Pausieren':'Fortsetzen','toggle'],['Bearbeiten','edit'],['Löschen','delete']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=async()=>{try{if(action==='edit'){editor(item);return}if(action==='delete'&&!confirm('„'+item.title+'“ wirklich löschen?'))return;await api('automatic-messages','POST',action==='toggle'?{action,id:item.id,enabled:!item.enabled}:{action,id:item.id});show(action==='delete'?'Nachricht gelöscht.':'Status geändert.');await refresh()}catch(error){show(error.message)}};actions.append(button)}card.append(heading,sample,status,actions);list.append(card)}}catch(error){list.textContent='Nachrichten konnten nicht geladen werden: '+error.message}}form.onsubmit=async event=>{event.preventDefault();try{const minutes=interval.value==='custom'?Number(customInput.value):Number(interval.value);await api('automatic-messages','POST',{action:'save',id:id.value||undefined,title:title.value,message:text.value,intervalMinutes:minutes,enabled:enabled.checked,activeChatOnly:active.checked});show(id.value?'Nachricht aktualisiert.':'Nachricht angelegt.');form.reset();id.value='';custom.hidden=true;previewText();await refresh()}catch(error){show(error.message)}};refresh();})();`;
const CHAT_IDENTITY_PREVIEW_SCRIPT = `(()=>{const root=document.querySelector('#chat-identity-preview');if(!root)return;root.innerHTML='<h3>Chat-Stil: COMMUNITY</h3><p class="muted">Jede öffentliche Bot-Nachricht erhält automatisch ein passendes, gut erkennbares Kategorien-Schild.</p>';for(const text of ['【🎁 DROP】 Mystery Drop gestartet! Schreibt !claim.','【🎭 IMPOSTER】 Die Abstimmung beginnt!','【❓ HILFE】 Verfügbare Befehle findest du mit !help.']){const sample=document.createElement('p');sample.className='chat-preview';sample.textContent=text;root.append(sample)}})();`;
const ARCADE_SMART_CONTROLS_SCRIPT = `(()=>{const dropButton=document.querySelector('#arcade-drop'),spinButton=document.querySelector('#arcade-spin'),stopButton=document.querySelector('#arcade-stop'),state=document.querySelector('#arcade-state'),widget=document.querySelector('#arcade-widget-status');async function update(){try{const d=await api('arcade'),w=d.wheel,drop=d.drop?.drop,activeDrop=Boolean(drop&&['announced','claiming','resolving'].includes(drop.status));dropButton.hidden=!d.settings.dropsEnabled||activeDrop;dropButton.disabled=!d.settings.dropsEnabled||activeDrop;dropButton.title=activeDrop?'Der aktuelle Drop läuft bereits.':d.settings.dropsEnabled?'60 Sekunden Teilnahme mit !claim':'Schalte Drops in den optionalen Einstellungen ein.';spinButton.hidden=!d.settings.wheelEnabled||!w.autoPilotEnabled;stopButton.hidden=!w.autoPilotEnabled;spinButton.disabled=!w.canSpin;let line=state.querySelector('[data-drop-status]');if(!line){line=document.createElement('p');line.dataset.dropStatus='true';state.append(line)}line.textContent=activeDrop?'🎁 '+drop.participants+' Teilnehmende · noch '+Math.max(0,Math.ceil((drop.endsAt-Date.now())/1000))+' Sekunden':'🎁 Kein Drop aktiv.';line.hidden=!d.settings.dropsEnabled;const links=await api('widgets/status');widget.textContent='OBS: Drop '+(links.widgets?.drop?'eingerichtet':'nicht eingerichtet')+' · Glücksrad '+(links.widgets?.wheel?'eingerichtet':'nicht eingerichtet')+'. Ohne OBS funktionieren Chat und Spiel weiter.'}catch{widget.textContent='OBS-Linkstatus aktuell nicht prüfbar.'}}update();setInterval(update,3000);setInterval(()=>{const line=state.querySelector('[data-drop-status]');if(line&&line.textContent.includes('Teilnehmende'))update()},1000)})();`;
const DASHBOARD_SHORTCUT_SCRIPT = `(()=>{const overview=document.querySelector('#dashboard-overview'),actions=document.createElement('div');actions.className='row';for(const [label,href] of [['Imposter starten','#spiele'],['Umfrage erstellen','#community'],['OBS-Widgets öffnen','#obs']]){const a=document.createElement('a');a.href=href;a.textContent=label;a.className='button-link';actions.append(a)}overview.prepend(actions);const commands=document.querySelector('#dashboard-commands'),tip=document.createElement('p');tip.className='muted';tip.textContent='Im Chat zeigt !help die Kurz-Hilfe. Zuschauer können dort Themen wie Punkte, Spiele und Umfragen nachschlagen.';commands.prepend(tip)})();`;
const DASHBOARD_OBS_DEMO_SCRIPT = `(()=>{const select=document.querySelector('#obs-type'),host=document.querySelector('#obs-result');if(!select||!host)return;const box=document.createElement('div');box.className='preview-widget';box.setAttribute('aria-live','polite');const title=document.createElement('strong'),line=document.createElement('p');title.textContent='Vorschau';line.textContent='Beispielanzeige für die ausgewählte Browserquelle.';box.append(title,line);host.before(box);function update(){const labels={imposter:'CHAT-IMPOSTER · Anmeldung · 4 Teilnehmende · Countdown',detective:'WER HAT DAS GESCHRIEBEN? · „Beispielzitat aus dem Chat“',poll:'LIVE-UMFRAGE · Welche Runde als Nächstes?',quest:'LIVE-QUEST · Gemeinsam eine Aufgabe schaffen',pet:'COMMUNITY-PET · gemeinsamer Fortschritt',drop:'MYSTERY DROP · !claim zum Mitmachen',wheel:'CHAOS WHEEL · Das Rad dreht sich'};line.textContent=labels[select.value]+' — Beispiel; live erscheinen hier die echten Spieldaten.'}select.addEventListener('change',update);update()})();`;
const DASHBOARD_TIMER_SCRIPT = `(()=>{setInterval(()=>{const node=document.querySelector('#mini-next');if(!node)return;if(!node.querySelector('[data-countdown]')){node.dataset.phaseText=node.textContent;const timer=document.createElement('span');timer.dataset.countdown='true';node.append(timer)}const timer=node.querySelector('[data-countdown]');timer.textContent=miniEndsAt?' · Countdown '+Math.floor(Math.max(0,miniEndsAt-Date.now())/1000)+' Sek.':''},1000)})();`;
const DASHBOARD_APP_SCRIPT = `(()=>{
const quickLinks=document.querySelector('.dashboard-top');
const streamerEntry=document.createElement('a');streamerEntry.href='/streamer';streamerEntry.textContent='🎛 Streamer-Steuerung';streamerEntry.className='streamer-entry';streamerEntry.setAttribute('aria-label','Streamer-Steuerung öffnen');quickLinks?.append(streamerEntry);
const portalEntry=document.createElement('a');portalEntry.href='/community';portalEntry.textContent='👥 Community-Portal';portalEntry.className='portal-entry';portalEntry.setAttribute('aria-label','Öffentliches Community-Portal öffnen');quickLinks?.append(portalEntry);
document.querySelectorAll('#dashboard-legacy-source [style]').forEach(x=>x.removeAttribute('style'));
const views=[...document.querySelectorAll('[data-dashboard-view]')],mainNav=[...document.querySelectorAll('[data-view-target]')];
const gamePages=[...document.querySelectorAll('[data-game-page]')],gameNav=[...document.querySelectorAll('[data-game-target]')];
const communityPages=[...document.querySelectorAll('[data-community-page]')],communityNav=[...document.querySelectorAll('[data-community-target]')];
const settingPages=[...document.querySelectorAll('[data-setting-page]')],settingNav=[...document.querySelectorAll('[data-setting-target]')];
function pick(nodes,key,valueAttr,selected){nodes.forEach(n=>{const active=n.getAttribute(valueAttr)===selected;n.hidden=!active;if(active)n.dataset.active='true';else delete n.dataset.active});}
function setGame(id,write=true){pick(gamePages,id,'data-game-page',id);gameNav.forEach(b=>{const active=b.dataset.gameTarget===id;b.setAttribute('aria-current',active?'page':'false')});const catalog=document.querySelector('#game-catalog');if(catalog)catalog.hidden=Boolean(id);if(write)history.replaceState(null,'','#spiele/'+id);window.dispatchEvent(new Event('dashboard:viewchange'))}
function setCommunity(id,write=true){pick(communityPages,id,'data-community-page',id);communityNav.forEach(b=>b.setAttribute('aria-current',b.dataset.communityTarget===id?'page':'false'));if(write)history.replaceState(null,'','#community/'+id);window.dispatchEvent(new Event('dashboard:viewchange'))}
function setSetting(id,write=true){pick(settingPages,id,'data-setting-page',id);settingNav.forEach(b=>b.setAttribute('aria-current',b.dataset.settingTarget===id?'page':'false'));if(write)history.replaceState(null,'','#einstellungen/'+id);window.dispatchEvent(new Event('dashboard:viewchange'))}
function setView(id,write=true){views.forEach(v=>{const active=v.dataset.dashboardView===id;v.hidden=!active;if(active)v.dataset.active='true';else delete v.dataset.active});mainNav.forEach(b=>b.setAttribute('aria-current',b.dataset.viewTarget===id?'page':'false'));if(id==='community'&&!communityPages.some(p=>p.dataset.active==='true'))setCommunity('events',false);if(id==='settings'&&!settingPages.some(p=>p.dataset.active==='true'))setSetting('messages',false);if(id==='games'&&(write||!gamePages.some(p=>p.dataset.active==='true'))){const catalog=document.querySelector('#game-catalog');if(catalog)catalog.hidden=false;pick(gamePages,'','data-game-page','');gameNav.forEach(b=>b.setAttribute('aria-current','false'))}if(write)history.replaceState(null,'','#'+id);window.scrollTo(0,0);window.dispatchEvent(new Event('dashboard:viewchange'))}
function route(){const [raw,sub]=location.hash.slice(1).split('/');const names={uebersicht:'overview',spiele:'games',community:'community',obs:'obs',einstellungen:'settings',chat:'settings',befehle:'settings'};const view=names[raw]||'overview';setView(view,false);if(raw==='spiele'&&sub)setGame(sub,false);if(raw==='community'&&sub)setCommunity(sub,false);if(raw==='einstellungen'&&sub)setSetting(sub==='advanced'?'diagnostics':sub,false);if(raw==='chat')setSetting('messages',false);if(raw==='befehle')setSetting('commands',false)}
mainNav.forEach(b=>b.addEventListener('click',()=>setView(b.dataset.viewTarget)));gameNav.forEach(b=>b.addEventListener('click',()=>setGame(b.dataset.gameTarget)));communityNav.forEach(b=>b.addEventListener('click',()=>setCommunity(b.dataset.communityTarget)));settingNav.forEach(b=>b.addEventListener('click',()=>setSetting(b.dataset.settingTarget)));window.addEventListener('hashchange',route);
function pageButton(label,view,sub){const b=document.createElement('button');b.type='button';b.className='catalog-card card';const h=document.createElement('h3'),p=document.createElement('p');h.textContent=label;p.className='muted';p.textContent='Öffnen';b.replaceChildren(h,p);b.addEventListener('click',()=>{setView(view);if(sub)view==='games'?setGame(sub):view==='community'?setCommunity(sub):setSetting(sub)});return b}
const detailCopy={imposter:['Chat-Imposter','Geheime Rollen erraten, diskutieren und abstimmen. Zuschauer melden sich mit !joinimposter an.','Die Runde startet erst, wenn du auf „Anmeldung starten“ klickst.'],detective:['Chat-Detektiv','Der Chat errät den Urheber eines freiwillig eingereichten Zitats.','Prüfe zuerst die eingereichten Zitate und starte anschließend die Runde.'],drop:['Mystery Drops','Eine kurze Belohnungsrunde für den Chat. Zuschauer nehmen mit !claim teil.','Beim Start läuft ein Countdown; die Teilnahme und Auswertung übernimmt der Bot.'],wheel:['Chaos Wheel','Automatische Community-Aktionen und manuelle Herausforderungen verwalten.','Der angezeigte Status erklärt, ob das Rad läuft oder pausiert ist.'],vault:['Community-Tresor','Knackt gemeinsam einen geheimen dreistelligen Code.','Eine Runde kann manuell starten oder nach einmaliger Aktivierung automatisch anlaufen.'],pranks:['Chaos & Pranks','Vier optionale, harmlose Moderatoraktionen rund um Elio und das Orakel.','Nur berechtigte Teammitglieder können sie starten; Spielstände und echte Rechte bleiben unverändert.'],other:['Weitere Chatspiele','Kleine zusätzliche Chatspiele und ihre Zuschauerbefehle.','Diese Spiele folgen den vorhandenen Chat-Einstellungen und Cooldowns.'],events:['Saison-Events','Zeitlich begrenzte Sammelaktionen mit eigener Rangliste.','Starte ein Event, wenn es im Chat genutzt werden soll; beenden löscht keine Punkte.'],xp:['XP und Level','Dauerhafter Fortschritt der Community.','Zuschauer sehen ihren Stand mit !level. Saisonpunkte bleiben davon getrennt.'],elio:['Elio','Die Community pflegt Elio gemeinsam und begleitet seine Entwicklung.','Der Status zeigt Lebensphase, Level und Bedürfnisse; Änderungen bleiben an den vorhandenen Chataktionen gebunden.'],quests:['Community-Aufgaben','Vorschläge prüfen, Abstimmungen starten und Aufgaben begleiten.','Eine Abstimmung startet keine Quest automatisch: bestätige den nächsten Schritt selbst.'],spark:['Chat-Ideen','Vorschläge aus öffentlichen Chat-Themen prüfen.','Gesprächsfragen und bestehende Aktionen erscheinen erst zur Prüfung; nur freigegebene Fragen werden im Chat veröffentlicht.'],vip:['VIP-Erlebnis','VIP-Funktionen, offene Freigaben und die Broadcaster-VIP-Prüfung verwalten.','Die Twitch-Autorisierung bleibt getrennt vom Login der Zuschauer; neue VIP-Funktionen sind standardmäßig ausgeschaltet.'],'live-votes':['Live-Abstimmungen','Stelle harmlose Fragen mit zwei bis fünf Antworten. Zuschauer stimmen über das Community-Portal oder im Chat mit !vote ab.','Eine Person hat eine Stimme. Die Abstimmung endet automatisch; sie startet keine Spielaktion.'],welcome:['Begrüßung','Eine optionale Begrüßung für neue Chatter einrichten.','Der Bot sendet die gespeicherte Nachricht automatisch, wenn die Funktion eingeschaltet ist.'],music:['Song-Wünsche','Twitch-Belohnungen für Songwünsche einrichten und Anfragen verwalten.','Twitch- und Spotify-Verbindungen sowie eine Playlist sind vor dem Einschalten erforderlich.']};
function addDetailGuides(){for(const [kind,nodes] of [['game',gamePages],['community',communityPages]])for(const section of nodes){const id=section.dataset[kind==='game'?'gamePage':'communityPage'],copy=detailCopy[id];if(!copy)continue;const bar=document.createElement('div');bar.className='subpage-guide';const back=document.createElement('button');back.type='button';back.className='subpage-back';back.textContent=kind==='game'?'← Alle Spiele':'← Community';back.addEventListener('click',()=>kind==='game'?setView('games'):setCommunity('events'));const intro=document.createElement('p');intro.className='muted';intro.textContent=copy[1]+' '+copy[2];bar.append(back,intro);section.prepend(bar)}}
const byTitle=t=>[...document.querySelectorAll('.card')].find(c=>c.querySelector('h2')?.textContent?.trim()===t);
const put=(node,target)=>{if(node&&target)target.append(node)};
const gameTarget=id=>document.querySelector('[data-game-page="'+id+'"] .view-grid');
const communityTarget=id=>document.querySelector('[data-community-page="'+id+'"] .view-grid');
const settingsTarget=id=>document.querySelector('[data-setting-page="'+id+'"] .view-grid');
// Move existing feature controls into their own routed views; event handlers remain bound to the same elements.
const mini=byTitle('Chat-Imposter & Chat-Detektiv');
if(mini){const h=mini.querySelector('h2');if(h)h.textContent='Chat-Imposter';mini.style.gridColumn='';mini.querySelector(':scope > p')?.remove();mini.querySelector('.guide-block')?.remove();for(const details of [...mini.querySelectorAll(':scope > details')])if(details.id!=='mini-quote-review'&&!details.querySelector('#mini-settings-form'))details.remove();const detective=document.createElement('article');detective.className='card';detective.innerHTML='<h2>Chat-Detektiv</h2><p class="muted">Der Chat errät den Urheber eines freiwillig eingereichten Zitats. Zuschauer tippen mit <code>!wer @Name</code>.</p><div id="detective-state" class="phase-box">Rundenstatus wird geladen …</div><p>Vor dem Start muss mindestens ein Zitat geprüft und freigegeben sein.</p>';const detectiveActions=mini.querySelector('#mini-detective-start')?.parentElement;if(detectiveActions)detective.append(detectiveActions);const quoteReview=mini.querySelector('#mini-quote-review');if(quoteReview)detective.append(quoteReview);const sharedSettings=mini.querySelector('#mini-settings-form')?.closest('details');if(sharedSettings){sharedSettings.querySelector('#mini-quote-review')?.remove();const settingsCard=document.createElement('article');settingsCard.className='card';settingsCard.innerHTML='<h2>Imposter- und Detektiv-Einstellungen</h2>';settingsCard.append(sharedSettings);put(settingsCard,settingsTarget('functions'))}put(mini,gameTarget('imposter'));put(detective,gameTarget('detective'))}
const arcade=byTitle('Chaos Wheel')||byTitle('Mystery Drops und Glücksrad')||byTitle('Pet, Überraschung und Glücksrad');
if(arcade){arcade.style.gridColumn='';const h=arcade.querySelector('h2');if(h)h.textContent='Chaos Wheel';arcade.querySelector('.guide-block')?.remove();arcade.querySelector(':scope > p')?.remove();const drop=document.createElement('article');drop.className='card';drop.innerHTML='<h2>Mystery Drops</h2><p class="muted">Jannik startet eine 60-Sekunden-Belohnungsrunde. Zuschauer schreiben <code>!claim</code>; XP und Ergebnis folgen automatisch.</p><div id="drop-page-status" class="phase-box">Dropstatus wird geladen …</div><div class="row" id="drop-page-actions"></div>';const dropButton=arcade.querySelector('#arcade-drop');put(dropButton,drop.querySelector('#drop-page-actions'));put(arcade,gameTarget('wheel'));put(drop,gameTarget('drop'))}
const elio=byTitle('Community-Pet')||byTitle('Elio 🐱');put(elio,communityTarget('elio'));
const experiments=[...document.querySelectorAll('.experiment-list')];experiments.forEach(x=>put(x,gameTarget('other')));
for(const c of [byTitle('Saison-Event')])put(c,communityTarget('events'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/Neue Vorschläge|Optional abstimmen lassen|Community-Quests|Quest-Abstimmung|Gemeinsame Vorschläge/u.test(x.querySelector('h2')?.textContent||'')))put(c,communityTarget('quests'));const questArea=communityTarget('quests');if(questArea){const flow=document.createElement('ol');flow.className='quest-flow-steps';flow.innerHTML='<li><strong>Prüfen</strong><span>Neue Vorschläge freigeben oder ablehnen.</span></li><li><strong>Optional abstimmen</strong><span>Der Chat wählt aus freigegebenen Aufgaben.</span></li><li><strong>Starten und abschließen</strong><span>Das Team startet und bewertet die Aufgabe selbst.</span></li>';questArea.prepend(flow)}
put(byTitle('Chat-Ideen'),communityTarget('spark'));put(byTitle('Gesprächs-Funken'),communityTarget('spark'));
put(byTitle('Live-Abstimmungen'),communityTarget('live-votes'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/Begrüßung neuer Chatter/u.test(x.querySelector('h2')?.textContent||'')))put(c,communityTarget('welcome'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/OBS: Widgets|OBS-Einrichtung|Overlay-Vorschau/u.test(x.querySelector('h2')?.textContent||'')))put(c,document.querySelector('#dashboard-obs .view-grid'));const obsWizard=document.querySelector('.obs-wizard'),livePreview=byTitle('Overlay-Vorschau');if(obsWizard&&livePreview){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Aktuelle Quest- und Umfragevorschau';details.append(summary,livePreview);obsWizard.append(details)}const oldWidgetControls=byTitle('OBS-Widgets');if(oldWidgetControls){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Erweiterte Verwaltung einzelner Widget-Links';details.append(summary,oldWidgetControls);obsWizard?.append(details)}
for(const c of [...document.querySelectorAll('.card')].filter(x=>/Eigene Chatbefehle|Erweiterte Befehlsverwaltung/u.test(x.querySelector('h2')?.textContent||'')))put(c,settingsTarget('commands'));
for(const c of [...document.querySelectorAll('.card')]){const title=c.querySelector('h2')?.textContent||'';if(/Bot-Status/u.test(title))put(c,settingsTarget('diagnostics'));else if(/Funktionen ein- und ausschalten|Community-Boss/u.test(title))put(c,settingsTarget('functions'));else if(/XP korrigieren|Zuschauer suchen/u.test(title))put(c,settingsTarget('moderation'));else if(/Technische Grundeinstellungen/u.test(title))put(c,settingsTarget('general'));else if(/Kanalpunkte/u.test(title))put(c,settingsTarget('integrations'));}
for(const node of [document.querySelector('#chat-nachrichten .card')])put(node,settingsTarget('messages'));
const home=document.querySelector('#home-status');
const homeCurrent=document.querySelector('#home-current'),homeWarnings=document.querySelector('#home-warnings');
async function updateHome(){try{const [s,miniData,arcadeData,widgetData]=await Promise.all([api('status'),api('minigames'),api('arcade'),api('widgets/status')]);const websocket=s.eventSubSocket===true||s.eventSubSocket==='connected';home.replaceChildren();const tiles=[['Bot antwortet',s.dashboardResponding===true?'Ja':'Nicht erreichbar'],['Twitch-Verbindung',websocket?'Verbunden':'Wird geprüft'],['Chatempfang',s.chatReceive==='confirmed'?'Bestätigt':'Noch nicht geprüft'],['Chatversand',s.botChatSend==='confirmed'?'Bestätigt':'Noch nicht geprüft']];for(const [label,value] of tiles){const tile=document.createElement('div');tile.className='status-tile';const strong=document.createElement('strong'),span=document.createElement('span');strong.textContent=label;span.textContent=value;tile.append(strong,span);home.append(tile)}const setup=document.querySelector('#setup-checklist');if(setup){setup.replaceChildren();const add=(title,ok,description,action)=>{const row=document.createElement('div');row.className='setup-check-row';const copy=document.createElement('div'),heading=document.createElement('strong'),text=document.createElement('p');heading.textContent=(ok?'✅ ':'○ ')+title;text.textContent=description;copy.append(heading,text);row.append(copy);if(action){const button=document.createElement('button');button.type='button';button.textContent=action;button.addEventListener('click',()=>setView('obs'));row.append(button)}setup.append(row)};add('Chat kann Nachrichten empfangen',s.chatReceive==='confirmed',s.chatReceive==='confirmed'?'Durch eine echte Chatnachricht bestätigt.':'Der Empfang wird durch eine echte Nachricht bestätigt. Das Dashboard löst dafür keine Chataktion aus.');add('Chat kann Nachrichten senden',s.botChatSend==='confirmed',s.botChatSend==='confirmed'?'Twitch hat eine Bot-Nachricht bestätigt.':'Der Versand wird erst durch eine bestätigte Bot-Antwort belegt.');const widgets=Object.entries(widgetData.widgets||{}).filter(([,active])=>active).map(([name])=>name);add('OBS-Widget-Link',widgets.length>0,widgets.length?widgets.length+' Link'+(widgets.length===1?' ist':'s sind')+' eingerichtet. Das bestätigt nicht, dass eine Quelle in OBS sichtbar ist.':'Optional: Noch kein Widget-Link eingerichtet. Das Dashboard kann die Sichtbarkeit in OBS nicht prüfen.',widgets.length?'Links verwalten':'OBS einrichten')}const current=miniData.state?.detective?.phase==='playing'?'Chat-Detektiv läuft':miniData.state?.imposter?.phase&&miniData.state.imposter.phase!=='idle'?'Chat-Imposter · '+miniData.state.imposter.phase:arcadeData.wheel?.activeAction?'Chaos Wheel · '+arcadeData.wheel.activeAction.title:arcadeData.drop?.drop&&['announced','claiming','resolving'].includes(arcadeData.drop.drop.status)?'Mystery Drop läuft':'Kein Spiel aktiv';homeCurrent.textContent=current;const warns=[];if(s.errorPresent)warns.push('Beim Bot liegt ein technischer Hinweis vor.');if(s.eventSubSocket===false||s.eventSubSocket==='disconnected')warns.push('Die Twitch-Verbindung ist getrennt.');homeWarnings.replaceChildren();if(!warns.length){const p=document.createElement('p');p.className='muted';p.textContent='Keine wichtigen Warnungen.';homeWarnings.append(p)}else for(const w of warns){const p=document.createElement('p');p.className='warning-item';p.textContent=w;homeWarnings.append(p)}const details=document.querySelector('#diagnostics');details.hidden=false;const diagRows=[['EventSub-WebSocket',websocket?'Verbunden':'Nicht verbunden'],['Chat-Abonnement',s.chatSubscription==='active'?'Aktiv':'Nicht bestätigt'],['Echte eingehende Chatnachricht',s.chatReceive==='confirmed'?'Bestätigt':'Nicht bestätigt'],['Bot-Antwort akzeptiert',s.botChatSend==='confirmed'?'Bestätigt':'Nicht bestätigt'],['Broadcaster-OAuth',s.broadcasterOAuth==='connected'?'Verbunden':'Nicht verbunden'],['Kanal',s.channel||'Nicht bekannt']];const grid=document.querySelector('#diagnostic-grid');grid.replaceChildren();for(const [k,v] of diagRows){const p=document.createElement('p');p.textContent=k+': '+v;grid.append(p)}}catch{home.textContent='Status derzeit nicht verfügbar.'}}
updateHome();setInterval(updateHome,12000);
async function updateDetective(){try{const d=await api('minigames'),round=d.state?.detective;const node=document.querySelector('#detective-state');if(node)node.textContent=round?(round.phase==='playing'?'Raten läuft · '+round.guesses+' Tipps · '+Math.max(0,Math.ceil((round.endsAt-Date.now())/1000))+' Sek.':round.phase==='results'?'Auflösung läuft':'Keine Runde aktiv'):'Keine Runde aktiv'}catch{}}
async function updateDrop(){try{const d=await api('arcade'),x=d.drop?.drop,n=document.querySelector('#drop-page-status');if(n)n.textContent=x&&['announced','claiming','resolving'].includes(x.status)?x.participants+' Teilnehmende · noch '+Math.max(0,Math.ceil((x.endsAt-Date.now())/1000))+' Sekunden':'Kein Drop aktiv.'}catch{}}
updateDetective();updateDrop();setInterval(updateDetective,3000);setInterval(updateDrop,3000);
document.querySelectorAll('[data-home-route]').forEach(b=>b.addEventListener('click',()=>{const [v,s]=b.dataset.homeRoute.split('/');setView(v);if(s)v==='games'?setGame(s):setCommunity(s)}));
const catalog=document.querySelector('#game-catalog');if(catalog)catalog.replaceChildren(...[['Chaos & Pranks','pranks','Kurze, harmlose Aktionen für berechtigte Moderatoren.'],['Chat-Imposter','imposter','Geheime Rollen, Diskussion und Abstimmung.'],['Chat-Detektiv','detective','Freiwillige Chat-Zitate erraten.'],['Mystery Drops','drop','Kurzrunde mit automatischer XP-Auswertung.'],['Chaos Wheel','wheel','Alle 30 Minuten automatische Community-Aktion.'],['Community-Tresor','vault','Gemeinsam einen dreistelligen Code knacken.'],['Weitere Chatspiele','other','Experimentelle kleine Chatspiele.']].map(([name,id,desc])=>{const b=pageButton(name,'games',id);b.querySelector('p').textContent=desc;return b}));
const xpPage=communityTarget('xp');if(xpPage){const card=document.createElement('article');card.className='card';card.innerHTML='<h3>XP &amp; Level</h3><p>XP sind der dauerhafte Fortschritt der Community. Zuschauer prüfen ihren Stand im Chat mit <code>!level</code>; Saisonpunkte bleiben davon getrennt.</p>';xpPage.append(card)}
addDetailGuides();
document.querySelectorAll('[data-community-home]').forEach(b=>b.addEventListener('click',()=>setCommunity(b.dataset.communityHome)));
function route(){const [raw,sub]=location.hash.slice(1).split('/'),mapping={uebersicht:'overview',spiele:'games',community:'community',obs:'obs',einstellungen:'settings'};const id=mapping[raw]||'overview';setView(id,false);if(raw==='spiele'&&sub)setGame(sub,false);if(raw==='community'&&sub)setCommunity(sub,false);if(raw==='einstellungen'&&sub)setSetting(sub==='general'||sub==='advanced'?'diagnostics':sub,false)}
window.addEventListener('hashchange',route);route();
})();`;
const SETTINGS_SCRIPT = `api('settings').then(s=>document.querySelector('#settings-json').value=JSON.stringify(s,null,2)).catch(e=>show(e.message));document.querySelector('#settings-form').onsubmit=async e=>{e.preventDefault();try{const value=JSON.parse(document.querySelector('#settings-json').value);await api('settings','POST',value);show('Einstellungen gespeichert.')}catch(x){show(x.message)}};document.querySelector('#boss-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.hp=Number(v.hp);v.durationMs=Number(v.durationMinutes)*60000;delete v.durationMinutes;try{await api('boss','POST',v);show('Bosskampf gestartet.');refresh()}catch(x){show(x.message)}};document.querySelector('#boss-end').onclick=async()=>{try{await api('boss','POST',{action:'end'});show('Bosskampf beendet.');refresh()}catch(x){show(x.message)}};async function renderCommandAdmin(){try{const c=await api('commands'),root=document.querySelector('#command-manager');root.replaceChildren();for(const command of c.commands){const row=document.createElement('div'),name=document.createElement('span');name.textContent='!'+command.name+(command.alias?' ('+command.alias+')':'')+' · '+(command.enabled?'aktiv':'inaktiv')+' ';row.append(name);const edit=document.createElement('button');edit.textContent='Bearbeiten';edit.onclick=()=>{const f=document.querySelector('#command-form');f.elements.namedItem('name').value=command.name;f.elements.namedItem('response').value=command.response;f.elements.namedItem('permission').value=command.permission;f.elements.namedItem('cooldownSeconds').value=Math.round(command.cooldownMs/1000);f.scrollIntoView({behavior:'smooth',block:'center'})};row.append(edit);const toggle=document.createElement('button');toggle.textContent=command.enabled?'Deaktivieren':'Aktivieren';toggle.onclick=async()=>{try{await api('commands','POST',{...command,enabled:!command.enabled});show('Chatbefehl geändert.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(toggle);const del=document.createElement('button');del.textContent='Löschen';del.onclick=async()=>{try{await api('commands/delete','POST',{name:command.name});show('Chatbefehl gelöscht.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(del);root.append(row)}}catch(x){show(x.message)}}renderCommandAdmin();setInterval(renderCommandAdmin,15000);`;

export class DashboardServer {
  private server: http.Server | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly states = new Map<string, number>();
  private readonly rates = new RateLimitBuckets();
  private readonly eventStreams = new Map<http.ServerResponse, { timer: NodeJS.Timeout; userId: string }>();
  private readonly widgetStreams = new Map<http.ServerResponse, { timer: NodeJS.Timeout; tokenHash: string }>();
  private readonly adminIds: Set<string>;
  private readonly moderatorIds = new Set((process.env.AUTHORIZED_MODERATOR_IDS || '').split(/[ ,]+/u).filter(Boolean));
  private readonly clientId = process.env.TWITCH_CLIENT_ID?.trim() || '';
  private readonly clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim() || '';
  private readonly discordIntegrationSecret = process.env.DISCORD_INTEGRATION_SECRET?.trim() || '';
  private readonly redirectUri = process.env.DASHBOARD_REDIRECT_URI?.trim() || '';
  private readonly host = process.env.DASHBOARD_HOST?.trim() || '127.0.0.1';
  private readonly port = Number(process.env.DASHBOARD_PORT || '3001');

  constructor(
    private readonly store: FeatureStore,
    private readonly getStatus: () => RuntimeStatus,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly getSparkSnapshot?: () => unknown,
    private readonly channelPoints?: ChannelPointsService,
    private readonly channelPointsUrl?: () => string,
    private readonly miniGames?: MiniGames,
    private readonly arcade?: CommunityArcade,
    private readonly sendToChat?: (message:string,category?:ChatCategory)=>Promise<void>|void,
    private readonly chatPolicy?: ChatResponsePolicy,
    private readonly communityTips?: CommunityTips,
    private readonly automaticChatMessages?: AutomaticChatMessages,
    private readonly songRequests?: SpotifySongRequests,
    private readonly viewerPortal?: ViewerCommunityPortal,
    private readonly vault?: CommunityVault,
    private readonly vaultStartAllowed?: () => Promise<boolean|string>,
    private readonly moderatorPranks?: ModeratorPranks,
    private readonly lookupPrankUser?: (login:string)=>Promise<{id:string;login:string;displayName:string}|undefined>,
    private readonly halloweenOdds?: {weights:EventWeights;source:string},
    private readonly checkPortalHealth?:()=>Promise<boolean>,
    private readonly botLifecycle?:BotLifecycle,
    private readonly vipService?:TwitchVipService,
    private readonly vipExperience?:VipExperience,
    private readonly vipAuthorizationUrl?:()=>string,
  ) { this.adminIds = new Set((process.env.DASHBOARD_ADMIN_IDS || '').split(/[ ,]+/u).filter(Boolean)); }

  async start(): Promise<boolean> {
    if (!this.adminIds.size || !this.clientId || !this.clientSecret || !this.redirectUri) {
      this.logger.warn('Dashboard nicht gestartet: DASHBOARD_ADMIN_IDS und Twitch-OAuth-Redirect müssen konfiguriert sein.');
      return false;
    }
    const redirect = new URL(this.redirectUri);
    if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost' && redirect.hostname !== '127.0.0.1') {
      throw new Error('DASHBOARD_REDIRECT_URI muss HTTPS verwenden (außer lokal).');
    }
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('DASHBOARD_PORT ist ungültig.');
    this.server = http.createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        this.logger.error('Dashboard-Anfrage fehlgeschlagen.', { error: error instanceof Error ? error.message : 'unbekannt' });
        if((request.url||'').startsWith('/games/imposter/callback'))this.participantLoginError(response,'Twitch ist gerade nicht erreichbar oder konnte die Anmeldung nicht prüfen. Bitte versuche es erneut.',502);
        else this.json(response, 500, { error: 'Interner Fehler.' });
      });
    });
    await new Promise<void>((resolve, reject) => this.server!.once('error', reject).listen(this.port, this.host, resolve));
    this.logger.info('Geschütztes Dashboard gestartet.', { host: this.host, port: this.port });
    return true;
  }

  async stop(): Promise<void> {
    this.viewerPortal?.stop();
    if (!this.server) return;
    for (const [response, stream] of this.eventStreams) { clearInterval(stream.timer); response.end(); }
    this.eventStreams.clear();
    for (const [response, stream] of this.widgetStreams) { clearInterval(stream.timer); response.end(); }
    this.widgetStreams.clear();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.sessions.clear();
  }

  address(): AddressInfo | undefined { const addr = this.server?.address(); return addr && typeof addr === 'object' ? addr : undefined; }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.headers(res);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const clientIp = trustedClientAddress(req);
    if(url.pathname.startsWith('/api/discord/v1/')){await this.discordIntegrationRoute(url,req,res,clientIp);return;}
    if (url.pathname === '/health') {
      if (req.method !== 'GET') { res.statusCode=405;res.setHeader('Allow','GET');res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Nur lesender Aufruf erlaubt.');return; }
      res.statusCode=200;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({status:'alive'}));return;
    }
    if (this.viewerPortal?.handles(url.pathname)) { await this.viewerPortal.handle(req,res,url); return; }
    if (url.pathname === '/hilfe') {
      if (this.rejectRateLimit(res, this.rates.consume('public-help', clientIp, 90, 60_000), 'Zu viele Hilfeaufrufe. Bitte kurz warten.')) return;
      if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET');res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Nur lesender Aufruf erlaubt.');return;}
      const nonce=randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(renderPublicHelpPage(this.publicHelpAvailability(),url.searchParams.get('q')||'',nonce));return;
    }
    if ((url.pathname === '/dashboard/login' || url.pathname === '/games/imposter/login') && req.method === 'GET') {
      if (this.rejectRateLimit(res, this.rates.consume('oauth-start', clientIp, 20, 10 * 60_000), 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.')) return;
      if (url.pathname === '/games/imposter/login') { this.participantLogin(res); return; }
      this.login(res); return;
    }
    if (url.pathname === '/streamer') {
      if (req.method !== 'GET') { res.statusCode=405;res.setHeader('Allow','GET');res.end('Methode nicht erlaubt.');return; }
      const session=this.authenticate(req,res);if(!session)return;if(session.role!=='admin'){this.json(res,403,{error:'Der Streamer-Modus ist nur für Jannik freigeschaltet.'});return;}
      if (this.rejectRateLimit(res, this.rates.consume('admin-page', session.userId, 120, 60_000), 'Zu viele Seitenaufrufe. Bitte kurz warten.')) return;
      const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(LIVE_CONTROL_PAGE.replace('(()=>{const csrf=',`${DASHBOARD_POLLING_SCRIPT}(()=>{const csrf=`).replace('update();setInterval(update,3000)',"window.dashboardPoll('#stream-status',update,10000)").replaceAll('__CSRF__',session.csrf).replaceAll('__NONCE__',nonce));return;
    }
    if(url.pathname==='/dashboard/memories'&&req.method==='GET'){
      const session=this.authenticate(req,res);if(!session)return;
      if(this.rejectRateLimit(res,this.rates.consume('admin-page',session.userId,120,60_000),'Zu viele Seitenaufrufe. Bitte kurz warten.'))return;
      const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(memoriesModerationPage(session.csrf,nonce));return;
    }
    if(url.pathname==='/dashboard/ideas'&&req.method==='GET'){
      const session=this.authenticate(req,res);if(!session)return;
      if(this.rejectRateLimit(res,this.rates.consume('admin-page',session.userId,120,60_000),'Zu viele Seitenaufrufe. Bitte kurz warten.'))return;
      const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(communityIdeasAdminPage(session.csrf,nonce));return;
    }
    if(url.pathname==='/dashboard/discord'&&req.method==='GET'){
      const session=this.authenticate(req,res);if(!session)return;if(session.role!=='admin'){this.json(res,403,{error:'Nur Jannik kann die Discord-Verbindung konfigurieren.'});return;}
      if(this.rejectRateLimit(res,this.rates.consume('admin-page',session.userId,120,60_000),'Zu viele Seitenaufrufe. Bitte kurz warten.'))return;
      const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(DISCORD_PAGE.replaceAll('__CSRF__',session.csrf).replaceAll('__NONCE__',nonce));return;
    }
    if (url.pathname === '/dashboard/oauth/callback' && req.method === 'GET') {
      if (this.rejectRateLimit(res, this.rates.consume('oauth-callback', clientIp, 30, 10 * 60_000), 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.')) return;
      await this.callback(url, req, res); return;
    }
    if (url.pathname === '/dashboard/spotify/callback' && req.method === 'GET') {
      res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
      try{if(!this.songRequests)throw new Error('Song Requests sind nicht eingerichtet.');await this.songRequests.handleCallback(url);res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spotify verbunden</title><body style="font:16px system-ui;background:#111;color:#eee;padding:2rem"><h1>Spotify verbunden</h1><p>Du kannst dieses Fenster schließen und die Musikwünsche im Dashboard fertig einrichten.</p><a style="color:#c9a8ff" href="/dashboard#community/music">Zum Dashboard</a></body></html>');}
      catch(error){res.statusCode=400;res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(error instanceof Error?error.message:'Spotify-Verbindung fehlgeschlagen.');}return;
    }
    if (url.pathname === '/games/imposter/callback' && req.method === 'GET') {
      if (this.rejectRateLimit(res, this.rates.consume('oauth-callback', clientIp, 30, 10 * 60_000), 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.')) return;
      await this.participantCallback(url, req, res); return;
    }
    if (url.pathname === '/games/imposter/role' && req.method === 'GET') { this.participantRole(req, res); return; }
    if (url.pathname === '/dashboard/api/logout' && req.method === 'POST') {
      const session = this.authenticate(req, res, true); if (!session) return;
      if (!this.checkCsrf(req, session)) { this.json(res, 403, { error: 'CSRF-Prüfung fehlgeschlagen.' }); return; }
      this.sessions.delete(this.cookieSession(req) || ''); this.clearCookie(res); this.json(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/dashboard' || url.pathname === '/dashboard/') {
      const session = this.authenticate(req, res); if (!session) return;
      if(session.role==='moderator'){
        if(this.rejectRateLimit(res,this.rates.consume('admin-page',session.userId,120,60_000),'Zu viele Seitenaufrufe. Bitte kurz warten.'))return;
        const nonce=randomBytes(18).toString('base64');res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(moderatorPranksPage(session.csrf).replace('</main>',`${VIP_MODERATOR_CARD}</main>`).replace('</script>',`${VIP_MODERATOR_SCRIPT}</script>`).replaceAll('__NONCE__',nonce));return;
      }
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const structure = `<nav class="main-nav" aria-label="Hauptnavigation"><button type="button" data-view-target="overview" aria-current="page">◉ <span>Übersicht</span></button><button type="button" data-view-target="games">▣ <span>Spiele &amp; Aktionen</span></button><button type="button" data-view-target="community">✦ <span>Community</span></button><a href="/dashboard/ideas">💡 <span>Ideen verwalten</span></a><a href="/dashboard/discord">💬 <span>Discord</span></a><button type="button" data-view-target="obs">▧ <span>Stream-Einrichtung</span></button><button type="button" data-view-target="settings">⚙ <span>Einstellungen</span></button></nav><div id="dashboard-app" class="dash-layout"><section class="dashboard-view" data-dashboard-view="overview" data-active="true" id="view-overview"><div class="view-header"><div><h2>Übersicht</h2><p class="muted view-intro">Was gerade läuft und was Aufmerksamkeit braucht.</p></div></div><article class="card"><h3>Bot- und Chatstatus</h3><div id="home-status" class="overview-status" aria-live="polite"><p class="muted">Status wird geprüft …</p></div><details id="diagnostics"><summary>Technische Diagnose</summary><div id="diagnostic-grid" class="diagnostic-grid"></div><div id="diagnostic-content"></div></details></article><article class="card"><h3>Aktuelles Spiel</h3><p id="home-current">Status wird geladen …</p></article><article class="card"><h3>Schnellaktionen</h3><div class="quick-actions"><button type="button" data-home-route="games/imposter">Imposter öffnen</button><button type="button" data-home-route="games/drop">Mystery Drop öffnen</button><button type="button" data-home-route="obs">Stream-Einrichtung öffnen</button></div></article><article class="card"><h3>Stream bereit machen</h3><p class="muted">Hier siehst du, was der Bot bereits bestätigt hat und was du noch einrichten kannst.</p><div id="setup-checklist" class="setup-checklist" aria-live="polite"><p class="muted">Verbindungen werden geprüft …</p></div></article><article class="card"><h3>Wichtige Hinweise</h3><div id="home-warnings" class="warning-list" aria-live="polite"></div></article></section><section class="dashboard-view" data-dashboard-view="games" id="view-games"><div class="view-header"><div><h2>Spiele &amp; Aktionen</h2><p class="muted view-intro">Wähle ein Spiel. Auf der Spielseite siehst du nur dessen Ablauf und Steuerung.</p></div></div><div id="game-catalog" class="view-grid"></div><nav class="subnav game-subnav" aria-label="Spiele" id="game-nav"><button type="button" data-game-target="imposter">Imposter</button><button type="button" data-game-target="detective">Detektiv</button><button type="button" data-game-target="drop">Mystery Drop</button><button type="button" data-game-target="wheel">Chaos Wheel</button><button type="button" data-game-target="vault">Community-Tresor</button><button type="button" data-game-target="pranks">Chaos &amp; Pranks</button><button type="button" data-game-target="other">Weitere Spiele</button></nav><section data-game-page="imposter" class="subpage"><div class="view-grid"></div></section><section data-game-page="detective" class="subpage"><div class="view-grid"></div></section><section data-game-page="drop" class="subpage"><div class="view-grid"></div></section><section data-game-page="wheel" class="subpage"><div class="view-grid"></div></section><section data-game-page="vault" class="subpage"><div class="view-grid">${VAULT_CARD}</div></section><section data-game-page="pranks" class="subpage"><div class="view-grid">${PRANKS_CARD}</div></section><section data-game-page="other" class="subpage"><div class="view-grid"></div></section><div id="dashboard-games" class="legacy-staging"></div></section><section class="dashboard-view" data-dashboard-view="community" id="view-community"><div class="view-header"><div><h2>Community</h2><p class="muted view-intro">Events, Fortschritt und gemeinsame Ideen.</p></div></div><nav class="subnav" aria-label="Community-Bereiche"><button type="button" data-community-target="events">Saison-Events</button><button type="button" data-community-target="xp">XP &amp; Level</button><button type="button" data-community-target="elio">Elio 🐱</button><button type="button" data-community-target="quests">Quests</button><button type="button" data-community-target="spark">Chat-Ideen</button><button type="button" data-community-target="welcome">Begrüßung</button></nav><section data-community-page="events" class="subpage"><div class="view-grid"></div></section><section data-community-page="xp" class="subpage"><div class="view-grid"></div></section><section data-community-page="elio" class="subpage"><div class="view-grid"></div></section><section data-community-page="quests" class="subpage"><div class="view-grid"></div></section><section data-community-page="spark" class="subpage"><div class="view-grid"></div></section><section data-community-page="welcome" class="subpage"><div class="view-grid"></div></section><div id="dashboard-community" class="legacy-staging"></div></section><section class="dashboard-view" data-dashboard-view="obs" id="view-obs"><div class="view-header"><div><h2>Stream-Einrichtung</h2><p class="muted view-intro">Wähle eine Anzeige und folge den Schritten bis zur Browserquelle in OBS.</p></div></div><div class="view-grid"></div><div id="dashboard-obs" class="legacy-staging"><div class="view-grid"></div></div></section><section class="dashboard-view" data-dashboard-view="settings" id="view-settings"><div class="view-header"><div><h2>Einstellungen</h2><p class="muted view-intro">Chat, Befehle und selten benötigte technische Optionen.</p></div></div><nav class="subnav" aria-label="Einstellungen"><button type="button" data-setting-target="messages">Chat &amp; Nachrichten</button><button type="button" data-setting-target="commands">Chatbefehle</button><button type="button" data-setting-target="functions">Funktionen</button><button type="button" data-setting-target="integrations">Verbindungen</button><button type="button" data-setting-target="moderation">Verwaltung</button><button type="button" data-setting-target="diagnostics">Erweitert</button></nav><section data-setting-page="messages" class="subpage"><div class="view-grid"><article class="card"><div id="automatic-chat-messages"><h3>Eigene Nachrichten</h3><p class="muted">Geplante Hinweise werden nur bei bestätigtem Live-Stream versendet.</p><form id="automatic-chat-form"><input type="hidden" name="id"><label>Titel<input name="title" maxlength="60" required placeholder="z. B. Discord-Hinweis"></label><label>Nachricht<textarea name="message" maxlength="500" required></textarea></label><label>Wiederholung<select name="interval"><option value="30">30 Minuten</option><option value="45">45 Minuten</option><option value="60">60 Minuten</option><option value="90">90 Minuten</option><option value="custom">Eigenes Intervall</option></select></label><label name="custom" hidden>Eigenes Intervall in Minuten<input name="customInterval" type="number" min="15" max="1440" value="30"></label><label><input name="enabled" type="checkbox" checked> Aktiviert</label><label><input name="activeChatOnly" type="checkbox"> Nur bei aktivem Chat</label><p id="automatic-chat-preview" class="chat-preview" aria-live="polite">【📢 INFO】 Vorschau</p><button type="submit">Nachricht speichern</button> <button type="button" name="cancel">Abbrechen</button></form><div id="automatic-chat-list"></div></div><h3>Community-Tipps</h3><div id="chat-response-settings"></div><div id="chat-identity-preview"></div></article></div></section><section data-setting-page="commands" class="subpage"><div class="view-grid"><div id="settings-commands" class="legacy-staging"></div></div></section><section data-setting-page="functions" class="subpage"><div class="view-grid"><div id="settings-functions" class="legacy-staging"></div></div></section><section data-setting-page="integrations" class="subpage"><div class="view-grid"><div id="settings-integrations" class="legacy-staging"></div></div></section><section data-setting-page="moderation" class="subpage"><div class="view-grid"><div id="settings-moderation" class="legacy-staging"></div></div></section><section data-setting-page="diagnostics" class="subpage"><div class="view-grid"><div id="settings-diagnostics" class="legacy-staging"></div></div></section><section id="dashboard-commands" class="legacy-staging"></section><section id="dashboard-settings" class="legacy-staging"></section></section></div>`;
      const integratedStructure=structure.replace('<h3>Eigene Nachrichten</h3>','<h3>Eigene geplante Nachrichten</h3>').replace('<div id="chat-identity-preview"></div>','')
        .replace('Nur bei aktivem Chat</label>','Nur bei aktivem Chat (mindestens 6 echte Chatbeiträge)</label>')
        .replace('<button type="button" data-community-target="welcome">Begrüßung</button>','<button type="button" data-community-target="welcome">Begrüßung</button><button type="button" data-community-target="vip">VIP-Erlebnis</button><button type="button" data-community-target="live-votes">Abstimmungen</button><button type="button" data-community-target="fairness">Halloween-Fairness</button><button type="button" data-community-target="music">Song-Wünsche</button><a class=\"button\" href=\"/dashboard/memories\">Erinnerungen moderieren</a>')
        .replace('<section data-community-page="welcome"','<section data-community-page="live-votes" class="subpage"><div class="view-grid"></div></section><section data-community-page="welcome"')
        .replace('<div id="dashboard-community" class="legacy-staging">','<section data-community-page="fairness" class="subpage"><div class="view-grid"><article class="card"><h3>!trickortreat – theoretische Fairness</h3><p>Die Anzeige zeigt die aktuell geladene Konfiguration. Sie ist keine Garantie für einzelne Ziehungen. Verlustereignisse können den Stand bei 0 Kürbissen nicht unter null senken.</p><div id="halloween-fairness">Wahrscheinlichkeiten werden geladen …</div></article></div></section><div id="dashboard-community" class="legacy-staging">')
        .replace('<section data-community-page="welcome"','<section data-community-page="music" class="subpage"><div class="view-grid">'+SONG_REQUESTS_CARD+'</div></section><section data-community-page="welcome"')
        .replace('<section data-community-page="welcome"','<section data-community-page="vip" class="subpage"><div class="view-grid">'+VIP_ADMIN_CARD+'</div></section><section data-community-page="welcome"');
      const page = PAGE.replace('</style>', DASHBOARD_STYLE+DASHBOARD_SIMPLICITY_STYLE+'</style>').replace('<div class="row"><div><h1>Community Bot','<header class="dashboard-top"><div><h1>Community Bot').replace('</button></div><p id="notice"','</button></header><p id="notice"').replace('<p class="muted">Hier steuerst du Chatspiele und Stream-Anzeigen. Fast alles ist optional – starte nur, was du wirklich nutzen möchtest.</p>','').replace('</p><section class="grid">', `</p>${integratedStructure}<div id="dashboard-legacy-source" class="legacy-source"><section class="grid">`).replace('</section></main>', `</section><h2>Community-Aktionen</h2><p class="muted">Community-Spiele und Aktionen</p><section class="grid">${WELCOME_CARD}${QUEST_POLL_CARD}${SPARK_CARD}${MINI_GAME_CARD}${ARCADE_CARD}${ARCADE_REWARDS_CARD}</section><h2>OBS</h2><section class="grid">${OBS_CARD}</section><h2>Einstellungen</h2><section class="grid">${CHANNEL_POINTS_CARD}${SETTINGS_CARD}</section></div></main>`)
        .replace('<script nonce="__NONCE__">', `<script nonce="__NONCE__">${DASHBOARD_POLLING_SCRIPT}`)
        .replace('</script>', `${OBS_SCRIPT}${SETTINGS_SCRIPT}${WELCOME_SCRIPT}${QUEST_POLL_SCRIPT}${SPARK_SCRIPT}${MINI_GAME_SCRIPT}${CHANNEL_POINTS_SCRIPT}${ARCADE_SCRIPT}${ARCADE_REWARDS_SCRIPT}${VAULT_SCRIPT}${PRANKS_SCRIPT}${DASHBOARD_FAIRNESS_SCRIPT}${ARCADE_SMART_CONTROLS_SCRIPT}${DASHBOARD_WORDING_SCRIPT}${DASHBOARD_STRUCTURE_SCRIPT}${DASHBOARD_CLEANUP_SCRIPT}${DASHBOARD_REMAINDER_SCRIPT}${DASHBOARD_OBS_GUARD_SCRIPT}${DASHBOARD_TIMER_SCRIPT}${CHAT_IDENTITY_PREVIEW_SCRIPT}${DASHBOARD_UX_V3_SCRIPT}${EIGHT_BALL_SETTINGS_SCRIPT}${ELIO_STATUS_SCRIPT}${DASHBOARD_APP_SCRIPT}</script>`);
      const autoScript=AUTOMATIC_CHAT_MESSAGES_SCRIPT.replace("const style=document.createElement('style');","const style=document.createElement('style');style.nonce=document.querySelector('script[nonce]')?.nonce||'';");
      const withAutomaticScript=page.replace('</script>',`${autoScript}${AUTOMATIC_CHAT_HINTS_UI_SCRIPT}${SONG_REQUESTS_SCRIPT}${VIP_ADMIN_SCRIPT}</script>`);
      const reducedPolling=withAutomaticScript
        .replaceAll('updateHome();setInterval(updateHome,12000);',"window.dashboardPoll('#home-status',updateHome,20000);")
        .replaceAll('updateDetective();updateDrop();setInterval(updateDetective,3000);setInterval(updateDrop,3000);',"window.dashboardPoll('#detective-state',updateDetective,8000);window.dashboardPoll('#drop-page-status',updateDrop,8000);")
        .replaceAll('refreshMini();loadMiniSettings();checkImposterEligibility();refreshMiniWidgetStatus();setInterval(refreshMini,3000);setInterval(refreshMiniWidgetStatus,15000);setInterval(checkImposterEligibility,3000);setInterval(miniCountdown,250);',"window.dashboardPoll('#mini-state',refreshMini,8000);window.dashboardPoll('#mini-overlay-status',refreshMiniWidgetStatus,45000);window.dashboardPoll('#mini-countdown',miniCountdown,1000);")
        .replaceAll('arcadeLoad();setInterval(arcadeLoad,5000);',"window.dashboardPoll('#arcade-state',arcadeLoad,10000);")
        .replaceAll('update();setInterval(update,3000);setInterval(()=>{const line=state.querySelector(\'[data-drop-status]\');if(line&&line.textContent.includes(\'Teilnehmende\'))update()},1000)',"window.dashboardPoll('#arcade-state',update,12000)")
        .replaceAll('refreshSpark();setInterval(refreshSpark,15000);',"window.dashboardPoll('#spark-settings',refreshSpark,30000);")
        .replaceAll('refreshChannelPoints();setInterval(refreshChannelPoints,10000);',"window.dashboardPoll('#cp-enabled',refreshChannelPoints,30000);")
        .replaceAll('refreshSongRequests();setInterval(refreshSongRequests,12000);',"window.dashboardPoll('#sr-status',refreshSongRequests,30000);")
    .replaceAll('refreshStats();setInterval(refreshStats,15000)',"window.dashboardPoll('#chat-response-settings',refreshStats,30000)")
        .replaceAll('renderCommandAdmin();setInterval(renderCommandAdmin,15000)',"window.dashboardPoll('#command-manager',renderCommandAdmin,30000)")
        .replaceAll('update();setInterval(update,15000)',"window.dashboardPoll('#dashboard-overview',update,30000)")
        .replaceAll('refresh();setInterval(refresh,15000)',"window.dashboardPoll('#dashboard-legacy-source',refresh,30000)")
        .replaceAll('refreshQuests();refreshQuestChoices();renderPolls();setInterval(()=>{refreshQuests();renderPolls()},5000);',"window.dashboardPoll('#dashboard-community',async()=>{await refreshQuests();await renderPolls()},12000);refreshQuestChoices();");
      res.end(reducedPolling.replaceAll('__CSRF__', session.csrf).replaceAll('__NONCE__', nonce)); return;
    }
    if (url.pathname.startsWith('/widgets/')) { await this.widgetRoute(url, req, res); return; }
    if (url.pathname.startsWith('/dashboard/api/')) {
      const session = this.authenticate(req, res, true); if (!session) return;
      if (req.method !== 'GET' && !this.checkCsrf(req, session)) { this.json(res, 403, { error: 'CSRF-Prüfung fehlgeschlagen.' }); return; }
      const route = url.pathname.slice('/dashboard/api/'.length);
      if(session.role==='moderator'&&!['pranks','pranks/search-user','memories','ideas','vip/status','vip/chaos','logout'].includes(route)){this.json(res,403,{error:'Für dieses Konto sind nur freigegebene Moderationsbereiche verfügbar.'});return;}
      if(session.role==='moderator'&&route==='logout'){this.sessions.delete(this.cookieSession(req)||'');this.clearCookie(res);this.json(res,200,{ok:true});return;}
      if (route === 'stream' && req.method === 'GET') {
        this.openEventStream(url, req, res, session.userId); return;
      }
      const decision = req.method === 'GET'
        ? this.rates.consume('admin-read', session.userId, 300, 60_000)
        : this.rates.consume('admin-write', session.userId, 60, 60_000);
      if (this.rejectRateLimit(res, decision, 'Zu viele Dashboard-Aktionen. Bitte kurz warten.')) return;
      await this.api(url, req, res, session); return;
    }
    if (url.pathname === '/healthz' && req.method === 'GET') { this.json(res, 200, { ok: true }); return; }
    this.json(res, 404, { error: 'Nicht gefunden.' });
  }

  private async widgetRoute(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET') { this.json(res, 405, { error: 'Widgets sind nur lesend.' }); return; }
    const page = /^\/widgets\/(quest|poll|imposter|detective|pet|drop|wheel|vault)$/u.exec(url.pathname);
    const api = /^\/widgets\/api\/(quest|poll|imposter|detective|pet|drop|wheel|vault)$/u.exec(url.pathname);
    const stream = /^\/widgets\/stream\/(quest|poll|imposter|detective|pet|drop|wheel|vault)$/u.exec(url.pathname);
    if (!page && !api && !stream) { this.json(res, 404, { error: 'Nicht gefunden.' }); return; }
    const type = (page?.[1] || api?.[1] || stream?.[1]) as WidgetType;
    const token = url.searchParams.get('token') || '';
    if (!/^[A-Za-z0-9_-]{40,100}$/u.test(token)) { this.json(res, 404, { error: 'Widget nicht verfügbar.' }); return; }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (!this.store.widgetTokenValid(type, tokenHash, Date.now())) { this.json(res, 404, { error: 'Widget nicht verfügbar.' }); return; }
    if (!stream && this.rejectRateLimit(res, this.rates.consume('widget-read', `${type}:${tokenHash}`, 240, 60_000), 'OBS-Widget wird zu häufig abgefragt. Bitte kurz warten.')) return;
    if (page) {
      const nonce = randomBytes(18).toString('base64');
      const settings = this.store.config('widget_settings', defaultWidgetSettings());
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const widgetCacheScript=`<script nonce="${nonce}">(()=>{const original=window.fetch.bind(window),cache=new Map(),flights=new Map(),retry=new Map();window.fetch=async(input,init={})=>{const method=(init.method||'GET').toUpperCase(),url=new URL(typeof input==='string'?input:input.url,location.href);if(method!=='GET'||url.origin!==location.origin||!url.pathname.startsWith('/widgets/api/'))return original(input,init);const key=url.href,now=Date.now();if((retry.get(key)||0)>now)return new Response(JSON.stringify({error:'Kurz pausiert'}),{status:429,headers:{'Retry-After':String(Math.ceil((retry.get(key)-now)/1000)),'Content-Type':'application/json'}});const hit=cache.get(key);if(hit&&now-hit.at<10000)return hit.response.clone();if(flights.has(key))return(await flights.get(key)).clone();const task=(async()=>{const r=await original(input,init);if(r.status===429){const s=Math.min(60,Math.max(1,Number(r.headers.get('Retry-After'))||5));retry.set(key,Date.now()+s*1000)}else if(r.ok)cache.set(key,{at:Date.now(),response:r.clone()});return r})();flights.set(key,task);try{return(await task).clone()}finally{flights.delete(key)}}})()</script>`;
      res.end(communityWidgetHtml(type, nonce, settings.fontSize, settings.theme).replace('</head>',`${widgetCacheScript}</head>`));
      return;
    }
    if (api) { this.json(res, 200, this.widgetSnapshot(type)); return; }
    this.openWidgetEventStream(type, tokenHash, res);
  }

  private openWidgetEventStream(type: WidgetType, tokenHash: string, res: http.ServerResponse): void {
    const forToken = [...this.widgetStreams.values()].filter((stream) => stream.tokenHash === tokenHash).length;
    if (forToken >= 4 || this.widgetStreams.size >= 50) {
      setRateLimitHeaders(res, 10); this.json(res, 429, { error: 'Zu viele OBS-Verbindungen für dieses Widget.', retryAfterSeconds: 10 }); return;
    }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    let previous = '';
    const send = () => {
      try {
        const snapshot = this.widgetSnapshot(type);
        const fingerprint = JSON.stringify({ ...snapshot, capturedAt: undefined });
        if (fingerprint !== previous) {
          res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          previous = fingerprint;
        } else res.write(': keepalive\n\n');
      } catch { res.end(); }
    };
    send();
    const timer = setInterval(send, 2500);
    this.widgetStreams.set(res, { timer, tokenHash });
    res.on('close', () => { clearInterval(timer); this.widgetStreams.delete(res); });
  }

  private widgetSnapshot(type: WidgetType): Record<string, unknown> {
    const snapshot=this.store.widgetSnapshot(type, Date.now());
    if(type==='wheel'&&this.arcade){
      const arcade=this.arcade;
      const now=Date.now();
      const spin=this.store.miniGameQuery(db=>db.prepare("SELECT s.id,s.challenge_id challengeId,s.title,s.status,s.created_at createdAt,s.resolved_at resolvedAt,s.action_type actionType,s.wheel_key wheelKey,s.wheel_fields_json wheelFieldsJson,s.winner_name winnerName,s.result_label resultLabel,s.reward_status rewardStatus FROM chaos_wheel_spins s WHERE s.status IN ('active','completed','canceled') ORDER BY s.created_at DESC LIMIT 1").get() as {id:string;challengeId:string;title:string;status:string;createdAt:number;resolvedAt:number|null;actionType:string;wheelKey:string|null;wheelFieldsJson:string|null;winnerName:string|null;resultLabel:string|null;rewardStatus:string}|undefined);
      const status=arcade.wheelStatus(now) as {entries?:Array<{id:string;title:string;weight:number;wheelKey:string|null}>;taskEntries?:Array<{id:string;title:string;weight:number;wheelKey:string|null}>};
      const recent=spin&&now-(spin.resolvedAt??spin.createdAt)<15_000;
      let fields=[...(status.entries||[]),...(status.taskEntries||[])];
      if(spin?.wheelFieldsJson){try{const saved=JSON.parse(spin.wheelFieldsJson) as unknown;if(Array.isArray(saved))fields=saved.filter((field):field is {id:string;title:string;weight:number;wheelKey:string|null}=>Boolean(field)&&typeof field==='object'&&typeof (field as {id?:unknown}).id==='string'&&typeof (field as {title?:unknown}).title==='string'&&Number.isInteger((field as {weight?:unknown}).weight)&&(field as {weight:number}).weight>0);}catch{}}
      return {type,visible:Boolean(spin&&arcade.settings().wheelEnabled&&((spin.status==='active')||recent)),wheel:spin?{id:spin.id,title:spin.title,status:spin.status,createdAt:spin.createdAt,resolvedAt:spin.resolvedAt,actionType:spin.actionType,wheelKey:spin.wheelKey,
        ...(arcade.settings().wheelWinnerOverlay?{winnerName:spin.winnerName,resultLabel:spin.resultLabel,rewardStatus:spin.rewardStatus}:{}),
        fields:fields.map(({id,title,weight,wheelKey})=>({id,title,weight,wheelKey})),
        selectedKey:spin.challengeId}:null};
    }
    if(type==='pet'&&this.moderatorPranks){const prank=this.moderatorPranks.snapshot().active as {kind?:string;remainingMs?:number}|null;
      return {...snapshot,prank:prank&&['chief','vault-alarm'].includes(prank.kind||'')?{kind:prank.kind,remainingMs:prank.remainingMs}:null};}
    return snapshot;
  }

  private login(res: http.ServerResponse): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.states) if (expiresAt <= now) this.states.delete(key);
    const state = randomBytes(24).toString('hex');
    this.states.set(state, now + 10 * 60_000);
    const auth = new URL('https://id.twitch.tv/oauth2/authorize');
    auth.searchParams.set('client_id', this.clientId); auth.searchParams.set('redirect_uri', this.redirectUri);
    auth.searchParams.set('response_type', 'code'); auth.searchParams.set('scope', ''); auth.searchParams.set('state', state);
    res.statusCode = 302; res.setHeader('Set-Cookie', `dashboard_oauth_state=${state}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    res.setHeader('Location', auth.toString()); res.end();
  }

  private async callback(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.viewerPortal && await this.viewerPortal.handleOAuthCallback(url,req,res)) return;
    const state = url.searchParams.get('state') || '', expires = this.states.get(state) || 0;
    this.states.delete(state);
    if (!state || expires < Date.now() || this.cookieValue('dashboard_oauth_state', req) !== state) {
      res.setHeader('Set-Cookie', 'dashboard_oauth_state=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      this.json(res, 400, { error: 'OAuth-State ungültig oder abgelaufen.' }); return;
    }
    res.setHeader('Set-Cookie', 'dashboard_oauth_state=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    if (url.searchParams.has('error')) { this.json(res, 400, { error: 'Twitch-Anmeldung wurde abgebrochen.' }); return; }
    const code = url.searchParams.get('code'); if (!code) { this.json(res, 400, { error: 'OAuth-Code fehlt.' }); return; }
    const tokenResponse = await this.fetchImpl('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code, grant_type: 'authorization_code', redirect_uri: this.redirectUri }) });
    if (!tokenResponse.ok) { this.json(res, 401, { error: 'Twitch-Anmeldung konnte nicht bestätigt werden.' }); return; }
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) { this.json(res, 401, { error: 'Twitch hat kein gültiges Token geliefert.' }); return; }
    const validatedResponse = await this.fetchImpl('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token.access_token}` } });
    if (!validatedResponse.ok) { this.json(res, 401, { error: 'Twitch-Token ist ungültig.' }); return; }
    const validated = await validatedResponse.json() as TokenValidation;
    const role:Session['role']=this.adminIds.has(validated.user_id)?'admin':'moderator';
    if (validated.client_id !== this.clientId || (role==='moderator'&&!this.moderatorIds.has(validated.user_id))) { this.json(res, 403, { error: 'Dieses Twitch-Konto ist nicht für die Administration freigeschaltet.' }); return; }
    const userResponse = await this.fetchImpl('https://api.twitch.tv/helix/users', { headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok) { this.json(res, 401, { error: 'Twitch-Profil konnte nicht verifiziert werden.' }); return; }
    const userPayload = await userResponse.json() as { data?: HelixUser[] };
    const user = userPayload.data?.[0];
    if (!user || user.id !== validated.user_id) { this.json(res, 401, { error: 'Twitch-Identität stimmt nicht überein.' }); return; }
    for (const [sessionKey, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(sessionKey);
    const key = randomBytes(32).toString('hex');
    this.sessions.set(key, { userId: user.id, login: user.login, csrf: randomBytes(24).toString('hex'), expiresAt: Date.now() + SESSION_TTL_MS, role });
    res.setHeader('Set-Cookie', [
      'dashboard_oauth_state=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      `community_admin=${key}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    ]);
    res.statusCode = 303; res.setHeader('Location', '/dashboard'); res.end();
  }

  private participantLogin(res: http.ServerResponse): void {
    if (!this.miniGames) { this.json(res, 503, { error: 'Spielteilnehmer-Login ist nicht verfügbar.' }); return; }
    const state = randomBytes(24).toString('hex'), now=Date.now();
    this.store.createViewerOAuthState(createHash('sha256').update(state).digest('hex'),now+10*60_000,now);
    const auth = new URL('https://id.twitch.tv/oauth2/authorize');
    auth.searchParams.set('client_id', this.clientId);
    auth.searchParams.set('redirect_uri', new URL('/games/imposter/callback', new URL(this.redirectUri).origin).toString());
    auth.searchParams.set('response_type', 'code'); auth.searchParams.set('scope', ''); auth.searchParams.set('state', state);
    res.statusCode = 302; res.setHeader('Set-Cookie', `imposter_oauth_state=${state}; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    res.setHeader('Location', auth.toString()); res.end();
  }

  private async participantCallback(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const state = url.searchParams.get('state') || '', stateHash=state?createHash('sha256').update(state).digest('hex'):'';
    const clear = 'imposter_oauth_state=; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    if (!state || this.cookieValue('imposter_oauth_state', req) !== state || !this.store.consumeViewerOAuthState(stateHash,Date.now())) { res.setHeader('Set-Cookie', clear); this.participantLoginError(res,'Die Anmeldung ist abgelaufen oder wurde in einem anderen Browserfenster gestartet. Bitte starte den Twitch-Login erneut.'); return; }
    if (url.searchParams.has('error')) { res.setHeader('Set-Cookie', clear); this.participantLoginError(res,'Du hast die Twitch-Anmeldung abgebrochen. Du kannst es jederzeit erneut versuchen.'); return; }
    if(!url.searchParams.get('code')){res.setHeader('Set-Cookie',clear);this.participantLoginError(res,'Twitch hat keinen Anmeldecode geliefert. Bitte starte den Login erneut.');return;}
    const redirectUri = new URL('/games/imposter/callback', new URL(this.redirectUri).origin).toString();
    const tokenResponse = await this.fetchImpl('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code: url.searchParams.get('code') || '', grant_type: 'authorization_code', redirect_uri: redirectUri }) });
    if (!tokenResponse.ok) { res.setHeader('Set-Cookie', clear); this.participantLoginError(res,'Twitch konnte die Anmeldung nicht bestätigen. Bitte versuche es erneut.'); return; }
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) { res.setHeader('Set-Cookie', clear); this.participantLoginError(res,'Twitch hat keine gültige Anmeldung zurückgegeben. Bitte versuche es erneut.'); return; }
    const validation = await this.fetchImpl('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token.access_token}` } });
    if (!validation.ok) { res.setHeader('Set-Cookie', clear); this.participantLoginError(res,'Deine Twitch-Anmeldung ist nicht mehr gültig. Bitte melde dich erneut an.'); return; }
    const identity = await validation.json() as TokenValidation;
    const role = this.miniGames?.roleFor(identity.user_id);
    if (identity.client_id !== this.clientId || !identity.user_id) { res.setHeader('Set-Cookie', clear); this.participantLoginError(res,'Twitch hat dein Konto nicht bestätigt. Bitte versuche es erneut.'); return; }
    if (!role) { res.setHeader('Set-Cookie', clear); this.participantLoginError(res,'Für dein Twitch-Konto wurde keine aktive Spielrolle gefunden. Prüfe, ob du der laufenden Runde beigetreten bist.',403); return; }
    const session = randomBytes(32).toString('base64url'),now=Date.now(),csrf=randomBytes(32).toString('base64url');
    this.store.createViewerSession({sessionHash:createHash('sha256').update(session).digest('hex'),userId:identity.user_id,login:'twitch-user',displayName:'Twitch-Mitglied',profileImageUrl:null,csrfToken:csrf,createdAt:now,expiresAt:now+60*60_000});
    res.setHeader('Set-Cookie', [clear, `imposter_participant=${session}; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`]);
    res.statusCode = 303; res.setHeader('Location', '/games/imposter/role'); res.end();
  }

  private participantRole(req: http.IncomingMessage, res: http.ServerResponse): void {
    const key = this.cookieValue('imposter_participant', req), session = key ? this.store.viewerSession(createHash('sha256').update(key).digest('hex'),Date.now()) : undefined;
    const role = session ? this.miniGames?.roleFor(session.userId) : undefined;
    res.setHeader('Cache-Control', 'no-store');res.setHeader('Referrer-Policy','no-referrer');
    if (!session) { res.statusCode = 303; res.setHeader('Location', '/games/imposter/login'); res.end(); return; }
    if (!role) {res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(this.participantPage('Noch keine aktive Rolle','Du bist angemeldet, aber für dein Konto gibt es gerade keine aktive Rolle. Tritt der offenen Runde im Community-Portal bei oder warte, bis die Rollen verteilt sind.'));return;}
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const message = role.role === 'imposter' ? 'Du bist der IMPOSTER! Beobachte den Chat und versuche, nicht aufzufallen.' : `Deine geheime Spielregel lautet: ${role.rule || ''}`;
    res.end(this.participantPage('Deine geheime Rolle',`${message} Bitte teile diesen Bildschirm nicht und veröffentliche deine Rolle nicht im Chat. Der aktuelle Imposter-Modus spielt mit einer geheimen Regel: Die Mitspielenden versuchen, sie im Chat einzuhalten, während der Imposter sie herausfinden muss. Die Spielphase und nächste Anweisung siehst du im Community-Portal.`)); return;
  }

  private participantLoginError(res:http.ServerResponse,message:string,status=400):void {res.statusCode=status;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(this.participantPage('Twitch-Anmeldung nicht abgeschlossen',`${message} <a href="/games/imposter/login">Erneut mit Twitch anmelden</a> · <a href="/community/imposter">Zur Imposter-Runde</a>`));}
  private participantPage(title:string,message:string):string{return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;background:#11131b;color:#f5f2fa;margin:0;padding:clamp(1rem,5vw,4rem)}main{max-width:42rem;margin:8vh auto;background:#1b1b27;border:1px solid #454052;border-radius:1.25rem;padding:clamp(1.25rem,5vw,2.5rem)}h1{color:#d8b9ff}a{color:#d8b9ff}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;}

  private async api(url: URL, req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
    const route = url.pathname.slice('/dashboard/api/'.length);
    const now = Date.now();
    if(route==='discord'&&req.method==='GET'){
      if(session.role!=='admin'){this.json(res,403,{error:'Nur Jannik kann die Discord-Verbindung einsehen.'});return;}
      const settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      const lastSeen=this.store.state<{at:number}|null>('discord_integration_last_seen',null)?.at??null;
      this.json(res,200,{settings:{...DISCORD_DEFAULTS,...settings},outbox:this.store.discordOutboxStats(),failures:this.store.discordOutboxFailures(),serviceConfigured:this.discordIntegrationSecret.length>=32,connection:{connected:Boolean(lastSeen&&Date.now()-lastSeen<60_000),lastSeen}});return;
    }
    if(route==='discord/settings'&&req.method==='POST'){
      if(session.role!=='admin'){this.json(res,403,{error:'Nur Jannik kann die Discord-Verbindung konfigurieren.'});return;}
      const body=await this.readJson(req);if(!body){this.json(res,400,{error:'Ungültige Einstellungen.'});return;}
      const next={...DISCORD_DEFAULTS};
      for(const key of ['enabled','accountLinkEnabled','elioEnabled','discordDropsEnabled','notifyIdeas','notifyLevels','notifyDrops','notifyQuests','notifySeasonal','notifyLive'] as const){if(typeof body[key]!=='boolean'){this.json(res,400,{error:'Bitte alle Schalter gültig setzen.'});return;}next[key]=body[key];}
      for(const key of ['ideasChannelId','rewardsChannelId','liveChannelId','dropChannelId'] as const){const value=String(body[key]??'').trim();if(value&&!/^\d{17,20}$/u.test(value)){this.json(res,400,{error:'Eine Kanal-ID ist ungültig.'});return;}next[key]=value;}
      const rewardEnabled=next.notifyLevels||next.notifyDrops||next.notifyQuests||next.notifySeasonal;
      if(next.enabled&&(this.discordIntegrationSecret.length<32||(next.notifyIdeas&&!next.ideasChannelId)||(rewardEnabled&&!next.rewardsChannelId)||(next.notifyLive&&!next.liveChannelId)||(next.elioEnabled&&!next.accountLinkEnabled)||(next.discordDropsEnabled&&(!next.dropChannelId||!next.accountLinkEnabled)))){this.json(res,409,{error:'Für die Aktivierung fehlen noch ein sicherer Integrationsschlüssel oder ein Zielkanal für einen aktivierten Hinweis.'});return;}
      this.store.setConfig('discord_integration',next);this.audit(session,'discord-settings','integration',{enabled:next.enabled,configuredChannels:[next.ideasChannelId,next.rewardsChannelId,next.liveChannelId,next.dropChannelId].filter(Boolean).length},now);
      this.json(res,200,{ok:true,settings:next});return;
    }
    if(route==='discord/retry'&&req.method==='POST'){
      if(session.role!=='admin'){this.json(res,403,{error:'Nur Jannik kann fehlgeschlagene Zustellungen erneut anstoßen.'});return;}
      const body=await this.readJson(req);const id=typeof body?.id==='string'?body.id:'';
      if(!/^[a-f0-9-]{36}$/iu.test(id)||!this.store.retryDiscordOutbox(id,now)){this.json(res,409,{error:'Diese Zustellung ist nicht mehr erneut startbar.'});return;}
      this.audit(session,'discord-delivery-retry',id,{},now);this.json(res,200,{ok:true});return;
    }
    if(route==='vip/status'&&req.method==='GET'){
      let verification:unknown={state:'unavailable',authorized:false,scopeGranted:false,checkedAt:null};try{if(this.vipService)verification=await this.vipService.status();}catch{}
      let authorizationUrl='';try{authorizationUrl=this.vipAuthorizationUrl?.()||'';}catch{}
      this.json(res,200,{settings:this.vipExperience?.settings()||null,verification,authorizationUrl,requests:this.vipExperience?.pendingRequests()||[],challenges:this.vipExperience?.challengeRows()||[]});return;
    }
    if(route==='eight-ball'&&req.method==='GET'){
      const modules=this.store.config<Record<string,boolean>>('modules',{}),saved=this.store.config<Partial<typeof DEFAULT_EIGHT_BALL_SETTINGS>>('eight_ball_settings',{});
      const last=this.store.state<{answer:string;at:number}|null>('eight_ball_last_reply',null);
      this.json(res,200,{enabled:modules.eightBall!==false,settings:{...DEFAULT_EIGHT_BALL_SETTINGS,...saved},distribution:{yes:40,no:40,maybe:20},lastUsedAt:last?.at??null});return;
    }
    if(route==='eight-ball/preview'&&req.method==='GET'){
      const answer=chooseEightBallAnswer('Wird Jannik heute gewinnen?',randomInt(1,100),randomInt(0,11));
      this.json(res,200,{answer:answer.answer,outcome:answer.outcome,preview:true});return;
    }
    if(route==='pranks/search-user'&&req.method==='GET'){
      const login=(url.searchParams.get('q')||'').trim().replace(/^@/u,'').toLowerCase();if(!/^[a-z0-9_]{1,25}$/u.test(login)){this.json(res,400,{error:'Bitte einen gültigen Twitch-Namen eingeben.'});return;}
      try{const user=await this.lookupPrankUser?.(login);this.json(res,200,{user:user?{id:user.id,login:user.login,displayName:user.displayName}:null});}catch{this.json(res,502,{error:'Twitch-Nutzersuche ist gerade nicht erreichbar.'});}return;
    }
    if(route==='pranks'&&req.method==='GET'){if(!this.moderatorPranks){this.json(res,503,{error:'Prank-Steuerung ist nicht verfügbar.'});return;}this.json(res,200,this.moderatorPranks.snapshot());return;}
    if(route==='pranks'&&req.method==='POST'){
      if(!this.moderatorPranks){this.json(res,503,{error:'Prank-Steuerung ist nicht verfügbar.'});return;}
      const body=await this.readJson(req);if(!body){this.json(res,400,{error:'Ungültiger JSON-Body.'});return;}
      if(body.action==='settings'){try{this.moderatorPranks.configure(body.settings);this.json(res,200,{ok:true});}catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Einstellungen ungültig.'});}return;}
      if(body.action==='end'){const ended=this.moderatorPranks.end();this.audit(session,'prank-end','active',{},Date.now());this.json(res,200,{ended});return;}
      if(body.action==='start'){
        const kind=body.kind as PrankKind;if(!['chief','accusation','vault-alarm','oracle'].includes(kind)){this.json(res,400,{error:'Prank ungültig.'});return;}
        let target: {id:string;name:string}|undefined;
        if(kind==='accusation'){
          const requested=body.target&&typeof body.target==='object'?body.target as {id?:unknown;login?:unknown}:{};
          if(typeof requested.login!=='string'||!/^[a-z0-9_]{1,25}$/iu.test(requested.login)){this.json(res,400,{error:'Twitch-Ziel bitte erneut prüfen.'});return;}
          const looked=await this.lookupPrankUser?.(requested.login.toLowerCase());if(!looked||looked.id!==requested.id){this.json(res,400,{error:'Twitch-Ziel konnte nicht bestätigt werden.'});return;}target={id:looked.id,name:looked.displayName};
        }
        const result=this.moderatorPranks.start(kind,session.userId,Date.now(),target);if(result.ok){this.audit(session,'prank-start',kind,{},Date.now());if(result.announcement)try{await this.sendToChat?.(result.announcement,'pet');}catch{/* The phase ends automatically even if a chat announcement fails. */}}
        this.json(res,result.ok?200:409,result);return;
      }
      this.json(res,400,{error:'Aktion ungültig.'});return;
    }
    if(route==='fairness'&&req.method==='GET'){
      const w=this.halloweenOdds?.weights||{TREAT:48,TRICK:25,JACKPOT:5,GHOST:8,WITCH:8,EMPTY_HOUSE:5,GOLDEN_PUMPKIN:1};const total=Object.values(w).reduce((a,b)=>a+b,0);
      this.json(res,200,{weights:w,total,source:this.halloweenOdds?.source||'Standardwerte aus src/config.ts',historyAvailable:false,shares:{positive:100*((w.TREAT+w.JACKPOT+w.WITCH+w.GOLDEN_PUMPKIN)/total),negative:100*((w.TRICK+w.GHOST)/total),neutral:100*(w.EMPTY_HOUSE/total)}});return;
    }
    if(route==='bot-lifecycle'&&req.method==='GET'){
      const lifecycle=this.botLifecycle;
      const settings=lifecycle?.settings()??{enabled:false,lastPlannedAt:0};
      const marker=lifecycle?.marker()??null;
      const cooldownUntil=settings.lastPlannedAt?settings.lastPlannedAt+BOT_RESTART_COOLDOWN_MS:null;
      const markerActive=Boolean(marker&&['armed','shutting-down','awaiting-return','returning'].includes(marker.phase)&&Date.now()-marker.plannedAt<BOT_RESTART_MARKER_TTL_MS);
      this.json(res,200,{enabled:settings.enabled,marker,cooldownUntil,canPrepare:Boolean(settings.enabled&&(!cooldownUntil||cooldownUntil<=Date.now())&&!markerActive)});return;
    }
    if (route === 'overview' && req.method === 'GET') { this.json(res, 200, { admin: { login: session.login }, status: { ...this.store.overview(), ...this.getStatus() } }); return; }
    if (route === 'status' && req.method === 'GET') { const runtime=this.getStatus();this.json(res,200,{dashboardResponding:true,eventSubSocket:runtime.twitchConnected,chatReceive:runtime.lastChatReceiveAt?'confirmed':'unknown',lastChatReceiveAt:runtime.lastChatReceiveAt??null,botChatSend:runtime.lastBotChatSendAt?'confirmed':'unknown',lastBotChatSendAt:runtime.lastBotChatSendAt??null,lastBotChatSendErrorAt:runtime.lastBotChatSendErrorAt??null,broadcasterOAuth:this.channelPoints?(this.channelPoints.connected()?'connected':'disconnected'):'unknown',errorPresent:Boolean(runtime.lastError),channel:runtime.channel,chatQueue:runtime.queued??0,chatSuppressed:(runtime.suppressed??0)+(runtime.chatResponse?.suppressed??0),chatDeferred:runtime.chatResponse?.deferred??0});return; }
    if (route === 'streamer-state' && req.method === 'GET') { const runtime=this.getStatus(),now=Date.now(),checked=runtime.streamStatusCheckedAt||0,fresh=Boolean(checked&&now-checked<=90_000),status=fresh?runtime.streamLive===true?'live':runtime.streamLive===false?'offline':'unknown':checked?'stale':'unknown',guess=this.store.state<{expiresAt:number}|null>('guess',null),stream=runtime.streamSnapshot;this.json(res,200,{guess:guess&&guess.expiresAt>now?guess:null,guessEnabled:this.store.config<Record<string,boolean>>('modules',{}).guess!==false,stream:{status,checkedAt:checked||null,details:status==='live'&&stream?{title:stream.title||'',gameName:stream.gameName||'',viewerCount:stream.viewerCount,startedAt:stream.startedAt||''}:null},chat:{receiveAt:runtime.lastChatReceiveAt||null,sendAt:runtime.lastBotChatSendAt||null,sendErrorAt:runtime.lastBotChatSendErrorAt||null}});return; }
    if (route === 'chat-messages' && req.method === 'GET') {
      const policy=this.chatPolicy??new ChatResponsePolicy(this.store.config('chat_response_settings',DEFAULT_CHAT_RESPONSE_SETTINGS));
      const runtime=this.getStatus(),snapshot=policy.snapshot(),now=Date.now();
      const profile=snapshot.profile;
      const streamLive=runtime.streamStatusCheckedAt&&now-runtime.streamStatusCheckedAt<120_000?runtime.streamLive:undefined;
      const availability:HelpAvailability&{communityPortal?:boolean}={...this.publicHelpAvailability(),communityPortal:false};
      if(this.communityTips?.settings().portalEnabled&&this.checkPortalHealth)try{availability.communityPortal=await this.checkPortalHealth();}catch{availability.communityPortal=false;}
      const tips=this.communityTips?.status(profile,now,availability),tipPreviews=this.communityTips?.preview(availability)??[];
      const categories=this.communityTips?.categoryCatalog(availability)??[];
      const automatic=this.automaticChatMessages?.list(now)??[],global=this.automaticChatMessages?.globalStatus(now);
      const busyReason=this.chatHintBusyReason(now,runtime);
      const ownEnabled=automatic.some(message=>message.enabled),anyDue=Boolean(this.automaticChatMessages?.nextDue(now,this.communityTips?.eligibleActivityMessages??0,Boolean(busyReason),streamLive));
      const reason=!this.communityTips?.settings().enabled&&!ownEnabled?'Automatische Hinweise sind ausgeschaltet.'
        :streamLive===false?'Jannik ist offline.'
        :streamLive!==true?'Live-Status noch nicht bestätigt.'
        :busyReason||(global?.canSend===false?(global.sentThisHour>=global.hourlyLimit?'Nachrichtenlimit für diese Stunde erreicht.':'Kurze Pause zwischen automatischen Nachrichten.')
        :((tips?.enabled&&tips.activityMessages<tips.requiredMessages)||automatic.some(message=>message.enabled&&message.activeChatOnly&&message.nextEarliestAt<=now&&(this.communityTips?.eligibleActivityMessages??0)<AUTO_CHAT_ACTIVITY_THRESHOLD))?'Warten auf genügend Chat-Aktivität.'
        :!anyDue&&automatic.some(message=>message.enabled&&message.nextEarliestAt>now)?'Warten auf das nächste Nachrichtenintervall.'
        :!tipPreviews.length&&!anyDue?'Keine passende Community-Funktion ist derzeit verfügbar.':'Wartet auf den nächsten passenden Versandzeitpunkt.');
      const latestTipState=this.communityTips?.state();
      let lastMessage=latestTipState?.lastDeliveredAt&&latestTipState.lastDeliveredText?{text:formatPublicChatMessage(latestTipState.lastDeliveredText,'tip'),at:latestTipState.lastDeliveredAt,category:latestTipState.lastDeliveredCategory||'Community-Tipp'}:undefined;
      for(const message of automatic)if(message.lastSentAt&&(!lastMessage||message.lastSentAt>lastMessage.at))lastMessage={text:formatPublicChatMessage(message.message,'info'),at:message.lastSentAt,category:'Eigene Nachricht'};
      const spacingMs=profile==='calm'?45*60_000:profile==='lively'?20*60_000:30*60_000;
      const possibleTimes=[tips?.nextEarliestAt,global?.nextEarliestAt,...automatic.filter(message=>message.enabled).map(message=>message.nextEarliestAt)].filter((at):at is number=>typeof at==='number'&&at>now);
      const dueOwn=automatic.find(message=>message.enabled&&message.nextEarliestAt<=now&&(!message.activeChatOnly||(this.communityTips?.eligibleActivityMessages??0)>=6));
      const nextCandidate=dueOwn?{kind:'Eigene Nachricht',title:dueOwn.title,text:formatPublicChatMessage(dueOwn.message,'info')}
        :tipPreviews[0]?{kind:'Community-Tipp',title:'Eine verfügbare Community-Funktion',text:formatPublicChatMessage(tipPreviews[0].text,'tip')}
        :automatic.filter(message=>message.enabled).sort((a,b)=>a.nextEarliestAt-b.nextEarliestAt).map(message=>({kind:'Eigene Nachricht',title:message.title,text:formatPublicChatMessage(message.message,'info')}))[0]??null;
      this.json(res,200,{...snapshot,suppressed:snapshot.suppressed+(runtime.suppressed??0),queued:runtime.queued??0,
        communityTips:tips,tipPreviews,categories,automaticChat:{global,reason,lastMessage:lastMessage??null,nextCandidate,
          nextEarliestAt:possibleTimes.length?Math.min(...possibleTimes):null,streamLive,
          streamStatusCheckedAt:runtime.streamStatusCheckedAt,profileSpacingMs:spacingMs}});return;
    }
    if(route==='automatic-messages'&&req.method==='GET'){
      const messages=this.automaticChatMessages?.list()??[];
      this.json(res,200,{messages:messages.map(message=>({...message,preview:formatPublicChatMessage(message.message,'info')})),minIntervalMinutes:15});return;
    }
    if (route === 'widgets/status' && req.method === 'GET') { const types: WidgetType[]=['quest','poll','imposter','detective','pet','drop','wheel','vault'];this.json(res,200,{widgets:Object.fromEntries(types.map(type=>[type,this.store.widgetTokenConfigured(type,Date.now())]))});return; }
    if (route === 'welcome' && req.method === 'GET') { this.json(res,200,this.store.config('first_chat_welcome',{enabled:false,message:'Willkommen im Chat, {user}! 🎮 Schreib !help, wenn du die Community-Befehle sehen möchtest.'})); return; }
    if (route === 'spark' && req.method === 'GET') {
      const settings = normalizeSparkConfig(this.store.config<unknown>('spark_settings',DEFAULT_SPARK_CONFIG));
      this.json(res, 200, { settings, topics: this.getSparkSnapshot?.() ?? [], pending: this.store.sparkProposals('pending_approval',100).length, proposals: this.store.sparkProposals('all',50), customTopics: this.store.config('spark_topics',[]), cooldowns: [] }); return;
    }
    if (route === 'minigames' && req.method === 'GET') { this.json(res, 200, this.miniGames?{ settings:this.miniGames.settings(), state:this.miniGames.snapshot(), quotes:this.miniGames.managedQuotes() }:{settings:{enabled:false},state:{imposter:null,detective:null},quotes:[]}); return; }
    if (route === 'channel-points' && req.method === 'GET') { this.json(res, 200, this.channelPoints
      ? { available:true, settings:this.channelPoints.settings(), connected:this.channelPoints.connected(), message:this.channelPoints.oauthStatusMessage, redemptions:this.store.channelRedemptions(100) }
      : { available:false, settings:DEFAULT_CHANNEL_POINTS_SETTINGS, connected:false, message:'Diese optionale Twitch-Kanalpunkte-Verbindung ist hier nicht eingerichtet.', redemptions:[] }); return; }
    if(route==='song-requests'&&req.method==='GET'){this.json(res,200,this.songRequests?{available:true,settings:this.songRequests.settings(),spotifyConnected:this.songRequests.connected(),broadcasterConnected:this.songRequests.broadcasterConnected(),message:this.songRequests.statusMessage(),requests:this.songRequests.list()}
      :{available:false,settings:{enabled:false},spotifyConnected:false,broadcasterConnected:false,message:'Song-Wünsche sind nicht eingerichtet.',requests:[]});return;}
    if (route === 'vault' && req.method === 'GET' && !this.vault) { this.json(res,200,{settings:{enabled:false},snapshot:{vault:null},readiness:{canStart:false,reason:'Community-Tresor ist hier nicht eingerichtet.'}});return; }
    if (route === 'vault' && req.method === 'GET' && this.vault) {
      const settings=this.vault.settings(),snapshot=this.vault.publicSnapshot(now),runtime=this.getStatus();
      const state=snapshot.vault as {status?:string}|undefined;
      const streamFresh=Boolean(runtime.streamStatusCheckedAt&&now-runtime.streamStatusCheckedAt<120_000);
      const streamLive=streamFresh?runtime.streamLive:undefined;
      const mini=this.miniGames?.snapshot()||{},drop=this.arcade?.snapshot('drop') as {drop?:{status?:string}}|undefined,wheel=this.arcade?.wheelStatus() as {active?:boolean}|undefined;
      const dropStatus=drop?.drop?.status;
      const busy=Boolean(mini.imposter||mini.detective||this.store.activeQuest()||this.store.activePoll(now)||this.store.activeBoss(now)
        ||['announced','claiming','resolving'].includes(dropStatus||'')||wheel?.active);
      let reason='Livestatus wird beim Start geprüft.';
      let canStart=true;
      if(!settings.enabled){reason='Tresor-Funktion ist ausgeschaltet.';canStart=false;}
      else if(!this.sendToChat){reason='Chatversand ist derzeit nicht verfügbar.';canStart=false;}
      else if(state?.status==='active'){reason='⏳ Der Tresor läuft bereits.';canStart=false;}
      else if(this.vault.cooldownRemainingMs(now)>0){reason=`⏳ Wartezeit: noch ${Math.ceil(this.vault.cooldownRemainingMs(now)/60_000)} Min.`;canStart=false;}
      else if(streamLive===false){reason='📴 Der Twitch-Stream ist derzeit offline.';canStart=false;}
      else if(this.vault.activeViewerCount(now)<settings.minActiveViewers){reason=`⏳ Benötigt ${settings.minActiveViewers} aktive Zuschauer; aktuell ${this.vault.activeViewerCount(now)}.`;canStart=false;}
      else if(busy){reason='⏳ Ein anderes Community-Spiel läuft gerade.';canStart=false;}
      else if(streamLive===true){reason='Startklar · Stream und aktive Zuschauer bestätigt.';}
      this.json(res,200,{settings,snapshot,readiness:{canStart,reason,streamLive:streamLive??null,streamFresh,activeViewers:this.vault.activeViewerCount(now)}});return;
    }
    if (route === 'arcade' && req.method === 'GET') { this.json(res,200,this.arcade?{settings:this.arcade.settings(),pet:this.arcade.pet(),petEvents:this.arcade.petActivity(),challenges:this.arcade.manageChallenges(),wheel:this.arcade.wheelStatus(),drop:this.arcade.snapshot('drop')}:{settings:{dropsEnabled:false},pet:null,petEvents:[],challenges:[],wheel:{canSpin:false,activeAction:null,reason:'Chaos Wheel ist hier nicht eingerichtet.'},drop:{drop:null}});return; }
    if (route === 'events' && req.method === 'GET') { this.json(res, 200, { events: this.store.events() }); return; }
    if (route === 'settings' && req.method === 'GET') {
      this.json(res, 200, { xp_settings: this.store.config('xp_settings', {}), game_settings: this.store.config('game_settings', {}),
        '8ball_answers': this.store.config('8ball_answers', []), level_titles: this.store.config('level_titles', {}), events: this.store.events(),
        quest_settings: this.store.config('quest_settings', defaultQuestSettings()),
        poll_settings: this.store.config('poll_settings', defaultPollSettings()),
        widget_settings: this.store.config('widget_settings', defaultWidgetSettings()) }); return;
    }
    if (route === 'commands' && req.method === 'GET') { this.json(res, 200, { commands: this.store.customCommands() }); return; }
    if (route === 'users' && req.method === 'GET') { this.json(res, 200, { users: this.store.users((url.searchParams.get('q') || '').slice(0, 80), 50) }); return; }
    if (route === 'quests' && req.method === 'GET') {
      const status = url.searchParams.get('status') || 'all';
      const allowed = new Set(['all','pending','approved','active','completed','failed','rejected','canceled']);
      if (!allowed.has(status)) { this.json(res, 400, { error: 'Quest-Filter ungültig.' }); return; }
      this.json(res, 200, { quests: this.store.listQuests(status as QuestStatus | 'all', (url.searchParams.get('q') || '').slice(0, 80)),
        summary: this.store.questSummary(), active: this.store.activeQuest() ?? null }); return;
    }
    if(route==='memories'&&req.method==='GET'){
      const pending=this.store.communityMemories({status:'pending',limit:100}).map(row=>this.moderationMemory(row));
      const published=this.store.communityMemories({status:'published',limit:100}).map(row=>this.moderationMemory(row));
      this.json(res,200,{pending,published,categories:MEMORY_CATEGORIES});return;
    }
    if(route==='ideas'&&req.method==='GET'){
      const status=url.searchParams.get('status')||'all';
      const ideas=this.store.communityIdeas({...(status==='all'?{}:{status}),query:(url.searchParams.get('q')||'').slice(0,80),sort:'newest',limit:200});
      this.json(res,200,{ideas,summary:{pending:ideas.filter(x=>x.status==='pending').length,approved:ideas.filter(x=>x.status==='approved').length,voting:ideas.filter(x=>x.status==='voting').length},activePoll:this.store.activePoll()??null});return;
    }
    if (route === 'polls' && req.method === 'GET') {
      const active = this.store.activePoll(); const history = this.store.pollHistory(25);
      this.json(res, 200, { active: active ?? history.find((poll) => poll.status === 'ended') ?? null, history }); return;
    }
    if (route === 'stream' && req.method === 'GET') { this.openEventStream(url, req, res, session.userId); return; }
    if (req.method !== 'POST') { this.json(res, 405, { error: 'Methode nicht erlaubt.' }); return; }
    const body = await this.readJson(req); if (!body) { this.json(res, 400, { error: 'Ungültiger JSON-Body.' }); return; }
    if(route==='vip/settings'){
      if(session.role!=='admin'){this.json(res,403,{error:'Nur Jannik kann VIP-Funktionen aktivieren oder konfigurieren.'});return;}
      try{const settings=this.vipExperience?.updateSettings(body);if(!settings)throw new Error('VIP-Erlebnis ist nicht eingerichtet.');this.audit(session,'vip-settings','vip-experience',{enabled:settings.enabled},now);this.json(res,200,{ok:true,settings});}catch(error){this.json(res,400,{error:error instanceof Error?error.message:'VIP-Einstellungen konnten nicht gespeichert werden.'});}return;
    }
    if(route==='vip/chaos'){
      const id=typeof body.id==='string'?body.id:'';
      if(!this.vipExperience||!this.vipService||!this.moderatorPranks||!id||(body.action!=='approve'&&body.action!=='reject')){this.json(res,400,{error:'VIP-Chaos-Aktion ungültig.'});return;}
      const vipSettings=this.vipExperience.settings();
      if(body.action==='approve'&&(!vipSettings.enabled||!vipSettings.loungeEnabled||!vipSettings.chaosEnabled)){this.json(res,409,{error:'VIP-Chaos ist inzwischen deaktiviert. Die Anfrage wurde nicht ausgelöst.'});return;}
      const request=this.vipExperience.decideRequest(id,session.userId,body.action==='approve',now);if(!request){this.json(res,409,{error:'Diese Anfrage ist nicht mehr offen.'});return;}
      if(body.action==='reject'){this.audit(session,'vip-chaos-reject',id,{},now);this.json(res,200,{ok:true,message:'Anfrage abgelehnt.'});return;}
      const stillVip=await this.vipService.isVip(String(request.userId));if(!stillVip){this.vipExperience.finishRequest(id,false,now);this.json(res,409,{error:'Der Twitch-VIP-Status konnte vor der Freigabe nicht mehr bestätigt werden.'});return;}
      const kind=request.action==='elio-crown'?'chief':request.action==='oracle'?'oracle':'vault-alarm';
      const result=this.moderatorPranks.start(kind as PrankKind,session.userId,now);
      if(!result.ok){this.vipExperience.finishRequest(id,false,now);this.json(res,409,{error:result.message});return;}
      this.vipExperience.finishRequest(id,true,now);this.vipExperience.recordChaosAchievement(String(request.userId),now);this.audit(session,'vip-chaos-approved',id,{kind},now);
      if(result.announcement&&this.sendToChat){try{if(!this.chatPolicy||this.chatPolicy.shouldSend({message:result.announcement,now}))await this.sendToChat(result.announcement,'community');}catch{/* performed action is recorded; never replay on chat-send uncertainty */}}
      this.json(res,200,{ok:true,message:'VIP-Chaos wurde freigegeben und ausgelöst.'});return;
    }
    if(route==='vip/challenge-feature'){
      const questId=typeof body.questId==='string'?body.questId:'';if(!this.vipExperience||!questId){this.json(res,400,{error:'VIP-Challenge fehlt.'});return;}
      if(!this.vipExperience.featureChallenge(questId,session.userId,now+7*24*60*60_000,now)){this.json(res,409,{error:'Nur freigegebene VIP-Challenges können hervorgehoben werden.'});return;}
      this.audit(session,'vip-challenge-feature',questId,{},now);this.json(res,200,{ok:true,message:'VIP-Challenge der Woche hervorgehoben.'});return;
    }
    if(route==='eight-ball'){
      const personal=Number(body.personalCooldownSeconds),global=Number(body.globalCooldownSeconds);
      if(typeof body.enabled!=='boolean'||typeof body.cooldownNotices!=='boolean'||!Number.isInteger(personal)||personal<0||personal>3600||!Number.isInteger(global)||global<0||global>60){this.json(res,400,{error:'Bitte gültige 8-Ball-Einstellungen wählen.'});return;}
      const modules=this.store.config<Record<string,boolean>>('modules',{});modules.eightBall=body.enabled;this.store.setConfig('modules',modules);
      this.store.setConfig('eight_ball_settings',{personalCooldownMs:personal*1000,globalCooldownMs:global*1000,cooldownNotices:body.cooldownNotices});
      this.audit(session,'eight-ball-settings','8ball',{enabled:body.enabled,personalCooldownSeconds:personal,globalCooldownSeconds:global,cooldownNotices:body.cooldownNotices},now);
      this.json(res,200,{ok:true,message:'Magic 8-Ball-Einstellungen gespeichert.'});return;
    }
    if(route==='memories'){
      const id=typeof body.id==='string'?clean(body.id,64):'',action=body.action;
      if(!id||!['publish','reject','feature','unfeature'].includes(String(action))){this.json(res,400,{error:'Bitte wähle eine gültige Moderationsaktion.'});return;}
      const ok=this.store.moderateCommunityMemory(id,action as 'publish'|'reject'|'feature'|'unfeature',session.userId,now);
      if(!ok){this.json(res,409,{error:'Der Vorschlag ist nicht mehr in diesem Status verfügbar.'});return;}
      this.audit(session,`community-memory-${action}`,id,{},now);this.json(res,200,{ok:true,message:action==='publish'?'Erinnerung veröffentlicht.':action==='reject'?'Vorschlag abgelehnt.':action==='feature'?'Zum Rückblick hinzugefügt.':'Aus dem Rückblick entfernt.'});return;
    }
    if(route==='ideas'){
      const action=String(body.action||''),id=typeof body.id==='string'?clean(body.id,64):'',comment=typeof body.comment==='string'?normalizeCommunityText(body.comment,0,300):null;
      if(action==='vote'){
        const ids=Array.isArray(body.ids)?body.ids.filter((value):value is string=>typeof value==='string').map(value=>clean(value,64)):[],duration=Number(body.durationSeconds);
        if(ids.length<2||ids.length>5||new Set(ids).size!==ids.length||!Number.isInteger(duration)||duration<30||duration>180){this.json(res,400,{error:'Wähle 2–5 verschiedene freigegebene Ideen und eine Laufzeit von 30–180 Sekunden.'});return;}
        const ideas=ids.map(value=>this.store.communityIdea(value));if(ideas.some(value=>!value||value.status!=='approved')){this.json(res,409,{error:'Nur freigegebene Ideen können zur Abstimmung stehen.'});return;}
        const settings=this.store.config('poll_settings',defaultPollSettings()),poll=this.store.createPoll({type:'chat',question:'Welche Idee soll Jannik als Nächstes angehen?',options:ideas.map(idea=>({label:idea!.text.slice(0,100),ideaId:idea!.id})),durationMs:duration*1000,allowVoteChange:false,createdBy:session.userId,now});
        if(!poll){this.json(res,409,{error:'Es läuft bereits eine andere Abstimmung.'});return;}
        if(!this.store.markIdeasVoting(ids,now)){this.store.endPoll(poll.id,now,true);this.json(res,409,{error:'Eine Idee hat während des Starts ihren Status geändert. Bitte erneut laden.'});return;}
        this.audit(session,'community-ideas-vote-start',poll.id,{ideaCount:ids.length},now);
        if(this.sendToChat)try{await this.sendToChat('🗳️💜 Die Community entscheidet! Stimmt im Community-Portal ab: https://twitch.gater-app.de/community/ideen','poll');}catch{this.json(res,502,{error:'Abstimmung läuft, aber die Chat-Ankündigung konnte nicht bestätigt werden. Sie wird nicht erneut gesendet.',poll});return;}
        this.json(res,201,{ok:true,poll});return;
      }
      const allowed=new Set(['review','approve','reject','accept','plan','implement','archive','categorize']);
      if(!id||!allowed.has(action)){this.json(res,400,{error:'Bitte wähle eine gültige Ideenaktion.'});return;}
      const category=typeof body.category==='string'?normalizeCommunityText(body.category,0,40):null;
      if(category!==null&&(!category||!['Stream','Community','Event','Bot','Technik','Sonstiges'].includes(category))){this.json(res,400,{error:'Bitte eine gültige Kategorie auswählen.'});return;}
      if(action==='categorize'){
        if(!category||!this.store.categorizeCommunityIdea(id,category,session.userId,now)){this.json(res,409,{error:'Kategorie konnte nicht gespeichert werden.'});return;}
        this.audit(session,'community-idea-categorize',id,{category},now);this.json(res,200,{ok:true,message:'Ideenkategorie gespeichert.'});return;
      }
      if(!this.store.moderateCommunityIdea(id,action as 'review'|'approve'|'reject'|'accept'|'plan'|'implement'|'archive',session.userId,now,comment,category)){this.json(res,409,{error:'Die Idee kann in ihrem aktuellen Status nicht geändert werden.'});return;}
      this.audit(session,'community-idea-'+action,id,{},now);this.json(res,200,{ok:true,message:action==='approve'?'Idee freigegeben.':action==='reject'?'Idee abgelehnt.':action==='review'?'Idee zur Prüfung übernommen.':action==='accept'?'Idee als angenommen markiert.':action==='plan'?'Idee ist jetzt in Planung.':action==='implement'?'Idee als umgesetzt markiert.':'Idee archiviert.'});return;
    }
    if(route==='bot-lifecycle'){
      if(!this.botLifecycle){this.json(res,503,{error:'Bot-Lebenszeichen sind nicht verfügbar.'});return;}
      if(body.action==='settings'&&typeof body.enabled==='boolean'){this.json(res,200,{enabled:this.botLifecycle.setEnabled(body.enabled).enabled});return;}
      if(body.action==='prepare'){
        const result=this.botLifecycle.prepare(now);this.json(res,result.ok?200:409,result);return;
      }
      this.json(res,400,{error:'Aktion ungültig.'});return;
    }
    if(route==='chat-messages'){
      if(!['calm','normal','lively'].includes(String(body.profile))) { this.json(res,400,{error:'Bitte ein gültiges Antwortprofil auswählen.'});return; }
      if(body.communityTipsEnabled!==undefined&&typeof body.communityTipsEnabled!=='boolean'){this.json(res,400,{error:'Bitte Ein oder Aus für Community-Tipps wählen.'});return;}
      if(body.communityTipCategories!==undefined&&(!body.communityTipCategories||typeof body.communityTipCategories!=='object'||Array.isArray(body.communityTipCategories)
        ||Object.keys(body.communityTipCategories as object).some(key=>!COMMUNITY_TIP_CATEGORIES.some(category=>category.id===key))
        ||Object.values(body.communityTipCategories as Record<string,unknown>).some(enabled=>typeof enabled!=='boolean'))){this.json(res,400,{error:'Bitte gültige Ein/Aus-Werte für die Hinweis-Kategorien wählen.'});return;}
      if(body.communityPortalTipsEnabled!==undefined&&typeof body.communityPortalTipsEnabled!=='boolean'){this.json(res,400,{error:'Bitte Ein oder Aus für Portal-Hinweise wählen.'});return;}
      if(body.communityHalloweenEnabled!==undefined&&typeof body.communityHalloweenEnabled!=='boolean'){this.json(res,400,{error:'Bitte Ein oder Aus für Halloween-Erinnerungen wählen.'});return;}
      if(body.communityHalloweenFrequency!==undefined&&body.communityHalloweenFrequency!=='normal'&&body.communityHalloweenFrequency!=='frequent'){this.json(res,400,{error:'Bitte Normal oder Häufiger für Halloween wählen.'});return;}
      const welcomeBots=body.welcomeBots===undefined?DEFAULT_CHAT_RESPONSE_SETTINGS.welcomeBots:body.welcomeBots;
      if(!Array.isArray(welcomeBots)||welcomeBots.length>50||welcomeBots.some((x)=>typeof x!=='string'||x.length>50||!/^[a-z0-9_]+$/iu.test(x))){this.json(res,400,{error:'Die Bot-Ausschlussliste ist ungültig (maximal 50 Twitch-Namen).'});return;}
      const settings={profile:body.profile,welcomeBots:[...new Set(welcomeBots.map((x:string)=>x.toLowerCase()))]};
      this.store.setConfig('chat_response_settings',settings);this.chatPolicy?.configure(settings);
      if(typeof body.communityTipsEnabled==='boolean')this.communityTips?.configure(body.communityTipsEnabled);
      if(body.communityTipCategories!==undefined)this.communityTips?.configureCategories(body.communityTipCategories);
      if(typeof body.communityPortalTipsEnabled==='boolean')this.communityTips?.configurePortal(body.communityPortalTipsEnabled);
      if(typeof body.communityHalloweenEnabled==='boolean'||body.communityHalloweenFrequency!==undefined)this.communityTips?.configureHalloween(body.communityHalloweenEnabled===undefined?this.communityTips.settings().halloweenEnabled:body.communityHalloweenEnabled,body.communityHalloweenFrequency===undefined?this.communityTips.settings().halloweenFrequency:body.communityHalloweenFrequency);
      this.audit(session,'chat-response-settings','chat',{profile:settings.profile,welcomeBotCount:settings.welcomeBots.length,communityTipsEnabled:body.communityTipsEnabled===true,communityPortalTipsEnabled:body.communityPortalTipsEnabled===true,communityHalloweenEnabled:body.communityHalloweenEnabled===true,communityHalloweenFrequency:body.communityHalloweenFrequency==='normal'?'normal':'frequent'},now);this.json(res,200,{ok:true});return;
    }
    if(route==='automatic-messages'){
      if(!this.automaticChatMessages){this.json(res,503,{error:'Die Verwaltung automatischer Nachrichten ist derzeit nicht verfügbar.'});return;}
      const action=String(body.action||'save');
      try{
        if(action==='save'){
          const saved=this.automaticChatMessages.save({...(typeof body.id==='string'?{id:body.id}:{}),title:body.title,message:body.message,intervalMinutes:body.intervalMinutes,enabled:body.enabled,activeChatOnly:body.activeChatOnly},now);
          this.audit(session,'automatic-chat-message-save',saved.id,{intervalMinutes:saved.intervalMinutes,enabled:saved.enabled,activeChatOnly:saved.activeChatOnly},now);this.json(res,200,{ok:true,message:{...saved,preview:formatPublicChatMessage(saved.message,'info')}});return;
        }
        if(action==='toggle'){
          const id=String(body.id||'');if(!id||typeof body.enabled!=='boolean'){this.json(res,400,{error:'Nachricht oder Aktiv-Status fehlt.'});return;}
          if(!this.automaticChatMessages.setEnabled(id,body.enabled,now)){this.json(res,404,{error:'Automatische Nachricht nicht gefunden.'});return;}
          this.audit(session,'automatic-chat-message-toggle',id,{enabled:body.enabled},now);this.json(res,200,{ok:true});return;
        }
        if(action==='delete'){
          const id=String(body.id||'');if(!id){this.json(res,400,{error:'Nachrichtenkennung fehlt.'});return;}
          if(!this.automaticChatMessages.delete(id)){this.json(res,404,{error:'Automatische Nachricht nicht gefunden.'});return;}
          this.audit(session,'automatic-chat-message-delete',id,{},now);this.json(res,200,{ok:true});return;
        }
        this.json(res,400,{error:'Aktion für automatische Nachrichten ist ungültig.'});return;
      }catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Nachricht ist ungültig.'});return;}
    }
    if(route==='welcome'){
      if(typeof body.enabled!=='boolean'||typeof body.message!=='string'||body.message.length<5||body.message.length>500||!body.message.includes('{user}')||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.message)){
        this.json(res,400,{error:'Begrüßung benötigt einen sicheren Text mit {user} und höchstens 500 Zeichen.'});return;
      }
      this.store.setConfig('first_chat_welcome',{enabled:body.enabled,message:body.message.trim()});this.audit(session,'welcome-settings','first-chat',{enabled:body.enabled},now);this.json(res,200,{ok:true});return;
    }
    if (route === 'spark/settings') {
      try {
        const current = normalizeSparkConfig(this.store.config<unknown>('spark_settings',DEFAULT_SPARK_CONFIG));
        const minutes = (key:string, old:number, min:number, max:number) => boundedInt(body[key], old, min, max) * 60_000;
        const allowed = Array.isArray(body.allowedActionTypes) ? body.allowedActionTypes : current.allowedActionTypes;
        if (!Array.isArray(allowed) || !allowed.length || allowed.some((x)=>!['poll','quest','challenge'].includes(String(x)))) throw new Error('Mindestens ein gültiger Aktionstyp ist erforderlich.');
        const categories=body.enabledCategories===undefined?current.enabledCategories:body.enabledCategories;
        if(!Array.isArray(categories)||!categories.length||categories.some((x)=>typeof x!=='string'||!Object.hasOwn(SPARK_QUESTION_POOLS,x)))throw new Error('Bitte mindestens eine gültige Themenkategorie auswählen.');
        const sensitivity=body.sensitivity===undefined?current.sensitivity:body.sensitivity;
        if(!['reserved','normal','active'].includes(String(sensitivity)))throw new Error('Die Erkennungsempfindlichkeit ist ungültig.');
        const publishMode=body.publishMode===undefined?current.publishMode:body.publishMode;
        if(!['internal','approved-chat'].includes(String(publishMode)))throw new Error('Die Veröffentlichungseinstellung ist ungültig.');
        const settings = { ...current, enabled:boolValue(body.enabled,current.enabled??false,'Aktivierung'), paused:boolValue(body.paused,current.paused??false,'Pause'),
          chatSuggestionsEnabled:boolValue(body.chatSuggestionsEnabled,current.chatSuggestionsEnabled??false,'Chat-Hinweise'), pauseDuringPolls:boolValue(body.pauseDuringPolls,current.pauseDuringPolls??true,'Pausieren während Umfrage'),
          windowMs:minutes('windowMinutes',Number(current.windowMs||600000)/60000,1,60), minParticipants:boundedInt(body.minParticipants,Number(current.minParticipants||3),2,50),
          minMessages:boundedInt(body.minMessages,Number(current.minMessages||5),3,200), minScore:boundedInt(body.minScore,Number(current.minScore||12),1,1000),
          globalCooldownMs:minutes('globalCooldownMinutes',Number(current.globalCooldownMs||1200000)/60000,1,1440), topicCooldownMs:minutes('topicCooldownMinutes',Number(current.topicCooldownMs||3600000)/60000,1,10080),
          proposalTtlMs:minutes('proposalTtlMinutes',Number(current.proposalTtlMs||1800000)/60000,1,1440), maxPending:boundedInt(body.maxPending,Number(current.maxPending||5),1,50), allowedActionTypes:allowed,
          enabledCategories:[...new Set(categories)],sensitivity,publishMode };
        const topics=body.topics===undefined?this.store.config('spark_topics',[]):body.topics;
        if(!Array.isArray(topics)||topics.length>100||topics.some((t)=>!isRecord(t)||typeof t.id!=='string'||typeof t.label!=='string'||!Array.isArray(t.terms)||t.terms.length>30||t.terms.some((v)=>typeof v!=='string'||v.length>80)||!['question','poll','quest','challenge'].includes(String(t.actionType))||(t.category!==undefined&&!Object.hasOwn(SPARK_QUESTION_POOLS,String(t.category)))))throw new Error('Topic-Liste ist ungültig.');
        this.store.setConfig('spark_settings',settings);this.store.setConfig('spark_topics',topics);this.audit(session,'spark-settings','conversation-spark',{enabled:settings.enabled},now);this.json(res,200,{ok:true});return;
      } catch(error) { this.json(res,400,{error:error instanceof Error?error.message:'Einstellungen ungültig.'});return; }
    }
    if (route === 'spark/action') {
      const id=String(body.id||''), action=String(body.action||''), proposal=this.store.sparkProposal(id);
      if(!proposal){this.json(res,404,{error:'Vorschlag nicht gefunden.'});return;}
      if(action==='publish-question'){
        const settings=normalizeSparkConfig(this.store.config('spark_settings',DEFAULT_SPARK_CONFIG));
        if(proposal.status!=='approved'||proposal.actionType!=='question'||!proposal.suggestionText||settings.publishMode!=='approved-chat'){this.json(res,409,{error:'Diese Gesprächsfrage kann derzeit nicht veröffentlicht werden.'});return;}
        if(!this.sendToChat){this.json(res,503,{error:'Der Chatversand ist derzeit nicht verfügbar.'});return;}
        if(!this.store.decideSparkProposal(id,'executed',session.userId,now)){this.json(res,409,{error:'Der Vorschlag wurde bereits verarbeitet.'});return;}
        try{await this.sendToChat(proposal.suggestionText,'ideas');this.audit(session,'spark-publish-question',id,{},now);this.json(res,200,{ok:true});}
        catch{this.json(res,502,{error:'Der Versand wurde angestoßen, konnte aber nicht bestätigt werden. Er wird nicht automatisch wiederholt.'});}return;
      }
      if(action==='approve'||action==='reject'){
        const ok=this.store.decideSparkProposal(id,action==='approve'?'approved':'rejected',session.userId,now);
        if(!ok){this.json(res,409,{error:'Vorschlag ist abgelaufen oder bereits entschieden.'});return;}
        if(action==='approve'&&proposal.actionType==='question'&&proposal.suggestionText&&normalizeSparkConfig(this.store.config('spark_settings',DEFAULT_SPARK_CONFIG)).publishMode==='approved-chat'){
          if(!this.sendToChat){this.json(res,503,{error:'Freigabe gespeichert; Chatversand ist derzeit nicht verfügbar.'});return;}
          if(!this.store.decideSparkProposal(id,'executed',session.userId,Date.now())){this.json(res,409,{error:'Der Vorschlag wurde bereits verarbeitet.'});return;}
          try{await this.sendToChat(proposal.suggestionText,'ideas');}catch{this.json(res,502,{error:'Der Versand wurde angestoßen, konnte aber nicht bestätigt werden. Er wird nicht automatisch wiederholt.'});return;}
        }
        this.audit(session,`spark-${action}`,id,{},now);this.json(res,200,{ok:true});return;
      }
      if(proposal.status!=='approved'){this.json(res,409,{error:'Bitte den Vorschlag zuerst freigeben.'});return;}
      if(action==='create-poll'){
        const question=normalizeCommunityText(String(body.question||''),3,180),options=Array.isArray(body.options)?body.options.map(v=>normalizeCommunityText(String(v),1,100)):[],duration=Number(body.durationSeconds);
        if(!question||options.length<2||options.length>5||options.some(v=>!v)||!Number.isInteger(duration)||duration<10||duration>3600){this.json(res,400,{error:'Umfrage-Eingaben sind ungültig.'});return;}
        const pollSettings=this.store.config('poll_settings',defaultPollSettings()),poll=this.store.createPoll({type:'chat',question,options:options.map(label=>({label:label!})),durationMs:duration*1000,allowVoteChange:pollSettings.allowVoteChange,createdBy:session.userId,now});
        if(!poll){this.json(res,409,{error:'Eine Umfrage läuft bereits.'});return;}this.store.decideSparkProposal(id,'executed',session.userId,now);this.audit(session,'spark-create-poll',id,{pollId:poll.id},now);this.json(res,201,{poll});return;
      }
      if(action==='create-quest'){
        const title=normalizeCommunityText(String(body.title||''),3,this.questPolicy().maxLength);if(!title){this.json(res,400,{error:'Quest-Titel ungültig.'});return;}
        const result=this.store.submitQuest({submitterUserId:session.userId,displayName:session.login,title,source:'dashboard',game:proposal.topicLabel},this.questPolicy(),now);
        if(!result.ok){this.json(res,409,{error:'Quest konnte nicht angelegt werden.'});return;}this.store.decideSparkProposal(id,'executed',session.userId,now);this.json(res,201,{quest:result.quest});return;
      }
      this.json(res,400,{error:'Aktion nicht unterstützt.'});return;
    }
    if (route === 'minigames/action' && this.miniGames) {
      const action=String(body.action||'');let message='';
      if(action==='settings'){this.miniGames.updateSettings({...this.miniGames.settings(),enabled:body.enabled===true});}
      else if(action==='save-settings'&&isRecord(body.settings)){this.miniGames.updateSettings(body.settings as never);}
      else if(action==='start-imposter')message=this.miniGames.startImposter(session.userId,now);
      else if(action==='close-imposter')message=this.miniGames.startRoles(session.userId,now);
      else if(action==='vote-imposter')message=this.miniGames.beginVote(now);
      else if(action==='cancel-imposter')message=this.miniGames.cancelImposter(now);
      else if(action==='start-detective')message=this.miniGames.startDetective(now);
      else if(action==='end-detective')message=this.miniGames.endDetective(now);
      else if(action==='quote'&&typeof body.id==='string'&&(body.status==='approved'||body.status==='rejected')){if(!this.miniGames.moderateQuote(body.id,body.status,now)){this.json(res,409,{error:'Zitat nicht mehr offen.'});return;}}
      else if(action==='quote'&&typeof body.id==='string'&&body.status==='deleted'){if(!this.miniGames.removeQuote(body.id)){this.json(res,404,{error:'Zitat nicht gefunden.'});return;}}
      else {this.json(res,400,{error:'Spielaktion ungültig.'});return;}
      if(message)await this.sendToChat?.(message,action.includes('imposter')?'imposter':'detective');
      this.audit(session,'minigame-dashboard-action',action,{},now);this.json(res,200,{ok:true,...(message?{message}:{})});return;
    }
    if (route.startsWith('channel-points') && this.channelPoints) {
      try {
        if(route==='channel-points/connect'){this.json(res,200,{url:this.channelPointsUrl?.()||''});return;}
        if(route==='channel-points/rewards'){const rewards=await this.channelPoints.manageableRewards();this.json(res,200,{rewards});return;}
        if(route==='channel-points/reward'){
          if(body.action==='create'){const reward=await this.channelPoints.createReward(Number(body.cost));this.audit(session,'channel-points-reward-create',reward.id,{},now);this.json(res,201,{reward});return;}
          if(body.action==='select'&&typeof body.rewardId==='string'){const reward=await this.channelPoints.selectReward(body.rewardId);this.audit(session,'channel-points-reward-select',reward.id,{},now);this.json(res,200,{reward});return;}
        }
        if(route==='channel-points/settings'){const previous=this.channelPoints.settings(),enabled=boolValue(body.enabled,previous.enabled,'Kanalpunkte');await this.channelPoints.saveSettings({...previous,enabled,fulfillOnApproval:boolValue(body.fulfillOnApproval,previous.fulfillOnApproval,'Erfüllung'),cost:boundedInt(body.cost,previous.cost,1,1_000_000)});this.audit(session,'channel-points-settings','channel-points',{enabled},now);this.json(res,200,{ok:true});return;}
        if(route==='channel-points/retry'&&typeof body.id==='string'){await this.channelPoints.retry(body.id);this.json(res,200,{ok:true});return;}
      } catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Kanalpunkte-Anfrage fehlgeschlagen.'});return;}
      this.json(res,400,{error:'Kanalpunkte-Aktion ungültig.'});return;
    }
    if(route.startsWith('song-requests')&&this.songRequests){
      try{
        if(route==='song-requests/connect'){this.json(res,200,{url:this.songRequests.authorizationUrl()});return;}
        if(route==='song-requests/playlists'){this.json(res,200,{playlists:await this.songRequests.playlists()});return;}
        if(route==='song-requests/rewards'){this.json(res,200,{rewards:await this.songRequests.manageableRewards()});return;}
        if(route==='song-requests/reward'&&body.action==='create'){const reward=await this.songRequests.createReward();this.audit(session,'song-request-reward-create',reward.id,{},now);this.json(res,201,{reward});return;}
        if(route==='song-requests/reward'&&body.action==='select'&&typeof body.rewardId==='string'){const reward=await this.songRequests.selectReward(body.rewardId);this.audit(session,'song-request-reward-select',reward.id,{},now);this.json(res,200,{reward});return;}
        if(route==='song-requests/playlist'&&typeof body.playlistId==='string'){await this.songRequests.selectPlaylist(body.playlistId);this.audit(session,'song-request-playlist-select',body.playlistId,{},now);this.json(res,200,{ok:true});return;}
        if(route==='song-requests/settings'){const old=this.songRequests.settings();await this.songRequests.saveSettings({...old,enabled:boolValue(body.enabled,old.enabled,'Song Requests')});this.audit(session,'song-request-settings','song-requests',{enabled:body.enabled===true},now);this.json(res,200,{ok:true});return;}
      }catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Song-Request-Einstellung fehlgeschlagen.'});return;}
      this.json(res,400,{error:'Song-Request-Aktion ungültig.'});return;
    }
    if(route==='vault/settings'&&this.vault){try{const settings=this.vault.updateSettings(body);this.audit(session,'vault-settings','community-vault',{enabled:settings.enabled,autoStart:settings.autoStart},now);this.json(res,200,{settings});return;}catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Tresor-Einstellung ungültig.'});return;}}
    if(route==='vault/action'&&this.vault){const action=String(body.action||'');if(action==='start'){
      const settings=this.vault.settings();if(!settings.enabled){this.json(res,409,{error:'Tresor-Funktion ist ausgeschaltet. Aktiviere sie zuerst in den Einstellungen.'});return;}
      if(this.vault.isActive(now)){this.json(res,409,{error:'⏳ Der Tresor läuft bereits.'});return;}
      const remaining=this.vault.cooldownRemainingMs(now);if(remaining>0){this.json(res,409,{error:`⏳ Der globale Tresor-Cooldown läuft noch ${Math.ceil(remaining/60_000)} Min.`});return;}
      if(!this.sendToChat){this.json(res,503,{error:'Chatversand ist derzeit nicht verfügbar.'});return;}
      if(!this.vaultStartAllowed){this.json(res,503,{error:'Die Startbedingungen des Tresors sind nicht verfügbar.'});return;}
      let gate:boolean|string;try{gate=await this.vaultStartAllowed();}catch{this.json(res,503,{error:'⚠️ Der Livestatus konnte nicht sicher geprüft werden. Bitte später erneut versuchen.'});return;}
      if(gate!==true){this.json(res,409,{error:typeof gate==='string'?gate:'Der Tresor startet nur bei bestätigtem Livestream, genügend aktiven Zuschauern und freiem Spielstatus.'});return;}
      const mini=this.miniGames?.snapshot()||{},drop=this.arcade?.snapshot('drop') as {drop?:{status?:string}}|undefined,wheel=this.arcade?.wheelStatus() as {active?:boolean}|undefined;const dropStatus=drop?.drop?.status;
      if(mini.imposter||mini.detective||this.store.activeQuest()||this.store.activePoll(now)||this.store.activeBoss(now)||['announced','claiming','resolving'].includes(dropStatus||'')||wheel?.active){this.json(res,409,{error:'⏳ Ein anderes Community-Spiel läuft gerade.'});return;}
      const result=this.vault.startManual(now);if(!result.ok){this.json(res,409,{error:result.message});return;}
      try{await this.sendToChat(result.message,'vault');}catch{this.json(res,502,{error:'Tresor-Runde wurde gespeichert, aber die Chatmeldung konnte nicht bestätigt werden. Sie wird nicht automatisch wiederholt.'});return;}
      this.audit(session,'vault-start','community-vault',{},now);this.json(res,200,{ok:true,message:'🔐 Der Community-Tresor wurde gestartet.'});return;
    }if(action==='cancel'){if(!this.vault.cancel(now)){this.json(res,409,{error:'Gerade läuft keine Tresor-Runde.'});return;}this.audit(session,'vault-cancel','community-vault',{},now);this.json(res,200,{ok:true,message:'Tresor-Runde abgebrochen.'});return;}this.json(res,400,{error:'Tresor-Aktion ungültig.'});return;}
    if(route==='arcade'&&this.arcade){
      try{
        if(body.settings!==undefined){if(!isRecord(body.settings))throw new Error('Arcade-Einstellungen ungültig.');this.arcade.updateSettings(body.settings as never);if(body.settings.wheelAutoPilotEnabled===true)this.arcade.resumeAutoPilot();this.audit(session,'arcade-settings','arcade',{},now);this.json(res,200,{ok:true});return;}
        const action=String(body.action||'');let message='';
        if(action==='start-drop')message=this.arcade.startDropAdmin(session.userId,typeof body.rarity==='string'?body.rarity:undefined,now);
        else if(action==='spin')message=this.arcade.spinAdmin(session.userId,now);
        else if(action==='emergency-stop')message=this.arcade.emergencyStop(now);
        else if(action==='finish-task')message=this.arcade.finishCurrentTask(now);
        else if(action==='wheel-field'){if(typeof body.id!=='string'||typeof body.active!=='boolean')throw new Error('Radfeld-Einstellung ungültig.');this.arcade.configureWheelField(body.id,body.active,boundedInt(body.weight,1,1,1000));this.audit(session,'arcade-field','arcade',{},now);this.json(res,200,{ok:true});return;}
        else {this.json(res,400,{error:'Arcade-Aktion ungültig.'});return;}
        if(message&&(action!=='spin'||this.arcade.winnerChatAnnouncementEnabled()))await this.sendToChat?.(message,action==='start-drop'?'drop':action==='spin'&&this.arcade.spinActionTypeAt(now)==='boost_pet'?'pet':'wheel');this.audit(session,'arcade-action',action,{},now);this.json(res,200,{ok:true,message});return;
      }catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Arcade-Aktion fehlgeschlagen.'});return;}
    }
    if (route === 'polls' || route === 'polls/quest-vote') {
      const modules = this.store.config<Record<string, boolean>>('modules', {});
      const settings = this.store.config('poll_settings', defaultPollSettings());
      if (modules.polls === false || !settings.enabled) { this.json(res, 409, { error: 'Umfragen sind deaktiviert.' }); return; }
    }
    if (route === 'modules') {
      const key = String(body.key || ''); const enabled = body.enabled;
      const allowed = new Set(['xp','events','eightBall','rps','guess','duels','boss','customCommands','quests','polls']);
      if (!allowed.has(key) || typeof enabled !== 'boolean') { this.json(res, 400, { error: 'Modul-Eingabe ungültig.' }); return; }
      const modules = this.store.config<Record<string, boolean>>('modules', {}); modules[key] = enabled; this.store.setConfig('modules', modules);
      this.audit(session, 'module-toggle', key, { enabled }, now); this.json(res, 200, { ok: true }); return;
    }
    if (route === 'settings') {
      try {
        const expected = new Set(['xp_settings','game_settings','8ball_answers','level_titles','events','quest_settings','poll_settings','widget_settings']);
        if (Object.keys(body).some((key) => !expected.has(key))) throw new Error('Unbekannter Einstellungsbereich.');
        const xp = normalizeNumbers(body.xp_settings, this.store.config('xp_settings', {}), {
          activityXp: [0,100], activityCooldownMs: [10_000,3_600_000], dailyGameCap: [0,10_000],
          rpsWinXp: [0,1_000], guessWinXp: [0,1_000], duelWinXp: [0,1_000], levelBase: [1,100_000],
        });
        const game = normalizeNumbers(body.game_settings, this.store.config('game_settings', {}), {
          guessMin: [0,1_000_000], guessMax: [1,1_000_000], guessTimeoutMs: [10_000,86_400_000], guessAttempts: [1,50],
          duelTtlMs: [10_000,3_600_000], bossHp: [1,1_000_000], bossDurationMs: [60_000,86_400_000],
          attackMin: [1,100_000], attackMax: [1,100_000], attackCooldownMs: [1_000,86_400_000],
          bossWinXp: [0,10_000], bossTopBonusXp: [0,10_000],
        });
        if (Number(game.guessMax) <= Number(game.guessMin) || Number(game.attackMax) < Number(game.attackMin)) throw new Error('Spielbereiche sind ungültig.');
        if (!Array.isArray(body['8ball_answers']) || body['8ball_answers'].length < 20 || body['8ball_answers'].length > 100
          || body['8ball_answers'].some((answer) => typeof answer !== 'string' || !answer.trim() || answer.length > 160)) throw new Error('Der 8-Ball benötigt 20 bis 100 kurze Antworten.');
        if (!isRecord(body.level_titles) || Object.keys(body.level_titles).length > 100
          || Object.entries(body.level_titles).some(([level, title]) => !/^[1-9][0-9]{0,3}$/u.test(level) || typeof title !== 'string' || !title.trim() || title.length > 48)) throw new Error('Leveltitel sind ungültig.');
        const events = normalizeEvents(body.events, this.store.events());
        const questSettings = normalizeQuestSettings(body.quest_settings, this.store.config('quest_settings', defaultQuestSettings()));
        const pollSettings = normalizePollSettings(body.poll_settings, this.store.config('poll_settings', defaultPollSettings()));
        const widgetSettings = normalizeWidgetSettings(body.widget_settings, this.store.config('widget_settings', defaultWidgetSettings()));
        this.store.saveEvents(events);
        this.store.setConfig('xp_settings', xp); this.store.setConfig('game_settings', game);
        this.store.setConfig('8ball_answers', body['8ball_answers']); this.store.setConfig('level_titles', body.level_titles);
        this.store.setConfig('quest_settings', questSettings); this.store.setConfig('poll_settings', pollSettings);
        this.store.setConfig('widget_settings', widgetSettings);
        this.audit(session, 'settings-update', 'bot', { eventCount: events.length }, now); this.json(res, 200, { ok: true }); return;
      } catch (error) { this.json(res, 400, { error: error instanceof Error ? error.message : 'Einstellungen ungültig.' }); return; }
    }
    if (route === 'quests') {
      const settings = this.questPolicy();
      const title = normalizeCommunityText(String(body.title || ''), 3, settings.maxLength);
      const game = body.game === undefined || body.game === '' ? null : normalizeCommunityText(String(body.game), 1, 80);
      if (!title || (body.game && !game)) { this.json(res, 400, { error: 'Questtext oder Spielname ist ungültig.' }); return; }
      const submitted = this.store.submitQuest({ submitterUserId: session.userId, displayName: clean(session.login, 48), title,
        source: 'dashboard', game: game ?? null }, settings, now);
      if (!submitted.ok) { this.json(res, 409, { error: submitted.reason === 'cooldown' ? 'Bitte warte vor deinem nächsten Vorschlag.' : 'Vorschlag konnte nicht angelegt werden: ' + submitted.reason }); return; }
      this.audit(session, 'quest-dashboard-submit', submitted.quest.id, {}, now);
      this.json(res, 201, { quest: submitted.quest }); return;
    }
    if (route === 'quests/edit') {
      const id = String(body.id || ''), settings = this.questPolicy();
      const title = normalizeCommunityText(String(body.title || ''), 3, settings.maxLength);
      const game = body.game === undefined || body.game === '' ? null : normalizeCommunityText(String(body.game), 1, 80);
      if (!id || !title || (body.game && !game)) { this.json(res, 400, { error: 'Questtext oder Spielname ist ungültig.' }); return; }
      if (!this.store.editQuest(id, title, game ?? null, session.userId, now)) { this.json(res, 409, { error: 'Quest fehlt oder kann in diesem Status nicht bearbeitet werden.' }); return; }
      this.json(res, 200, { ok: true }); return;
    }
    if (route === 'quests/action') {
      const id = String(body.id || ''), action = String(body.action || ''), policy = this.questPolicy();
      if (!id) { this.json(res, 400, { error: 'Quest-ID fehlt.' }); return; }
      if (action === 'select') {
        if (!this.store.selectNextQuest(id, session.userId, now)) { this.json(res, 409, { error: 'Nur freigegebene Quests können ausgewählt werden.' }); return; }
        this.audit(session, 'quest-select-next', id, {}, now); this.json(res, 200, { ok: true }); return;
      }
      const target: Record<string, QuestStatus> = { approve: 'approved', reject: 'rejected', start: 'active', complete: 'completed', fail: 'failed', skip: 'canceled' };
      const status = target[action];
      if (!status) { this.json(res, 400, { error: 'Quest-Aktion ist ungültig.' }); return; }
      const result = this.store.transitionQuest(id, status, session.userId, now, policy);
      if (!result.ok) { this.json(res, 409, { error: questTransitionError(result.reason) }); return; }
      if(action==='approve'&&this.vipExperience?.settings().enabled&&this.vipExperience.settings().achievementsEnabled){
        const vipChallenge=this.vipExperience.challengeForQuest(id);
        if(vipChallenge)this.vipExperience.recordQuestAchievement(vipChallenge.submitterUserId,now);
      }
      this.json(res, 200, { ok: true, quest: result.quest, rewardedXp: result.rewardedXp }); return;
    }
    if (route === 'polls') {
      const question = normalizeCommunityText(String(body.question || ''), 3, 180);
      const options = Array.isArray(body.options) ? body.options.map((value) => normalizeCommunityText(String(value), 1, 100)) : [];
      const durationSeconds = Number(body.durationSeconds);
      if (!question || options.length < 2 || options.length > 5 || options.some((option) => !option)
        || new Set(options.map((option) => option!.toLocaleLowerCase())).size !== options.length
        || !Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 180) {
        this.json(res, 400, { error: 'Live-Abstimmungen brauchen eine kurze Frage, 2–5 eindeutige Antworten und 30–180 Sekunden Laufzeit.' }); return;
      }
      const settings = this.store.config('poll_settings', defaultPollSettings());
      const poll = this.store.createPoll({ type: 'chat', question, options: options.map((label) => ({ label: label! })),
        durationMs: durationSeconds * 1000, allowVoteChange: false, createdBy: session.userId, now });
      if (!poll) { this.json(res, 409, { error: 'Eine Umfrage läuft bereits oder die Optionen sind ungültig.' }); return; }
      this.audit(session, 'poll-start', poll.id, { optionCount: options.length }, now);
      if(this.sendToChat)try{await this.sendToChat(`🗳️ Neue Live-Abstimmung: ${poll.question} · Im Chat mit !vote 1–${options.length} oder im Community-Portal abstimmen.`,'poll');}catch{this.json(res,502,{error:'Abstimmung wurde gespeichert, aber die Chat-Ankündigung konnte nicht bestätigt werden. Sie wird nicht automatisch erneut gesendet.',poll});return;}
      this.json(res, 201, { poll }); return;
    }
    if (route === 'polls/quest-vote') {
      const ids = Array.isArray(body.questIds) ? body.questIds.filter((value): value is string => typeof value === 'string') : [];
      const durationSeconds = Number(body.durationSeconds);
      if (ids.length < 2 || ids.length > 5 || new Set(ids).size !== ids.length
        || !Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) {
        this.json(res, 400, { error: 'Bitte 2–5 verschiedene freigegebene Quests und 10–3600 Sekunden auswählen.' }); return;
      }
      const quests = ids.map((id) => this.store.quest(id));
      if (quests.some((quest) => !quest || quest.status !== 'approved')) { this.json(res, 409, { error: 'Nur freigegebene Quests dürfen zur Wahl stehen.' }); return; }
      const settings = this.store.config('poll_settings', defaultPollSettings());
      const poll = this.store.createPoll({ type: 'quest', question: 'Welche Quest soll als Nächstes gespielt werden?',
        options: quests.map((quest) => ({ label: quest!.title, questId: quest!.id })), durationMs: durationSeconds * 1000,
        allowVoteChange: settings.allowVoteChange, createdBy: session.userId, now });
      if (!poll) { this.json(res, 409, { error: 'Es läuft bereits eine Umfrage oder eine Quest ist nicht mehr freigegeben.' }); return; }
      this.audit(session, 'quest-poll-start', poll.id, { questIds: ids }, now); this.json(res, 201, { poll }); return;
    }
    if (route === 'polls/action') {
      const id = String(body.id || ''), action = String(body.action || '');
      if (!id) { this.json(res, 400, { error: 'Umfrage-ID fehlt.' }); return; }
      if (action === 'end' || action === 'cancel') {
        const poll = this.store.endPoll(id, now, action === 'cancel');
        if (!poll) { this.json(res, 404, { error: 'Umfrage nicht gefunden.' }); return; }
        this.audit(session, action === 'end' ? 'poll-end' : 'poll-cancel', id, {}, now); this.json(res, 200, { poll }); return;
      }
      if (action === 'winner') {
        const option = Number(body.option);
        if (!this.store.choosePollWinner(id, option, session.userId, now)) { this.json(res, 409, { error: 'Gewinner kann in diesem Status nicht festgelegt werden.' }); return; }
        this.json(res, 200, { ok: true }); return;
      }
      if (action === 'start-quest') {
        const poll = this.store.poll(id);
        if (!poll || poll.type !== 'quest' || poll.status !== 'ended' || poll.tied || poll.winnerOption === null) {
          this.json(res, 409, { error: 'Nur ein eindeutiger Quest-Umfragegewinner kann ausdrücklich gestartet werden.' }); return;
        }
        const questId = poll.options[poll.winnerOption]?.questId;
        if (!questId) { this.json(res, 409, { error: 'Die Gewinneroption ist nicht mit einer Quest verknüpft.' }); return; }
        const result = this.store.transitionQuest(questId, 'active', session.userId, now, this.questPolicy());
        if (!result.ok) { this.json(res, 409, { error: questTransitionError(result.reason) }); return; }
        this.audit(session, 'quest-start-from-poll', questId, { pollId: id }, now); this.json(res, 200, { quest: result.quest }); return;
      }
      this.json(res, 400, { error: 'Umfrage-Aktion ist ungültig.' }); return;
    }
    if (route === 'widgets/token') {
      const type = body.type as WidgetType;
      if (!['quest','poll','imposter','detective','pet','drop','wheel','vault'].includes(String(type))) { this.json(res, 400, { error: 'Widget-Typ ist ungültig.' }); return; }
      if (body.action === 'revoke') {
        this.store.revokeWidgetToken(type, now, session.userId); this.audit(session, 'widget-token-revoke', type, {}, now);
        this.json(res, 200, { ok: true }); return;
      }
      if (body.action !== 'rotate') { this.json(res, 400, { error: 'Widget-Token-Aktion ist ungültig.' }); return; }
      const token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex');
      this.store.rotateWidgetToken(type, hash, now, session.userId);
      const widgetUrl = new URL(`/widgets/${type}`, new URL(this.redirectUri).origin); widgetUrl.searchParams.set('token', token);
      this.audit(session, 'widget-token-rotate', type, {}, now);
      this.json(res, 201, { url: widgetUrl.toString() }); return;
    }
    if (route === 'events') {
      const id = String(body.id || '').toLowerCase();
      if (typeof body.active === 'boolean' && Object.keys(body).length <= 2) {
        const ok = this.store.setEventActive(id, body.active, now); if (!ok) { this.json(res, 409, { error: 'Event nicht gefunden oder ein anderes Event läuft bereits.' }); return; }
        this.audit(session, body.active ? 'event-start' : 'event-end', id, {}, now); this.json(res, 200, { ok: true }); return;
      }
      if (!/^[a-z0-9_-]{2,40}$/u.test(id)) { this.json(res, 400, { error: 'Event-ID ungültig.' }); return; }
      const old = this.store.event(id);
      const event: SeasonalEvent = { id, name: clean(String(body.name || old?.name || ''), 80), emoji: clean(String(body.emoji || old?.emoji || '✨'), 8),
        active: old?.active || false, startAt: numberOrNull(body.startAt, old?.startAt ?? null), endAt: numberOrNull(body.endAt, old?.endAt ?? null),
        timezone: clean(String(body.timezone || old?.timezone || 'Europe/Berlin'), 64), currency: clean(String(body.currency || old?.currency || ''), 32),
        cooldownMs: boundedInt(body.cooldownMs, old?.cooldownMs ?? 900_000, 0, 86_400_000), command: clean(String(body.command || old?.command || ''), 32).replace(/^!/u, '').toLowerCase(),
        archivedAt: old?.archivedAt ?? null, weights: id === 'halloween' ? old?.weights || { TREAT: 55, JACKPOT: 5, EMPTY_HOUSE: 40 }
          : isRecord(body.weights) ? body.weights as Record<string, number> : old?.weights || { TREAT: 55, JACKPOT: 5, EMPTY_HOUSE: 40 },
        texts: id === 'halloween' ? old?.texts || {} : isRecord(body.texts) ? body.texts as Record<string, string> : old?.texts || {} };
      if (!event.name || !event.currency || !/^[a-z0-9_]{2,32}$/u.test(event.command) || (event.id === 'halloween' && event.command !== 'trickortreat')
        || (event.startAt && event.endAt && event.endAt <= event.startAt)) { this.json(res, 400, { error: 'Event-Eingaben sind ungültig; Halloween behält !trickortreat.' }); return; }
      this.store.saveEvent(event); this.audit(session, old ? 'event-update' : 'event-create', id, { name: event.name }, now); this.json(res, 200, { ok: true }); return;
    }
    if (route === 'xp-adjust') {
      const userId = clean(String(body.userId || ''), 64), amount = Number(body.amount), reason = clean(String(body.reason || ''), 200);
      if (!userId || !Number.isInteger(amount) || Math.abs(amount) > 100_000 || !reason) { this.json(res, 400, { error: 'XP-Korrektur ist ungültig.' }); return; }
      const player = this.store.xp(userId); this.store.adjustXp(userId, player.displayName === userId ? userId : player.displayName, amount, session.userId, reason, now);
      this.json(res, 200, { ok: true }); return;
    }
    if (route === 'commands/delete') {
      const name = clean(String(body.name || ''), 32).replace(/^!/u, '').toLowerCase();
      if (!name || !this.store.deleteCustomCommand(name)) { this.json(res, 404, { error: 'Chatbefehl nicht gefunden.' }); return; }
      this.audit(session, 'custom-command-delete', name, {}, now); this.json(res, 200, { ok: true }); return;
    }
    if (route === 'commands') {
      try {
        const command: CustomCommand = { name: String(body.name || ''), response: String(body.response || ''), enabled: body.enabled !== false,
          permission: body.permission === 'moderator' || body.permission === 'broadcaster' ? body.permission : 'everyone',
          cooldownMs: boundedInt(body.cooldownMs, 10_000, 0, 86_400_000), alias: body.alias ? String(body.alias) : null,
          expiresAt: numberOrNull(body.expiresAt, null), modsMayManage: body.modsMayManage === true };
        this.store.addCustomCommand(command); this.audit(session, 'custom-command-save', command.name, {}, now); this.json(res, 200, { ok: true }); return;
      } catch { this.json(res, 400, { error: 'Befehl ungültig oder Name/Platzhalter reserviert.' }); return; }
    }
    if (route === 'boss') {
      if (body.action === 'end') { const ok = this.store.endBoss(now); if (ok) this.audit(session, 'boss-end', 'active', {}, now); this.json(res, 200, { ok }); return; }
      const name = clean(String(body.name || 'Schattenkönig'), 80), hp = boundedInt(body.hp, 1000, 1, 1_000_000);
      const ok = this.store.startBoss(randomUUID(), name, hp, boundedInt(body.durationMs, 900_000, 60_000, 86_400_000), now);
      if (ok) this.audit(session, 'boss-start', name, { hp }, now); this.json(res, ok ? 200 : 409, { ok, ...(ok ? {} : { error: 'Ein Bosskampf läuft bereits.' }) }); return;
    }
    this.json(res, 404, { error: 'API-Endpunkt nicht gefunden.' });
  }

  private async discordIntegrationRoute(url:URL,req:http.IncomingMessage,res:http.ServerResponse,clientIp:string):Promise<void>{
    res.setHeader('Cache-Control','no-store');
    const supplied=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
    const expected=this.discordIntegrationSecret;
    const a=Buffer.from(supplied),b=Buffer.from(expected);
    if(expected.length<32||a.length!==b.length||!timingSafeEqual(a,b)){this.json(res,401,{error:'Integration nicht autorisiert.'});return;}
    if(this.rejectRateLimit(res,this.rates.consume('discord-integration',clientIp,120,60_000),'Discord-Integration kurz gedrosselt.'))return;
    if(url.pathname==='/api/discord/v1/config'&&req.method==='GET'){
      const settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      this.json(res,200,{enabled:settings.enabled,ideasChannelId:settings.ideasChannelId,rewardsChannelId:settings.rewardsChannelId,liveChannelId:settings.liveChannelId,dropChannelId:settings.dropChannelId,features:{elioEnabled:settings.elioEnabled,discordDropsEnabled:settings.discordDropsEnabled},notifications:{ideas:settings.notifyIdeas,levels:settings.notifyLevels,drops:settings.notifyDrops,quests:settings.notifyQuests,seasonal:settings.notifySeasonal,live:settings.notifyLive}});return;
    }
    if(url.pathname==='/api/discord/v1/heartbeat'&&req.method==='POST'){
      const body=await this.readJson(req);if(!body||typeof body.guildId!=='string'||!/^\d{17,20}$/u.test(body.guildId)){this.json(res,400,{error:'Ungültiger Discord-Heartbeat.'});return;}
      this.store.setState('discord_integration_last_seen',{at:Date.now(),guildId:body.guildId},Date.now());this.json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/discord/v1/community/elio'&&req.method==='GET'){
      const settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      if(!settings.enabled||!settings.elioEnabled||!this.arcade?.settings().petEnabled){this.json(res,409,{error:'Elio ist in Discord derzeit nicht verfügbar.'});return;}
      const snapshot=this.arcade.snapshot('pet');this.json(res,200,{available:true,pet:snapshot.pet,events:(snapshot.events as unknown[]|undefined)?.slice(0,5)||[]});return;
    }
    if(url.pathname==='/api/discord/v1/community/elio/action'&&req.method==='POST'){
      const body=await this.readJson(req),settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      if(!body||typeof body.eventId!=='string'||!/^\d{17,20}$/u.test(body.eventId)||typeof body.discordUserId!=='string'||!/^\d{17,20}$/u.test(body.discordUserId)||typeof body.displayName!=='string'||!['feed','play','care'].includes(String(body.action))){this.json(res,400,{error:'Ungültige Elio-Aktion.'});return;}
      if(!settings.enabled||!settings.elioEnabled||!this.arcade?.settings().petEnabled){this.json(res,409,{error:'Elio ist in Discord derzeit nicht verfügbar.'});return;}
      if(this.rejectRateLimit(res,this.rates.consume('discord-elio',body.discordUserId,4,60_000),'Elio-Aktion kurz gedrosselt. Bitte gleich erneut versuchen.'))return;
      const twitchUserId=this.store.communityTwitchIdForDiscord(body.discordUserId);if(!twitchUserId){this.json(res,403,{error:'Verbinde zuerst dein Twitch-Konto mit /verknuepfen.'});return;}
      const name=String(body.displayName).replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,48)||'Community-Mitglied';
      const kind=String(body.action) as 'feed'|'play'|'care';
      const result=this.arcade.interactFromPortal({eventId:`discord:${body.eventId}`,broadcasterUserId:'discord-community',senderUserId:twitchUserId,senderLogin:name,senderDisplayName:name,message:`/${kind}`,sentAt:Date.now()},kind,Date.now());
      if(!result.ok){this.json(res,409,{error:result.message,remainingMs:result.remainingMs});return;}
      const snapshot=this.arcade.snapshot('pet');this.json(res,200,{ok:true,reaction:result.reaction,changes:result.changes,leveledUp:result.leveledUp===true,remainingMs:result.remainingMs,pet:snapshot.pet});return;
    }
    if(url.pathname==='/api/discord/v1/community/drop'&&req.method==='GET'){
      const settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      if(!settings.enabled||!settings.discordDropsEnabled||!this.arcade?.settings().dropsEnabled){this.json(res,409,{error:'Mystery Drops sind in Discord derzeit nicht verfügbar.'});return;}
      this.json(res,200,this.arcade.snapshot('drop'));return;
    }
    if(url.pathname==='/api/discord/v1/community/drop/claim'&&req.method==='POST'){
      const body=await this.readJson(req),settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      if(!body||typeof body.eventId!=='string'||!/^\d{17,20}$/u.test(body.eventId)||typeof body.discordUserId!=='string'||!/^\d{17,20}$/u.test(body.discordUserId)||typeof body.displayName!=='string'||typeof body.dropId!=='string'||!/^[-a-f0-9]{8,64}$/iu.test(body.dropId)){this.json(res,400,{error:'Ungültige Drop-Teilnahme.'});return;}
      if(!settings.enabled||!settings.discordDropsEnabled||!this.arcade?.settings().dropsEnabled){this.json(res,409,{error:'Mystery Drops sind in Discord derzeit nicht verfügbar.'});return;}
      if(this.rejectRateLimit(res,this.rates.consume('discord-drop-claim',body.discordUserId,8,60_000),'Zu viele Teilnahmeversuche. Bitte kurz warten.'))return;
      const twitchUserId=this.store.communityTwitchIdForDiscord(body.discordUserId);if(!twitchUserId){this.json(res,403,{error:'Verbinde zuerst dein Twitch-Konto mit /verknuepfen.'});return;}
      const name=String(body.displayName).replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,48)||'Community-Mitglied';
      const result=this.arcade.claimFromPortal({eventId:`discord:${body.eventId}`,broadcasterUserId:'discord-community',senderUserId:twitchUserId,senderLogin:name,senderDisplayName:name,message:'/claim',sentAt:Date.now()},Date.now(),body.dropId);
      if(!result.ok){this.json(res,409,{error:result.message});return;}
      this.json(res,200,{ok:true,joined:result.joined,message:result.joined?'Du bist beim Mystery Drop dabei!':'Deine Teilnahme ist bereits gespeichert.',participants:result.participants,dropId:result.dropId});return;
    }
    if(url.pathname==='/api/discord/v1/outbox/poll'&&req.method==='POST'){
      const settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      if(!settings.enabled){this.json(res,200,{events:[]});return;}
      this.json(res,200,{events:this.store.discordOutboxBatch(Date.now(),25)});return;
    }
    if(url.pathname==='/api/discord/v1/outbox/ack'&&req.method==='POST'){
      const body=await this.readJson(req);if(!body||typeof body.id!=='string'||typeof body.success!=='boolean'){this.json(res,400,{error:'Ungültige Zustellbestätigung.'});return;}
      const ok=this.store.settleDiscordOutbox(body.id,body.success,Date.now(),typeof body.error==='string'?body.error.slice(0,300):undefined);
      this.json(res,ok?200:409,{ok});return;
    }
    if(url.pathname==='/api/discord/v1/ideas'&&req.method==='POST'){
      const body=await this.readJson(req);if(!body||typeof body.eventId!=='string'||!/^\d{17,20}$/u.test(body.eventId)||typeof body.discordUserId!=='string'||!/^\d{17,20}$/u.test(body.discordUserId)||typeof body.displayName!=='string'||typeof body.text!=='string'||typeof body.category!=='string'){this.json(res,400,{error:'Ungültige Idee.'});return;}
      const category=body.category.slice(0,40);if(!['Stream','Community','Event','Bot','Technik','Sonstiges'].includes(category)){this.json(res,400,{error:'Bitte eine gültige Kategorie wählen.'});return;}
      const text=normalizeCommunityText(body.text,8,240);if(!text){this.json(res,400,{error:'Der Vorschlag muss zwischen 8 und 240 Zeichen lang sein.'});return;}
      const result=this.store.submitDiscordCommunityIdea({eventId:body.eventId,id:randomUUID(),discordUserId:body.discordUserId,displayName:body.displayName,text,category,now:Date.now()});
      const error=result.ok?undefined:result.reason==='duplicate'?'Diese Idee wurde von dir bereits eingereicht.':result.reason==='cooldown'?'Bitte warte noch etwas, bevor du eine weitere Idee einreichst.':result.reason==='limit'?'Du hast bereits fünf offene Ideen.': 'Die Idee ist ungültig.';
      this.json(res,result.ok?201:result.reason==='invalid'?400:409,{...result,...(error?{error}:{})});return;
    }
    if(url.pathname==='/api/discord/v1/account-links/intents'&&req.method==='POST'){
      const body=await this.readJson(req);
      if(!body||typeof body.discordUserId!=='string'||!/^[0-9]{17,20}$/u.test(body.discordUserId)){this.json(res,400,{error:'Ungültige Discord-Identität.'});return;}
      const settings=this.store.config<typeof DISCORD_DEFAULTS>('discord_integration',DISCORD_DEFAULTS);
      if(!settings.enabled||!settings.accountLinkEnabled){this.json(res,403,{error:'Die Konto-Verknüpfung ist derzeit deaktiviert.'});return;}
      const decision=this.rates.consume('discord-link-intent',body.discordUserId,3,10*60_000);
      if(this.rejectRateLimit(res,decision,'Zu viele Verknüpfungsversuche. Bitte später erneut versuchen.'))return;
      const token=randomBytes(32).toString('base64url'),now=Date.now();
      this.store.createCommunityAccountLinkIntent({tokenHash:createHash('sha256').update(token).digest('hex'),discordUserId:body.discordUserId,createdAt:now,expiresAt:now+10*60_000});
      this.json(res,201,{ok:true,authorizationUrl:`${new URL(this.redirectUri).origin}/community/link/twitch#token=${encodeURIComponent(token)}`,expiresAt:now+10*60_000});return;
    }
    if(url.pathname==='/api/discord/v1/account-links/status'&&req.method==='POST'){
      const body=await this.readJson(req);
      if(!body||typeof body.discordUserId!=='string'||!/^[0-9]{17,20}$/u.test(body.discordUserId)){this.json(res,400,{error:'Ungültige Discord-Identität.'});return;}
      this.json(res,200,this.store.communityAccountLinkStatus(body.discordUserId));return;
    }
    if(url.pathname==='/api/discord/v1/account-links/disconnect'&&req.method==='POST'){
      const body=await this.readJson(req);
      if(!body||typeof body.discordUserId!=='string'||!/^[0-9]{17,20}$/u.test(body.discordUserId)||typeof body.eventId!=='string'||!/^[0-9]{17,20}$/u.test(body.eventId)){this.json(res,400,{error:'Ungültige Trennungsanfrage.'});return;}
      this.json(res,200,{ok:true,disconnected:this.store.disconnectCommunityAccountLink({discordUserId:body.discordUserId,now:Date.now()})});return;
    }
    if(url.pathname==='/api/discord/v1/ideas/vote'&&req.method==='POST'){
      const body=await this.readJson(req);if(!body||typeof body.eventId!=='string'||!/^\d{17,20}$/u.test(body.eventId)||typeof body.ideaId!=='string'||!/^\S{8,64}$/u.test(body.ideaId)||typeof body.discordUserId!=='string'||!/^\d{17,20}$/u.test(body.discordUserId)){this.json(res,400,{error:'Ungültige Stimme.'});return;}
      const result=this.store.voteDiscordCommunityIdea({eventId:body.eventId,ideaId:body.ideaId,discordUserId:body.discordUserId,now:Date.now()});
      this.json(res,result.ok?200:409,{...result,...(!result.ok?{error:result.reason==='not-found'?'Diese Idee ist nicht verfügbar.':'Deine Zustimmung wurde bereits gezählt oder die Idee ist nicht mehr offen.'}:{})});return;
    }
    res.statusCode=404;this.json(res,404,{error:'Nicht gefunden.'});
  }

  private moderationMemory(row:Record<string,unknown>):Record<string,unknown>{return{id:row.id,body:row.body,clipUrl:row.clip_url,category:row.category,eventName:row.event_name,status:row.status,featured:Boolean(row.featured),reactions:Number(row.reactions||0),submittedAt:row.submitted_at,publishedAt:row.published_at,submitterName:row.submitter_name};}

  private authenticate(req: http.IncomingMessage, res: http.ServerResponse, api = false): Session | undefined {
    const key = this.cookieSession(req); const session = key ? this.sessions.get(key) : undefined;
    if (!session || session.expiresAt <= Date.now() || (session.role==='admin'?!this.adminIds.has(session.userId):!this.moderatorIds.has(session.userId))) {
      if (key) this.sessions.delete(key); this.clearCookie(res);
      if (api) this.json(res, 401, { error: 'Anmeldung erforderlich.' });
      else { res.statusCode = 302; res.setHeader('Location', '/dashboard/login'); res.end(); }
      return undefined;
    }
    return session;
  }

  private checkCsrf(req: http.IncomingMessage, session: Session): boolean {
    const supplied = req.headers['x-csrf-token'] || '';
    const expectedOrigin = new URL(this.redirectUri).origin;
    const origin = req.headers.origin || '';
    const localTunnel = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin);
    const validToken = typeof supplied === 'string' && supplied.length === session.csrf.length
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf));
    if (!validToken || (origin !== expectedOrigin && !localTunnel)) return false;
    return true;
  }

  private cookieSession(req: http.IncomingMessage): string | undefined {
    return this.cookieValue('community_admin', req);
  }

  private cookieValue(name: string, req: http.IncomingMessage): string | undefined {
    const prefix = `${name}=`;
    return req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  }

  private clearCookie(res: http.ServerResponse): void { res.setHeader('Set-Cookie', 'community_admin=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0'); }

  private rejectRateLimit(res: http.ServerResponse, decision: RateLimitDecision, message: string): boolean {
    if (decision.allowed) return false;
    setRateLimitHeaders(res, decision.retryAfterSeconds);
    this.json(res, 429, { error: message, retryAfterSeconds: decision.retryAfterSeconds });
    return true;
  }

  private async readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += data.length; if (length > 32_768) return undefined; chunks.push(data); }
    try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); return isRecord(parsed) ? parsed : undefined; } catch { return undefined; }
  }

  private audit(session: Session, action: string, target: string, details: unknown, now: number): void {
    this.store.adminAudit(session.userId, action, target, details, now);
  }

  private questPolicy(): QuestPolicy {
    const settings = this.store.config<QuestPolicy>('quest_settings', defaultQuestSettings());
    return { maxLength: settings.maxLength, queueLimit: settings.queueLimit, maxOpenPerUser: settings.maxOpenPerUser,
      cooldownMs: settings.cooldownMs, activeDurationMs: settings.activeDurationMs, completionXp: settings.completionXp };
  }

  private openEventStream(url: URL, req: http.IncomingMessage, res: http.ServerResponse, userId: string): void {
    const forUser = [...this.eventStreams.values()].filter((stream) => stream.userId === userId).length;
    if (forUser >= 3 || this.eventStreams.size >= 50) {
      setRateLimitHeaders(res, 10); this.json(res, 429, { error: 'Für dein Dashboard sind bereits genügend Live-Verbindungen geöffnet.', retryAfterSeconds: 10 }); return;
    }
    let lastId = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(lastId) || lastId < 0) lastId = 0;
    res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    const send = () => {
      try {
        const events = this.store.communityEventsAfter(lastId, 100);
        for (const event of events) {
          res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          lastId = event.id;
        }
        if (events.length === 0) res.write(': keepalive\n\n');
      } catch { res.end(); }
    };
    send();
    const timer = setInterval(send, 10_000);
    this.eventStreams.set(res, { timer, userId });
    res.on('close', () => { clearInterval(timer); this.eventStreams.delete(res); });
  }

  private headers(res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }

  private publicHelpAvailability():HelpAvailability {
    const modules=this.store.config<Record<string,boolean>>('modules',{}),active=this.store.activeEvent();
    const arcade=this.arcade?.settings(),mini=this.miniGames?.settings();
    const quest=this.store.config<{enabled?:boolean}>('quest_settings',{});
    const spark=normalizeSparkConfig(this.store.config<unknown>('spark_settings',DEFAULT_SPARK_CONFIG));
    const seasonalEvents=this.store.events().map(event=>({id:event.id,name:event.name,command:event.command,active:event.active&&(event.id==='halloween'||modules.events!==false)}));
    const activeEnabled=Boolean(active&&(active.id==='halloween'||modules.events!==false));
    const help:HelpAvailability={...DEFAULT_HELP_AVAILABILITY,xp:modules.xp!==false,events:activeEnabled,
      pet:arcade?.petEnabled??false,petCare:(arcade?.petEnabled??false)&&!Boolean((this.arcade?.snapshot('pet').pet as {paused?:boolean}|undefined)?.paused),
      drops:arcade?.dropsEnabled??false,wheel:arcade?.wheelEnabled??false,
      vault:this.vault?.settings().enabled??false,
      imposter:mini?.enabled??false,detective:mini?.enabled??false,quests:modules.quests!==false&&quest.enabled!==false,spark:spark.enabled,
      eightBall:modules.eightBall!==false,rps:modules.rps!==false,guess:modules.guess!==false,duels:modules.duels!==false,seasonalEvents};
    if(activeEnabled&&active){help.activeEventId=active.id;help.activeEventName=active.name;help.activeEventCommand=active.command;}
    return help;
  }

  private chatHintBusyReason(now:number,runtime:RuntimeStatus):string|undefined {
    const mini=this.miniGames?.snapshot(now) as {imposter?:unknown;detective?:unknown}|undefined;
    if(mini?.imposter||mini?.detective||this.store.activeQuest()||this.store.activePoll(now)||this.store.activeBoss(now)
      ||this.vault?.isActive(now))return 'Gerade läuft ein Community-Spiel.';
    const drop=this.arcade?.snapshot('drop',now).drop as {status?:string}|undefined;
    if(['announced','claiming','resolving'].includes(drop?.status||'')||this.arcade?.wheelStatus(now).active)return 'Gerade läuft eine Community-Aktion.';
    if((runtime.queued??0)>0)return 'Der Bot versendet gerade eine andere Chatnachricht.';
    return undefined;
  }

  private json(res: http.ServerResponse, status: number, payload: unknown): void {
    res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload));
  }
}

function clean(value: string, max: number): string { return Array.from(value.replace(/[\r\n\t]/gu, ' ').trim()).slice(0, max).join(''); }
function escapeHtml(value:string):string { return value.replace(/[&<>"']/gu,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)); }
function boundedInt(value: unknown, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function numberOrNull(value: unknown, fallback: number | null): number | null { if (value === undefined || value === null || value === '') return fallback; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function defaultQuestSettings(): DashboardQuestSettings {
  return { enabled: true, chatEnabled: true, channelPointsEnabled: false, maxLength: 180, queueLimit: 100,
    maxOpenPerUser: 2, cooldownMs: 300_000, activeDurationMs: 0, completionXp: 25,
    modsCanModerate: false, modsCanSkip: false, moderatorUserIds: [] };
}

function defaultPollSettings(): DashboardPollSettings {
  return { enabled: true, durationMs: 60_000, allowVoteChange: true, ignoredUserIds: [] };
}

function defaultWidgetSettings(): { theme: 'violet'; fontSize: number } { return { theme: 'violet', fontSize: 34 }; }

function normalizeQuestSettings(input: unknown, current: DashboardQuestSettings): Record<string, unknown> {
  const allowed = new Set(['enabled','chatEnabled','channelPointsEnabled','maxLength','queueLimit','maxOpenPerUser','cooldownMs',
    'activeDurationMs','completionXp','modsCanModerate','modsCanSkip','moderatorUserIds']);
  if (!isRecord(input) || Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Quest-Einstellungen enthalten unbekannte Felder.');
  const numericKeys = ['maxLength','queueLimit','maxOpenPerUser','cooldownMs','activeDurationMs','completionXp'];
  const numbers = normalizeNumbers(Object.fromEntries(Object.entries(input).filter(([key]) => numericKeys.includes(key))), current as unknown as Record<string, number>, {
    maxLength: [20,240], queueLimit: [1,500], maxOpenPerUser: [1,10], cooldownMs: [10_000,86_400_000],
    activeDurationMs: [0,86_400_000], completionXp: [0,1000],
  });
  const enabled = boolValue(input.enabled, current.enabled, 'Quest aktiv');
  const chatEnabled = boolValue(input.chatEnabled, current.chatEnabled, 'Chat-Quests');
  const channelPointsEnabled = boolValue(input.channelPointsEnabled, current.channelPointsEnabled, 'Kanalpunkte');
  if (channelPointsEnabled) throw new Error('Kanalpunkte-Redemptions sind in dieser Version noch nicht angebunden; die Option muss deaktiviert bleiben.');
  const modsCanModerate = boolValue(input.modsCanModerate, current.modsCanModerate, 'Moderatoren-Freigabe');
  const modsCanSkip = boolValue(input.modsCanSkip, current.modsCanSkip, 'Moderator-Überspringen');
  return { ...numbers, enabled, chatEnabled, channelPointsEnabled, modsCanModerate, modsCanSkip,
    moderatorUserIds: userIdList(input.moderatorUserIds, current.moderatorUserIds, 'Quest-Moderatoren') };
}

function normalizePollSettings(input: unknown, current: DashboardPollSettings): Record<string, unknown> {
  const allowed = new Set(['enabled','durationMs','allowVoteChange','ignoredUserIds']);
  if (!isRecord(input) || Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Umfrage-Einstellungen enthalten unbekannte Felder.');
  const numbers = normalizeNumbers(Object.fromEntries(Object.entries(input).filter(([key]) => key === 'durationMs')),
    current as unknown as Record<string, number>, { durationMs: [10_000,3_600_000] });
  return { ...numbers, enabled: boolValue(input.enabled, current.enabled, 'Umfragen'),
    allowVoteChange: boolValue(input.allowVoteChange, current.allowVoteChange, 'Stimmenänderungen'),
    ignoredUserIds: userIdList(input.ignoredUserIds, current.ignoredUserIds, 'Ausgeschlossene Abstimmende') };
}

function normalizeWidgetSettings(input: unknown, current: { theme: string; fontSize: number }): { theme: string; fontSize: number } {
  if (!isRecord(input) || Object.keys(input).some((key) => !['theme','fontSize'].includes(key))) throw new Error('Widget-Einstellungen sind ungültig.');
  const theme = input.theme === undefined ? current.theme : input.theme;
  if (theme !== 'violet' && theme !== 'halloween') throw new Error('Widget-Design muss violet oder halloween sein.');
  const fontSize = input.fontSize === undefined ? current.fontSize : input.fontSize;
  if (!Number.isSafeInteger(fontSize) || (fontSize as number) < 22 || (fontSize as number) > 54) throw new Error('Widget-Schriftgröße muss zwischen 22 und 54 liegen.');
  return { theme, fontSize: fontSize as number };
}

function boolValue(value: unknown, fallback: unknown, label: string): boolean {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'boolean') throw new Error(`${label}: boolescher Wert erwartet.`);
  return result;
}

function userIdList(value: unknown, fallback: unknown, label: string): string[] {
  const result = value === undefined ? fallback : value;
  if (!Array.isArray(result) || result.length > 100 || result.some((id) => typeof id !== 'string' || !/^[0-9]{1,32}$/u.test(id))) {
    throw new Error(`${label}: höchstens 100 numerische Twitch-User-IDs erwartet.`);
  }
  return [...new Set(result as string[])];
}

function normalizeCommunityText(value: string, min: number, max: number): string | undefined {
  const normalized = value.normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (length < min || length > max || /[\u0000-\u001F\u007F<>\u202A-\u202E\u2066-\u2069]/u.test(normalized)) return undefined;
  if (!normalized.replace(/[\p{P}\p{S}\s]/gu, '')) return undefined;
  return normalized;
}

function questTransitionError(reason: 'missing' | 'invalid-transition' | 'active-exists' | 'not-approved'): string {
  if (reason === 'missing') return 'Quest nicht gefunden.';
  if (reason === 'active-exists') return 'Es läuft bereits eine Quest.';
  if (reason === 'not-approved') return 'Nur freigegebene Quests können gestartet werden.';
  return 'Dieser Quest-Statuswechsel ist nicht zulässig.';
}

function normalizeNumbers(
  input: unknown,
  current: Record<string, number>,
  rules: Record<string, [number, number]>,
): Record<string, number> {
  if (!isRecord(input) || Object.keys(input).some((key) => !(key in rules))) throw new Error('Numerische Konfiguration enthält unbekannte Felder.');
  const output: Record<string, number> = {};
  for (const [key, [min, max]] of Object.entries(rules)) {
    const value = input[key] ?? current[key];
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Einstellung ${key} muss eine ganze Zahl von ${min} bis ${max} sein.`);
    output[key] = value as number;
  }
  return output;
}

function normalizeEvents(input: unknown, current: SeasonalEvent[]): SeasonalEvent[] {
  if (!Array.isArray(input) || input.length > 50) throw new Error('Event-Konfiguration muss eine Liste mit höchstens 50 Einträgen sein.');
  const oldEvents = new Map(current.map((event) => [event.id, event]));
  const seen = new Set<string>();
  return input.map((value) => {
    if (!isRecord(value)) throw new Error('Event-Konfiguration ist ungültig.');
    const id = String(value.id || '').toLowerCase(); const old = oldEvents.get(id);
    if (!/^[a-z0-9_-]{2,40}$/u.test(id) || seen.has(id)) throw new Error('Event-ID fehlt, ist ungültig oder doppelt.');
    seen.add(id);
    const parseDate = (key: 'startAt' | 'endAt', fallback: number | null): number | null => {
      const raw = value[key];
      if (raw === undefined) return fallback;
      if (raw === null || raw === '') return null;
      if (!Number.isSafeInteger(raw) || (raw as number) <= 0) throw new Error(`Eventdatum ${key} ist ungültig.`);
      return raw as number;
    };
    const weights = value.weights === undefined ? old?.weights || {} : value.weights;
    const texts = value.texts === undefined ? old?.texts || {} : value.texts;
    if (!isRecord(weights) || !isRecord(texts)) throw new Error('Event-Gewichtungen oder -Texte sind ungültig.');
    const command = clean(String(value.command ?? old?.command ?? ''), 32).replace(/^!/u, '').toLowerCase();
    if (id === 'halloween' && command !== 'trickortreat') throw new Error('Halloween behält seinen bestehenden Befehl !trickortreat.');
    return {
      id, name: clean(String(value.name ?? old?.name ?? ''), 80), emoji: clean(String(value.emoji ?? old?.emoji ?? '✨'), 8),
      active: old?.active ?? false, startAt: parseDate('startAt', old?.startAt ?? null), endAt: parseDate('endAt', old?.endAt ?? null),
      timezone: clean(String(value.timezone ?? old?.timezone ?? 'Europe/Berlin'), 64),
      currency: clean(String(value.currency ?? old?.currency ?? ''), 32),
      cooldownMs: Number(value.cooldownMs ?? old?.cooldownMs ?? 900_000),
      command,
      archivedAt: old?.archivedAt ?? null,
      weights: id === 'halloween' && old ? old.weights : weights as Record<string, number>,
      texts: id === 'halloween' && old ? old.texts : texts as Record<string, string>,
    };
  });
}
