import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { FeatureStore, type CustomCommand, type QuestPolicy, type QuestStatus, type SeasonalEvent, type WidgetType } from './feature-store.js';
import { communityWidgetHtml, ARCADE_CARD, ARCADE_SCRIPT, QUEST_POLL_CARD, QUEST_POLL_SCRIPT } from './dashboard-community-ui.js';
import { SPARK_CARD, SPARK_SCRIPT } from './conversation-spark-ui.js';
import { MINI_GAME_CARD, MINI_GAME_SCRIPT } from './mini-games-ui.js';
import { CHANNEL_POINTS_CARD, CHANNEL_POINTS_SCRIPT } from './channel-points-ui.js';
import type { MiniGames } from './mini-games.js';
import type { ChaosWheelActionType, CommunityArcade } from './community-arcade.js';
import type { ChannelPointsService } from './channel-points.js';
import { DEFAULT_CHANNEL_POINTS_SETTINGS } from './channel-points.js';
import type { Logger } from './logger.js';
import { DEFAULT_SPARK_CONFIG, normalizeSparkConfig } from './conversation-spark.js';
import { DASHBOARD_UX_V3_SCRIPT } from './dashboard-ux.js';
import { ChatResponsePolicy, DEFAULT_CHAT_RESPONSE_SETTINGS } from './chat-response-policy.js';
import type { ChatCategory } from './chat-message-format.js';
import { DEFAULT_HELP_AVAILABILITY, type HelpAvailability } from './help.js';
import { renderPublicHelpPage } from './public-help.js';
import { CommunityTips } from './community-tips.js';
import { AutomaticChatMessages } from './automatic-chat-messages.js';
import type { SpotifySongRequests } from './song-requests.js';
import { SONG_REQUESTS_CARD, SONG_REQUESTS_SCRIPT } from './song-requests-ui.js';
import { formatPublicChatMessage } from './chat-message-format.js';

interface Session { userId: string; login: string; csrf: string; expiresAt: number; }
interface RuntimeStatus { twitchConnected: boolean; channel: string; startedAt: number; lastError?: string; queued?: number; suppressed?: number; chatResponse?: { profile: string; suppressed: number; deferred: number }; }
interface TokenValidation { client_id: string; user_id: string; login: string; }
interface HelixUser { id: string; login: string; display_name: string; }
type DashboardQuestSettings = QuestPolicy & { enabled: boolean; chatEnabled: boolean; channelPointsEnabled: boolean;
  modsCanModerate: boolean; modsCanSkip: boolean; moderatorUserIds: string[] };
type DashboardPollSettings = { enabled: boolean; durationMs: number; allowVoteChange: boolean; ignoredUserIds: string[] };

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STREAMER_PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf" content="__CSRF__"><title>Streamer-Steuerung</title><style nonce="__NONCE__">:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#101116;color:#eef0f8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 85% 0,#30234a 0,transparent 35%),#101116}main{max-width:980px;margin:auto;padding:24px 20px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1{font-size:1.4rem;margin:0}a{color:#c6a8ff}.toolbar{display:flex;gap:8px;align-items:center}.status{color:#aaaec0;font-size:.9rem}.group{margin:22px 0}.group h2{font-size:1rem;color:#c6a8ff;margin:0 0 9px}.row{display:grid;grid-template-columns:42px minmax(130px,1fr) minmax(120px,1.4fr) auto;gap:12px;align-items:center;padding:12px 14px;background:#1b1d29;border:1px solid #303342;border-radius:12px;margin:8px 0}.icon{font-size:1.35rem;text-align:center}.name{font-weight:700}.state{color:#b8bbca;font-size:.92rem}.actions{display:flex;gap:6px;justify-content:flex-end}button{font:inherit;color:#fff;background:#7652bd;border:0;border-radius:9px;padding:10px 14px;cursor:pointer;min-height:42px}button.secondary{background:#292b39}button.danger{background:#8c3d50}button:disabled{opacity:.45;cursor:not-allowed}.notice{min-height:24px;color:#f2d5ac}.compact{font-size:.86rem}@media(max-width:620px){main{padding:14px 10px}.row{grid-template-columns:34px 1fr auto;gap:8px;padding:10px}.state{grid-column:2;grid-row:2}.actions{grid-column:3;grid-row:1/3;flex-direction:column}.actions button{padding:8px;font-size:.87rem}header{align-items:flex-start}.toolbar{flex-direction:column;align-items:flex-end}}@media(max-width:380px){.row{grid-template-columns:30px 1fr}.actions{grid-column:1/-1;grid-row:auto;flex-direction:row;justify-content:flex-start;margin-left:38px}.state{grid-column:2}}</style></head><body><main><header><div><h1>🎛 Streamer-Steuerung</h1><div id="stream-status" class="status">Status wird geladen …</div></div><div class="toolbar"><a href="/dashboard">Dashboard</a><button id="compact" class="secondary" type="button">Kompakt</button></div></header><div id="notice" class="notice" role="status"></div><section class="group"><h2>Gerade aktiv</h2><div id="active"></div></section><section class="group"><h2>Spiele &amp; Aktionen</h2><div id="games"></div></section><section class="group"><h2>Saison-Events &amp; Quests</h2><div id="community"></div></section></main><script nonce="__NONCE__">(()=>{const csrf=document.querySelector('meta[name=csrf]').content,el=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),seconds=t=>Math.max(0,Math.ceil((Number(t||0)-Date.now())/1000)),busy=new Set();async function api(path,method='GET',body){const r=await fetch('/dashboard/api/'+path,{method,headers:{'Content-Type':'application/json',...(method==='GET'?{}:{'X-CSRF-Token':csrf})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json().catch(()=>({error:'Antwort konnte nicht gelesen werden.'}));if(!r.ok)throw Error(d.error||'Aktion fehlgeschlagen.');return d}function button(label,action,kind='',disabled=false){return '<button type="button" class="'+kind+'" data-action="'+esc(action)+'" '+(disabled?'disabled':'')+'>'+esc(label)+'</button>'}function row(icon,name,state,actions=''){return '<article class="row"><div class="icon">'+icon+'</div><div class="name">'+esc(name)+'</div><div class="state">'+esc(state)+'</div><div class="actions">'+actions+'</div></article>'}async function update(){try{const [s,m,a,e,q]=await Promise.all(['status','minigames','arcade','events','quests'].map(x=>api(x)));const imp=m.state?.imposter,det=m.state?.detective,drop=a.drop?.drop,liveDrop=drop&&['announced','claiming','resolving'].includes(drop.status),wheel=a.wheel,active=[];if(imp)active.push(row('🎭','Chat-Imposter',imp.phase+' · '+(imp.players?.length||0)+' dabei · '+seconds(imp.endsAt)+' s',button('Abbrechen','cancel-imposter','danger')));if(det)active.push(row('🕵️','Chat-Detektiv',(det.phase==='playing'?'Raten läuft':'Ergebnis')+' · '+det.guesses+' Tipps · '+seconds(det.endsAt)+' s',button('Runde beenden','end-detective','danger')));if(liveDrop)active.push(row('🎁','Mystery Drop',(drop.participants||0)+' Teilnehmende · '+seconds(drop.endsAt)+' s'));if(wheel.activeAction)active.push(row('🎡','Chaos Wheel',wheel.activeAction.title+' · '+seconds(wheel.activeAction.endsAt)+' s'));const guess=await api('streamer-state');if(guess.guess)active.push(row('🔢','Zahlenraten','Runde aktiv · endet in '+seconds(guess.guess.expiresAt)+' s'));el('active').innerHTML=active.join('')||'<p class="status">Gerade läuft kein Spiel.</p>';const impAction=!m.settings.enabled?'Minispiele deaktiviert':!imp?'Anmeldung starten':imp.phase==='registration'?'Rollen verteilen':imp.phase==='playing'?'Abstimmung starten':imp.phase==='voting'?'Abstimmung läuft':'Warten …';let gameRows=[row('🎭','Chat-Imposter',imp?imp.phase+' · '+(imp.players?.length||0)+' Teilnehmende':(m.settings.enabled?'Bereit':'Deaktiviert'),imp?(imp.phase==='registration'?button('Rollen verteilen','close-imposter'):imp.phase==='playing'?button('Abstimmung starten','vote-imposter'):button('Abbrechen','cancel-imposter','danger')):button(impAction,'start-imposter', '',!m.settings.enabled)),row('🕵️','Chat-Detektiv',det?'Raten läuft · '+det.guesses+' Tipps':'Bereit',det?button('Runde beenden','end-detective','danger'):button(m.settings.enabled?'Runde starten':'Minispiele deaktiviert','start-detective','',!m.settings.enabled)),row('🎁','Mystery Drop',liveDrop?'Aktiv · '+(drop.participants||0)+' Teilnehmende · '+seconds(drop.endsAt)+' s':'Bereit · Zuschauer schreiben !claim',liveDrop?'':button('Drop starten','start-drop')),row('🎡','Chaos Wheel',wheel.autoPilotEnabled?'Automatik aktiv · '+(wheel.reason||''):'Pausiert · '+(wheel.reason||''),button(wheel.canSpin?'Jetzt drehen':wheel.autoPilotEnabled?'Pausieren':'Fortsetzen',wheel.canSpin?'spin':wheel.autoPilotEnabled?'pause-wheel':'resume-wheel',wheel.canSpin?'':'secondary',!wheel.canSpin&&wheel.autoPilotEnabled))];if(!guess.guessEnabled){}else gameRows.push(row('🔢','Zahlenraten',guess.guess?'Aktiv · '+seconds(guess.guess.expiresAt)+' s':'Start über vorhandenen Chatbefehl !startguess',guess.guess?'':'<span class="compact">Im Chat: <b>!startguess</b></span>'));el('games').innerHTML=gameRows.join('');const evts=e.events||[];el('community').innerHTML=evts.map(x=>row(x.emoji||'✨',x.name,x.active?'Aktiv':'Bereit',button(x.active?'Beenden':'Starten',x.active?'event-off:'+x.id:'event-on:'+x.id,x.active?'danger':''))).join('')+(q.active?row('📜','Aktive Quest',q.active.title+' · läuft',button('Abschließen','quest-complete:'+q.active.id,'secondary')):'');el('stream-status').textContent='Verbindung: '+(s.eventSubSocket?'Twitch verbunden':'wird geprüft')+' · aktualisiert';}catch(err){el('stream-status').textContent='Status konnte nicht geladen werden.';el('notice').textContent=err.message}}document.addEventListener('click',async ev=>{const b=ev.target.closest('[data-action]');if(!b||busy.has(b))return;const action=b.dataset.action;if(action==='cancel-imposter'||action==='end-detective'||action.startsWith('event-off:')||action.startsWith('quest-complete:'))if(!confirm('Möchtest du diese Aktion wirklich ausführen?'))return;busy.add(b);b.disabled=true;try{if(action.startsWith('event-on:')||action.startsWith('event-off:')){const [op,id]=action.split(':');await api('events','POST',{id,active:op==='event-on'})}else if(action==='quest-complete:'+action.split(':')[1])await api('quests/action','POST',{id:action.split(':')[1],action:'complete'});else if(action.startsWith('quest-complete:'))await api('quests/action','POST',{id:action.slice(15),action:'complete'});else if(action==='pause-wheel'||action==='resume-wheel'){const x=await api('arcade');await api('arcade','POST',{settings:{...x.settings,wheelAutoPilotEnabled:action==='resume-wheel'}})}else if(action==='start-drop'||action==='spin')await api('arcade','POST',{action});else await api('minigames/action','POST',{action});el('notice').textContent='Aktion ausgeführt.';await update()}catch(err){el('notice').textContent=err.message}finally{busy.delete(b);b.disabled=false}});el('compact').onclick=()=>document.body.classList.toggle('compact');update();setInterval(update,3000)})();</script></body></html>`;
const DASHBOARD_STYLE = `.main-nav{position:fixed;inset:0 auto 0 0;width:226px;box-sizing:border-box;z-index:8;padding:94px 14px 20px;background:#10111a;border-right:1px solid #292b39;display:flex;flex-direction:column;gap:7px}.main-nav button{display:flex;gap:11px;align-items:center;text-align:left;background:transparent;color:#aeb2c3;border:1px solid transparent;padding:12px 13px;border-radius:11px;margin:0}.main-nav button:hover{background:#211c30;color:#fff}.main-nav button[aria-current=page]{background:#2a2140;border-color:#534078;color:#f3edff}.dash-layout{margin-left:226px;min-height:calc(100vh - 88px)}.dashboard-view{display:none!important}.dashboard-view[data-active=true]{display:block!important}.dashboard-view>h2{margin:8px 0 4px;font-size:1.6rem}.view-intro{margin:0 0 18px}.view-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px;align-items:start}.view-grid>.card{margin:0;min-width:0}.view-header{display:flex;justify-content:space-between;align-items:end;gap:18px;margin-bottom:16px}.view-header h2{margin:0}.subnav{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 16px}.subnav button{background:#191a25;border:1px solid #333546;color:#c7c8d4;margin:0}.subnav button[aria-current=page]{background:#302344;border-color:#684aa1;color:#fff}.subpage{display:none}.subpage[data-active=true]{display:block}.subpage>.view-grid{margin:0}.dashboard-top{position:sticky;top:0;z-index:7;display:flex;justify-content:space-between;align-items:center;padding:14px 22px;margin:-28px -20px 20px;background:#11131bf2;border-bottom:1px solid #292b39;backdrop-filter:blur(14px)}.dashboard-top h1{font-size:1.1rem;margin:0}.dashboard-top #who{font-size:.82rem;margin:3px 0 0}.overview-status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.status-tile{background:#1b1d29;border:1px solid #303342;border-radius:13px;padding:14px}.status-tile strong{display:block;margin-bottom:6px}.status-tile span{color:#c9cbd6}.quick-actions{display:flex;gap:9px;flex-wrap:wrap}.warning-list{display:grid;gap:8px}.warning-item{padding:10px 12px;border:1px solid #5d4933;background:#282117;border-radius:10px;color:#f2d5ac}.legacy-source{display:none!important}.main-nav button{font-size:.97rem}body{background:radial-gradient(ellipse at 82% -8%,#30234a 0,transparent 28%),#101116}main{max-width:1480px;margin:0 0 0 226px;padding:28px 32px}#notice{position:fixed;right:20px;bottom:18px;z-index:20;padding:10px 14px;border-radius:10px;background:#262034}#diagnostics{margin-top:14px}.diagnostic-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 18px}.catalog-card{cursor:pointer;transition:transform .15s,border-color .15s}.catalog-card:hover{transform:translateY(-2px);border-color:#8c69ca}.catalog-card h3{margin:0 0 5px;color:#eee6ff}.catalog-card p{margin:0}.game-subnav{display:none!important;overflow:auto;flex-wrap:nowrap;padding-bottom:6px}.game-subnav button{white-space:nowrap}@media(max-width:760px){.main-nav{position:sticky;top:0;inset:auto;width:auto;height:auto;padding:8px 10px;margin:-18px -12px 16px;flex-direction:row;overflow-x:hidden;background:#11131bf5;border-right:0;border-bottom:1px solid #292b39}.main-nav button{flex:1 1 0;min-width:0;flex-direction:column;gap:3px;justify-content:center;padding:8px 2px;font-size:.78rem}.dash-layout{margin-left:0;min-height:0}main{margin:0;padding:18px 12px}.dashboard-top{margin:-18px -12px 16px;padding:12px}.overview-status{grid-template-columns:repeat(2,minmax(0,1fr))}.view-header{align-items:start;flex-direction:column}.mobile-nav-label{display:inline}}@media(max-width:380px){.main-nav button{font-size:.74rem;padding:7px 1px}.overview-status{gap:7px}.status-tile{padding:11px}}`;
const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf" content="__CSRF__"><title>Community Bot · Admin</title><style nonce="__NONCE__">
:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#11131b;color:#eef0f8}body{margin:0;background:radial-gradient(ellipse at top right,#30234a 0,transparent 35%),#11131b}main{max-width:1100px;margin:auto;padding:28px 20px}h1{margin:0 0 8px}p{color:#aeb2c3}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:20px 0}.card{background:#1b1e29;border:1px solid #333746;border-radius:14px;padding:18px}.accent{color:#c0a0ff}input,select,textarea,button{font:inherit;color:inherit;background:#10121a;border:1px solid #44495d;border-radius:8px;padding:10px;max-width:100%;box-sizing:border-box}textarea{width:100%;min-height:70px}button{background:#7652bd;border:0;cursor:pointer;margin:4px 2px}button:hover{background:#8d6bd1}label{display:block;margin:9px 0;color:#c7cad6}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#cbd0e0}form{display:grid;gap:8px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.muted{color:#979caf;font-size:.9rem}#notice{min-height:1.4rem;color:#ffc987}.preview-widget{margin:12px 0;padding:14px;border:1px solid #b69cff;border-left:5px solid #b69cff;border-radius:12px;background:linear-gradient(130deg,rgba(19,22,32,.96),rgba(42,34,57,.9));overflow-wrap:anywhere}.preview-widget p{margin:8px 0;color:#eef0f8}.preview-widget small{color:#b6b8c6}@media(max-width:520px){main{padding:18px 12px}.card{padding:14px}}
</style></head><body><main><div class="row"><div><h1>Community Bot <span class="accent">Verwaltung</span></h1><p id="who">Geschützte Verwaltung</p></div><button id="logout">Abmelden</button></div><p id="notice" role="status"></p><p class="muted">Hier steuerst du Chatspiele und Stream-Anzeigen. Fast alles ist optional – starte nur, was du wirklich nutzen möchtest.</p><section class="grid"><article class="card"><h2>Bot-Status</h2><pre id="overview">Lade Status …</pre></article><article class="card"><h2>Funktionen ein- und ausschalten</h2><div id="modules"></div></article><article class="card"><h2>Saison-Event</h2><div id="events"></div><details><summary>Eigenes Event anlegen (optional)</summary><form id="event-form"><input name="id" placeholder="Kurze Kennung, z. B. summer" required pattern="[a-z0-9_-]{2,40}"><input name="name" placeholder="Anzeigename" required><input name="emoji" placeholder="Symbol" value="✨"><input name="command" placeholder="Chatbefehl ohne !, z. B. summerhunt" required><input name="currency" placeholder="Punkte-Wort" required><input name="cooldownMs" type="number" min="0" value="900000"><button>Event speichern</button></form></details></article><article class="card"><h2>XP korrigieren (nur bei Bedarf)</h2><form id="xp-form"><input name="userId" placeholder="Twitch User-ID" required><input name="amount" type="number" placeholder="XP plus oder minus" required><input name="reason" placeholder="Grund für die Änderung" required maxlength="200"><button>Änderung speichern</button></form><p class="muted">Nur für Korrekturen. Änderungen werden protokolliert.</p></article><article class="card"><h2>Eigene Chatbefehle (optional)</h2><pre id="commands"></pre><form id="command-form"><input name="name" placeholder="Befehlsname ohne !" required><textarea name="response" placeholder="Was soll der Bot antworten? Platzhalter: {user}, {channel}, {game}, {uptime}" required></textarea><select name="permission"><option value="everyone">Dürfen alle nutzen</option><option value="moderator">Nur Moderatoren</option><option value="broadcaster">Nur Jannik</option></select><input name="cooldownMs" type="number" min="0" value="10000"><button>Befehl speichern</button></form></article><article class="card"><h2>Zuschauer suchen</h2><form id="users-form"><input name="q" placeholder="Twitch-Name oder ID"><button>Suchen</button></form><pre id="users"></pre></article></section></main><script nonce="__NONCE__">
const csrf=document.querySelector('meta[name=csrf]').content,notice=document.querySelector('#notice');async function api(path,method='GET',data){const r=await fetch('/dashboard/api/'+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(data?{body:JSON.stringify(data)}:{})});const d=await r.json().catch(()=>({error:'Ungültige Serverantwort'}));if(!r.ok)throw Error(d.error||'Anfrage fehlgeschlagen');return d}function show(text){notice.textContent=text;setTimeout(()=>notice.textContent='',5000)}async function refresh(){try{const d=await api('overview');document.querySelector('#who').textContent='Angemeldet als '+d.admin.login;document.querySelector('#overview').textContent=JSON.stringify(d.status,null,2);const mods=document.querySelector('#modules');mods.replaceChildren();for(const [key,on] of Object.entries(d.status.modules||{})){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=Boolean(on);box.addEventListener('change',async()=>{try{await api('modules','POST',{key,enabled:box.checked});show('Modul gespeichert.')}catch(e){box.checked=!box.checked;show(e.message)}});label.append(box,' '+key);mods.append(label)}const ev=await api('events');const box=document.querySelector('#events');box.replaceChildren();for(const event of ev.events){const line=document.createElement('div'),text=document.createElement('span');text.textContent=event.emoji+' '+event.name+' · '+(event.active?'aktiv':'inaktiv')+' ';line.append(text);const b=document.createElement('button');b.textContent=event.active?'Beenden':'Starten';b.onclick=async()=>{try{await api('events','POST',{id:event.id,active:!event.active});show('Eventstatus gespeichert.');refresh()}catch(e){show(e.message)}};line.append(b);box.append(line)}const c=await api('commands');document.querySelector('#commands').textContent=JSON.stringify(c.commands,null,2)}catch(e){show(e.message)}}document.querySelector('#event-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownMs);try{await api('events','POST',v);show('Event gespeichert.');e.currentTarget.reset();refresh()}catch(x){show(x.message)}};document.querySelector('#xp-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.amount=Number(v.amount);try{await api('xp-adjust','POST',v);show('XP-Korrektur protokolliert.');e.currentTarget.reset()}catch(x){show(x.message)}};document.querySelector('#command-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownMs);try{await api('commands','POST',v);show('Chatbefehl gespeichert.');refresh()}catch(x){show(x.message)}};document.querySelector('#users-form').onsubmit=async e=>{e.preventDefault();const v=new FormData(e.currentTarget);try{const u=await api('users?q='+encodeURIComponent(v.get('q')||''));document.querySelector('#users').textContent=JSON.stringify(u.users,null,2)}catch(x){show(x.message)}};document.querySelector('#logout').onclick=async()=>{try{await api('logout','POST',{});location.reload()}catch(e){show(e.message)}};refresh();setInterval(refresh,15000);
</script></body></html>`;

const SETTINGS_CARD = `<article class="card"><h2>Community-Boss</h2><p class="muted">Starte einen gemeinsamen Bosskampf, den der Chat mit Angriffsbefehlen bestreitet.</p><form id="boss-form"><input name="name" placeholder="Bossname" value="Schattenkönig"><label>Start-Lebenspunkte <input name="hp" type="number" min="1" value="1000"></label><label>Spieldauer in Millisekunden <input name="durationMs" type="number" min="60000" value="900000"></label><button>Bosskampf starten</button></form><button id="boss-end">Bosskampf beenden</button></article><article class="card"><details><summary>Technische Grundeinstellungen (nur bei Bedarf)</summary><p class="muted">Diese Roh-Einstellungen sind für fortgeschrittene Wartung. Für den normalen Betrieb musst du hier nichts ändern.</p><form id="settings-form"><textarea id="settings-json" rows="14" spellcheck="false" aria-label="Technische Bot-Einstellungen"></textarea><button>Einstellungen speichern</button></form></details></article><article class="card"><details><summary>Erweiterte Befehlsverwaltung</summary><div id="command-manager"></div></details></article>`;
const WELCOME_CARD = `<article class="card"><h2>Begrüßung neuer Chatter</h2><p class="muted">Optional, standardmäßig aus. Gespeichert wird nur die Twitch-ID mit erstem Begrüßungszeitpunkt, kein Chattext.</p><label><input id="welcome-enabled" type="checkbox"> Einmalige Begrüßung aktivieren</label><input id="welcome-message" maxlength="500" aria-label="Begrüßungstext"><p class="muted">Platzhalter: {user}</p><button id="welcome-save">Begrüßung speichern</button></article>`;
const WELCOME_SCRIPT = `async function loadWelcome(){try{const s=await api('welcome');document.querySelector('#welcome-enabled').checked=s.enabled;document.querySelector('#welcome-message').value=s.message}catch(e){show(e.message)}}document.querySelector('#welcome-save').onclick=async()=>{try{await api('welcome','POST',{enabled:document.querySelector('#welcome-enabled').checked,message:document.querySelector('#welcome-message').value});show('Begrüßung gespeichert.');loadWelcome()}catch(e){show(e.message)}};loadWelcome();`;
const OBS_CARD = `<article class="card"><h2>OBS: Widgets für den Stream</h2><p>Ein Widget ist eine kleine Anzeige im Stream. Für jede gewünschte Anzeige brauchst du nur eine Browserquelle in OBS. Du kannst mehrere Widgets in derselben Szene platzieren; sie aktualisieren sich selbst.</p><label for="obs-type">Welche Anzeige möchtest du einrichten?</label><select id="obs-type"><option value="imposter">Chat-Imposter — Phase, Countdown und Ergebnis</option><option value="detective">Chat-Detektiv — Zitat, Countdown und Auflösung</option><option value="poll">Umfrage — Frage und Abstimmungsstand</option><option value="quest">Community-Quest — Aufgabe und Fortschritt</option><option value="pet">Community-Pet — Pet-Status</option><option value="drop">Mystery Drop — Drop und Ergebnis</option><option value="wheel">Chaos Wheel — Drehung und Ergebnis</option></select><p id="obs-description" class="muted"></p><p id="obs-link-status" class="phase-box" role="status">Prüfe gespeicherten Link …</p><button id="obs-create">Neuen OBS-Link erstellen</button><button id="obs-revoke">OBS-Link widerrufen</button><div id="obs-result" role="status" aria-live="polite"></div><details><summary>Schritt für Schritt in OBS einrichten</summary><ol><li>Oben die gewünschte Anzeige auswählen.</li><li>Nur wenn noch kein Link eingerichtet ist: „Neuen OBS-Link erstellen“. Ein bestehender Link wird dabei ersetzt.</li><li>Den angezeigten Link kopieren und in OBS unter „Quellen“ → „+“ → „Browser“ einfügen.</li><li>Größe und Position einstellen. Üblicher Startwert: 900 × 320; fürs Pet etwa 500 × 600.</li><li>Szene speichern. Das Widget aktualisiert sich automatisch und kann in OBS dauerhaft in der Szene bleiben.</li></ol><p>Der Link ist geheim wie ein Passwort. „Widerrufen“ schaltet die vorhandene Browserquelle sofort ab. Beim bloßen Öffnen dieser Seite wird kein Link geändert.</p></details></article>`;
const OBS_SCRIPT = `const obsInfo={imposter:'Phase, Teilnehmendenzahl und Timer. Rollen und Regel bleiben bis zur Auflösung geheim.',detective:'Freiwillig eingereichtes Zitat und Timer; der Name erscheint erst nach der Auflösung.',poll:'Laufende Umfrage, Stimmen und Ergebnis.',quest:'Aktive Community-Aufgabe und Fortschritt.',pet:'Community-Pet, wenn es eingeschaltet ist.',drop:'Mystery Drop und Ergebnis.',wheel:'Chaos Wheel und Ergebnis.'};const obsType=document.querySelector('#obs-type'),obsStatus=document.querySelector('#obs-link-status');let obsConfigured={};async function loadObsStatus(){try{const d=await api('widgets/status');obsConfigured=d.widgets||{};obsStatus.textContent=obsConfigured[obsType.value]?'✅ Für diese Anzeige besteht ein aktiver OBS-Link. Ein neuer Link ersetzt ihn.':'ℹ️ Noch kein aktiver OBS-Link für diese Anzeige.'}catch{obsStatus.textContent='Status gerade nicht prüfbar. Vor dem Ersetzen vorsichtig sein.'}}function obsExplain(){document.querySelector('#obs-description').textContent=obsInfo[obsType.value];loadObsStatus()}obsType.onchange=obsExplain;obsExplain();document.querySelector('#obs-create').onclick=async()=>{if(obsConfigured[obsType.value]&&!confirm('Es besteht bereits ein Link. Einen neuen erstellen? Der bisherige Link und die OBS-Quelle werden dadurch ungültig.'))return;try{const d=await api('widgets/token','POST',{type:obsType.value,action:'rotate'}),out=document.querySelector('#obs-result');out.replaceChildren();const field=document.createElement('input');field.readOnly=true;field.value=d.url;field.setAttribute('aria-label','Privater OBS-Link');field.style.width='100%';const copy=document.createElement('button');copy.textContent='Link kopieren';copy.onclick=async()=>{try{await navigator.clipboard.writeText(d.url);show('OBS-Link kopiert.')}catch{field.select();show('Link markieren und manuell kopieren.')}};out.append(field,copy,document.createTextNode(' Bewahre diesen Link geheim auf.'));show('Privater OBS-Link erstellt; nur jetzt wird er angezeigt.');loadObsStatus()}catch(e){show(e.message)}};document.querySelector('#obs-revoke').onclick=async()=>{if(!confirm('Den Widget-Link widerrufen? Eine bereits in OBS eingerichtete Quelle funktioniert danach nicht mehr.'))return;try{await api('widgets/token','POST',{type:obsType.value,action:'revoke'});document.querySelector('#obs-result').replaceChildren();show('Widget-Link widerrufen.');loadObsStatus()}catch(e){show(e.message)}};`;
const DASHBOARD_WORDING_SCRIPT = `(()=>{const labels={xp:'XP und Level',events:'Saison-Events',eightBall:'8-Ball',rps:'Schere, Stein, Papier',guess:'Ratespiel',duels:'Duell-Spiel',boss:'Community-Boss',customCommands:'Eigene Chatbefehle',quests:'Community-Aufgaben',polls:'Umfragen'};function tidy(){const overview=document.querySelector('#overview');try{const d=JSON.parse(overview.textContent);overview.textContent='Twitch-Verbindung: '+(d.twitchConnected?'verbunden':'wird geprüft')+'\\nKanal: '+(d.channel||'—')+'\\nBot gestartet: '+(d.startedAt?new Date(d.startedAt).toLocaleString():'—')+(d.lastError?'\\nLetzter Hinweis: '+d.lastError:'')}catch{}for(const label of document.querySelectorAll('#modules label')){const input=label.querySelector('input'),name=label.lastChild?.textContent?.trim();if(input&&labels[name])label.lastChild.textContent=' '+labels[name]}for(const id of ['commands','users']){const node=document.querySelector('#'+id);try{const d=JSON.parse(node.textContent);if(id==='commands'&&Array.isArray(d.commands))node.textContent=d.commands.map(x=>'!'+x.name+' — '+x.response).join('\\n')||'Noch keine eigenen Chatbefehle angelegt.';else if(id==='users'&&Array.isArray(d.users))node.textContent=d.users.map(x=>(x.displayName||x.login)+' · '+x.xp+' XP').join('\\n')||'Keine Zuschauer gefunden.'}catch{}}}const observer=new MutationObserver(tidy);observer.observe(document.querySelector('main'),{childList:true,subtree:true});tidy()})();`;
const DASHBOARD_STRUCTURE_SCRIPT = `(()=>{const groups={uebersicht:document.querySelector('#diagnostic-content'),spiele:document.querySelector('#dashboard-games'),community:document.querySelector('#dashboard-community'),obs:document.querySelector('#dashboard-obs'),befehle:document.querySelector('#settings-commands'),einstellungen:document.querySelector('#settings-advanced')};const byTitle=t=>Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()===t);const move=(t,g)=>{const c=byTitle(t);if(c&&g)g.append(c)};move('Bot-Status',groups.einstellungen);move('Funktionen ein- und ausschalten',groups.einstellungen);move('Saison-Event',groups.community);move('XP korrigieren (nur bei Bedarf)',groups.einstellungen);move('Eigene Chatbefehle (optional)',groups.befehle);move('Zuschauer suchen',groups.einstellungen);move('Begrüßung neuer Chatter',groups.community);move('Community-Quests und Umfragen',groups.community);move('Quest-Abstimmung',groups.community);move('Chat-Umfrage',groups.community);move('Gesprächs-Funken',groups.community);move('Chat-Imposter & Chat-Detektiv',groups.spiele);move('Pet, Überraschung und Glücksrad',groups.spiele);move('OBS: Widgets für den Stream',groups.obs);move('Kanalpunkte',groups.einstellungen);move('Community-Boss',groups.spiele);})();`;
const DASHBOARD_STATUS_SCRIPT = `(()=>{const root=document.querySelector('#dashboard-overview'),card=Array.from(document.querySelectorAll('.card')).find(x=>x.querySelector('h2')?.textContent==='Bot-Status');if(!root||!card)return;const panel=document.createElement('div');panel.className='phase-box';root.append(panel);async function update(){try{const s=await api('status'),label=v=>v==='connected'?'Verbunden':v==='disconnected'?'Nicht verbunden':v===true?'Verbindung offen':v===false?'Getrennt':'Nicht separat geprüft';panel.replaceChildren();for(const [name,value] of [['Dashboard/Bot-Dienst antwortet',s.dashboardResponding?'Ja':'Nein'],['EventSub-WebSocket',label(s.eventSubSocket)],['Eingehender Chat / Befehle',label(s.chatReceive)],['Bot darf Chat senden',label(s.botChatSend)],['Broadcaster-Anmeldung für Kanalpunkte',label(s.broadcasterOAuth)]]){const line=document.createElement('p');line.textContent=name+': '+value;panel.append(line)}if(s.lastError){const err=document.createElement('p');err.textContent='Letzter Fehler: '+s.lastError;panel.append(err)}const note=document.createElement('p');note.textContent='Ein offener WebSocket beweist noch nicht, dass Chat-Ereignisse ankommen. Unbekannte Werte werden nicht als „funktioniert“ angezeigt.';panel.append(note)}catch{panel.textContent='Status konnte gerade nicht geladen werden.'}}update();setInterval(update,15000)})();`;
const DASHBOARD_CLEANUP_SCRIPT = `(()=>{const groups=document.querySelector('#dashboard-obs');const duplicate=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()==='OBS-Widgets');if(duplicate&&groups)groups.append(duplicate);for(const h of document.querySelectorAll('main>h2'))if(['Community-Aktionen','Im Stream anzeigen','Erweiterte Einstellungen'].includes(h.textContent.trim())){h.hidden=true;if(h.nextElementSibling)h.nextElementSibling.hidden=true;if(h.nextElementSibling?.nextElementSibling)h.nextElementSibling.nextElementSibling.hidden=true}for(const s of document.querySelectorAll('main>section.grid'))if(!s.querySelector('.card'))s.hidden=true})();`;
const DASHBOARD_REMAINDER_SCRIPT = `(()=>{const settings=document.querySelector('#dashboard-settings'),obs=document.querySelector('#dashboard-obs');for(const node of [document.querySelector('#settings-form'),document.querySelector('#command-manager')]){const card=node?.closest('.card');if(card&&settings)settings.append(card)}for(const title of ['Quests über Twitch-Kanalpunkte']){const card=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()===title);if(card&&settings)settings.append(card)}const preview=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()==='Overlay-Vorschau');if(preview&&obs)obs.append(preview);for(const section of document.querySelectorAll('main>section.grid'))if(!section.querySelector('.card'))section.hidden=true})();`;
const DASHBOARD_OBS_GUARD_SCRIPT = `document.querySelectorAll('.widget-rotate').forEach(b=>b.onclick=async()=>{if(!confirm('Neuen Link für '+b.dataset.widget+' erstellen? Der bisherige Link und die damit eingerichtete OBS-Quelle werden sofort ungültig.'))return;try{const d=await api('widgets/token','POST',{type:b.dataset.widget,action:'rotate'});document.querySelector('#widget-url').value=d.url;show('Neuer OBS-Link erstellt; die OBS-Quelle muss aktualisiert werden.')}catch(e){show(e.message)}});document.querySelectorAll('.widget-revoke').forEach(b=>b.onclick=async()=>{if(!confirm('Widget-Link widerrufen? Die bisherige OBS-Quelle funktioniert dann nicht mehr.'))return;try{await api('widgets/token','POST',{type:b.dataset.widget,action:'revoke'});document.querySelector('#widget-url').value='';show('OBS-Link widerrufen.')}catch(e){show(e.message)}});`;
const DASHBOARD_GUIDES_SCRIPT = `(()=>{const guides={'Community-Quests und Umfragen':'Was ist das? Zuschauer schlagen Aufgaben vor; du prüfst sie und startest eine Quest selbst. Für eine Chat-Umfrage gibst du Frage und Antworten ein. Zuschauer wählen mit !vote 1, !vote 2 usw. Das Ergebnis startet nichts automatisch. Du musst Questvorschläge freigeben und eine Quest manuell starten oder abschließen. Das Quest-/Umfrage-Widget zeigt den aktiven Stand.','Quest-Abstimmung':'Wähle freigegebene Aufgaben aus und starte die Abstimmung. Zuschauer stimmen mit !vote ab. Nach Ende siehst du das Ergebnis; die Gewinner-Quest wird nur nach deiner Bestätigung gestartet. OBS zeigt Frage und Stimmen.','Chat-Umfrage':'Frage und 2–5 Antworten eingeben und Umfrage starten. Zuschauer stimmen mit !vote Nummer ab. Die Umfrage endet nach dem Timer; du entscheidest danach, was passiert. Das Umfrage-Widget zeigt Stimmen und Ergebnis.','Gesprächs-Funken':'Der Bot zählt vorübergehend Themenhinweise aus dem öffentlichen Kanalchat. Wenn genug verschiedene Personen über ein Thema schreiben, schlägt er eine Aktion vor. Er startet keine Abstimmung ohne Freigabe. Standardmäßig aus; keine privaten Nachrichten.','Pet, Überraschung und Glücksrad':'Community-Pet: Zuschauer können das Pet mit Chatbefehlen gemeinsam entwickeln. Mystery Drop: du startest ihn hier oder das Glücksrad startet ihn automatisch; Zuschauer nehmen mit !claim teil und der Bot verteilt XP nach Ablauf. Chaos Wheel: manuelle Challenge heißt Aufgabe für dich; automatische Felder führen eine Bot-Aktion aus. Aktiviere die Funktionen erst, wenn du sie verwenden möchtest. OBS kann Pet, Drop und Wheel jeweils anzeigen.','Begrüßung neuer Chatter':'Optional: Der Bot begrüßt einen Chatter einmalig, wenn er zum ersten Mal im Kanal schreibt. Hier legst du Text und Platzhalter {user} fest. Die Begrüßung sendet der Bot automatisch; hier musst du danach nichts tun.'};for(const c of document.querySelectorAll('.card')){const h=c.querySelector('h2'),text=h&&guides[h.textContent.trim()];if(!text||c.querySelector('details[data-simple-guide]'))continue;const d=document.createElement('details');d.dataset.simpleGuide='true';const s=document.createElement('summary');s.textContent='Einfach erklärt';const p=document.createElement('p');p.textContent=text;d.append(s,p);c.insertBefore(d,c.children[1]||null)}})();`;
const DASHBOARD_STATUS_SAFE_SCRIPT = `(()=>{const root=document.querySelector('#dashboard-overview'),raw=document.querySelector('#overview');if(raw)raw.hidden=true;const panel=document.createElement('div');panel.className='phase-box';root.append(panel);async function update(){try{const s=await api('status'),label=v=>v==='connected'?'Verbunden':v===true?'Verbindung offen':v===false?'Getrennt':'Nicht separat geprüft';panel.replaceChildren();for(const [name,value] of [['Bot-Dashboard antwortet',s.dashboardResponding?'Ja':'Nein'],['Twitch-Kanal',s.channel||'Nicht bekannt'],['EventSub-Verbindung',label(s.eventSubSocket)],['Chat-Empfang / Befehle',label(s.chatReceive)],['Chat-Nachrichten senden',label(s.botChatSend)],['Kanalpunkte-Twitch-Verbindung',label(s.broadcasterOAuth)]]){const p=document.createElement('p');p.textContent=name+': '+value;panel.append(p)}if(s.errorPresent){const p=document.createElement('p');p.textContent='Technischer Hinweis vorhanden; bitte vor Livebetrieb prüfen.';panel.append(p)}const p=document.createElement('p');p.textContent='Eine offene EventSub-Verbindung allein belegt noch keinen eingehenden Chatempfang.';panel.append(p)}catch{panel.textContent='Status konnte gerade nicht geladen werden.'}}update();setInterval(update,15000)})();`;
const CHAT_RESPONSE_SCRIPT = `(()=>{const root=document.querySelector('#chat-response-settings');if(!root)return;api('chat-messages').then(s=>{root.replaceChildren();const form=document.createElement('form'),title=document.createElement('h3');title.textContent='Wie oft soll der Bot schreiben?';const select=document.createElement('select');select.name='profile';for(const [value,label] of [['calm','Ruhig'],['normal','Normal (empfohlen)'],['lively','Lebhaft']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option)}select.value=s.profile;const help=document.createElement('p');help.className='muted';help.textContent='Das Profil steuert Chat-Antworten und die vorsichtige Tipp-Häufigkeit gemeinsam. Wichtige Spielereignisse bleiben sichtbar.';const tipLabel=document.createElement('label'),tipToggle=document.createElement('input');tipToggle.type='checkbox';tipToggle.checked=Boolean(s.communityTips?.enabled);tipLabel.append(tipToggle,' Community-Tipps aktivieren');const tipInfo=document.createElement('p');tipInfo.className='muted';const preview=document.createElement('p');preview.className='muted';const names=document.createElement('textarea');names.rows=3;names.value=(s.welcomeBots||[]).join(', ');names.setAttribute('aria-label','Bots von Begrüßungen ausschließen');const label=document.createElement('label');label.textContent='Bots nicht begrüßen (Komma-getrennte Namen)';label.append(names);const save=document.createElement('button');save.textContent='Speichern';form.append(title,select,help,tipLabel,tipInfo,preview,label,save);function paint(d){const t=d.communityTips||{};tipInfo.textContent='Community-Tipps sind '+(t.enabled?'eingeschaltet':'ausgeschaltet')+'. Live-Stream und echte Chat-Aktivität sind Voraussetzung. Profil '+(t.profile==='calm'?'Ruhig: max. 1 Tipp/Stunde, 8 Nachrichten, 45 Min. Abstand':t.profile==='lively'?'Lebhaft: max. 3 Tipps/Stunde, 5 Nachrichten, 20 Min. Abstand':'Normal: max. 2 Tipps/Stunde, 6 Nachrichten, 30 Min. Abstand')+'. '+(t.lastTipAt?'Zuletzt gesendet: '+new Date(t.lastTipAt).toLocaleString():'Noch kein Tipp gesendet.')+(t.nextEarliestAt?' Nächster möglicher Zeitpunkt: '+new Date(t.nextEarliestAt).toLocaleTimeString():'');preview.textContent='Mögliche Tipps: '+((d.tipPreviews||[]).map(x=>x.text).join(' · ')||'Zurzeit keine aktivierten Zuschauerthemen.')};paint(s);form.onsubmit=async e=>{e.preventDefault();try{await api('chat-messages','POST',{profile:select.value,welcomeBots:names.value.split(',').map(x=>x.trim()).filter(Boolean),communityTipsEnabled:tipToggle.checked});const current=await api('chat-messages');paint(current);show('Chat-Nachrichten gespeichert.')}catch(err){show(err.message)}};root.append(form);const stats=document.createElement('p');stats.className='muted';root.append(stats);async function refreshStats(){try{const current=await api('chat-messages');stats.textContent='Seit Bot-Start: '+(current.suppressed||0)+' Antworten unterdrückt, '+(current.deferred||0)+' wegen Chattempo begrenzt, '+(current.queued||0)+' Nachrichten warten im Chatversand.';paint(current)}catch{stats.textContent='Versandstatus derzeit nicht verfügbar.'}}refreshStats();setInterval(refreshStats,15000)}).catch(e=>{root.textContent='Einstellungen konnten nicht geladen werden: '+e.message})})();`;
const AUTOMATIC_CHAT_MESSAGES_SCRIPT = `(()=>{const style=document.createElement('style');style.textContent='.auto-message-card{border:1px solid #393d4d;border-radius:11px;padding:14px;margin:10px 0;background:#171923}.auto-message-card h4{margin:2px 0 8px}.auto-message-card .row{display:flex;flex-wrap:wrap;gap:8px}.auto-message-card .row button{min-height:40px}#automatic-chat-form{display:grid;gap:12px;max-width:720px}#automatic-chat-form label{display:grid;gap:5px}#automatic-chat-form input,#automatic-chat-form select,#automatic-chat-form textarea{max-width:100%;padding:10px;border-radius:8px}#automatic-chat-form label:has(input[type=checkbox]){display:flex;align-items:center;gap:8px}@media(max-width:520px){.auto-message-card .row button{flex:1 1 100%}}';document.head.append(style);const root=document.querySelector('#automatic-chat-messages'),form=document.querySelector('#automatic-chat-form'),list=document.querySelector('#automatic-chat-list');if(!root||!form||!list)return;const title=form.elements.namedItem('title'),text=form.elements.namedItem('message'),interval=form.elements.namedItem('interval'),customInput=form.elements.namedItem('customInterval'),custom=form.querySelector('label[name=custom]'),enabled=form.elements.namedItem('enabled'),active=form.elements.namedItem('activeChatOnly'),id=form.elements.namedItem('id'),preview=document.querySelector('#automatic-chat-preview');function previewText(){const body=text.value.trim().replace(/^【[^】]+】\\s*/u,'');const formatted='【📢 INFO】 '+body;preview.textContent=Array.from(formatted).length<=500?formatted:'Vorschau: Nachricht ist länger als Twitch erlaubt.'}text.addEventListener('input',previewText);interval.addEventListener('change',()=>{custom.hidden=interval.value!=='custom'});form.elements.namedItem('cancel').onclick=()=>{form.reset();id.value='';custom.hidden=true;previewText()};function editor(item){id.value=item?.id||'';title.value=item?.title||'';text.value=item?.message||'';interval.value=[30,45,60,90].includes(item?.intervalMinutes)?String(item.intervalMinutes):'custom';customInput.value=item?.intervalMinutes||30;custom.hidden=interval.value!=='custom';enabled.checked=item?.enabled??true;active.checked=item?.activeChatOnly??false;previewText();form.scrollIntoView({behavior:'smooth',block:'center'})}async function refresh(){try{const data=await api('automatic-messages');list.replaceChildren();if(!data.messages.length){const p=document.createElement('p');p.className='muted';p.textContent='Noch keine eigenen Nachrichten angelegt.';list.append(p)}for(const item of data.messages){const card=document.createElement('article');card.className='auto-message-card';const heading=document.createElement('h4');heading.textContent=item.title;const sample=document.createElement('p');sample.className='chat-preview';sample.textContent=item.preview;const status=document.createElement('p');status.className='muted';status.textContent=(item.enabled?'Aktiv':'Pausiert')+' · alle '+item.intervalMinutes+' Min. · '+(item.activeChatOnly?'nur bei aktivem Chat':'ohne zusätzliche Aktivitätsschwelle')+' · zuletzt: '+(item.lastSentAt?new Date(item.lastSentAt).toLocaleString():'noch nicht gesendet')+' · frühestens: '+(item.nextEarliestAt>Date.now()?new Date(item.nextEarliestAt).toLocaleString():'jetzt, sobald Stream und Versandregeln passen')+(item.lastErrorAt?' · letzter Sendeversuch fehlgeschlagen; kontrollierter neuer Versuch nach Intervall':'');const actions=document.createElement('div');actions.className='row';for(const [label,action] of [[item.enabled?'Pausieren':'Fortsetzen','toggle'],['Bearbeiten','edit'],['Löschen','delete']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=async()=>{try{if(action==='edit'){editor(item);return}if(action==='delete'&&!confirm('„'+item.title+'“ wirklich löschen?'))return;await api('automatic-messages','POST',action==='toggle'?{action,id:item.id,enabled:!item.enabled}:{action,id:item.id});show(action==='delete'?'Nachricht gelöscht.':'Status geändert.');await refresh()}catch(error){show(error.message)}};actions.append(button)}card.append(heading,sample,status,actions);list.append(card)}}catch(error){list.textContent='Nachrichten konnten nicht geladen werden: '+error.message}}form.onsubmit=async event=>{event.preventDefault();try{const minutes=interval.value==='custom'?Number(customInput.value):Number(interval.value);await api('automatic-messages','POST',{action:'save',id:id.value||undefined,title:title.value,message:text.value,intervalMinutes:minutes,enabled:enabled.checked,activeChatOnly:active.checked});show(id.value?'Nachricht aktualisiert.':'Nachricht angelegt.');form.reset();id.value='';custom.hidden=true;previewText();await refresh()}catch(error){show(error.message)}};refresh();})();`;
const CHAT_IDENTITY_PREVIEW_SCRIPT = `(()=>{const root=document.querySelector('#chat-identity-preview');if(!root)return;root.innerHTML='<h3>Chat-Stil: COMMUNITY</h3><p class="muted">Jede öffentliche Bot-Nachricht erhält automatisch ein passendes, gut erkennbares Kategorien-Schild.</p>';for(const text of ['【🎁 DROP】 Mystery Drop gestartet! Schreibt !claim.','【🎭 IMPOSTER】 Die Abstimmung beginnt!','【❓ HILFE】 Verfügbare Befehle findest du mit !help.']){const sample=document.createElement('p');sample.className='chat-preview';sample.textContent=text;root.append(sample)}})();`;
const ARCADE_SMART_CONTROLS_SCRIPT = `(()=>{const dropButton=document.querySelector('#arcade-drop'),spinButton=document.querySelector('#arcade-spin'),stopButton=document.querySelector('#arcade-stop'),state=document.querySelector('#arcade-state'),widget=document.querySelector('#arcade-widget-status');async function update(){try{const d=await api('arcade'),w=d.wheel,drop=d.drop?.drop,activeDrop=Boolean(drop&&['announced','claiming','resolving'].includes(drop.status));dropButton.hidden=!d.settings.dropsEnabled||activeDrop;dropButton.disabled=!d.settings.dropsEnabled||activeDrop;dropButton.title=activeDrop?'Der aktuelle Drop läuft bereits.':d.settings.dropsEnabled?'60 Sekunden Teilnahme mit !claim':'Schalte Drops in den optionalen Einstellungen ein.';spinButton.hidden=!d.settings.wheelEnabled||!w.autoPilotEnabled;stopButton.hidden=!w.autoPilotEnabled;spinButton.disabled=!w.canSpin;let line=state.querySelector('[data-drop-status]');if(!line){line=document.createElement('p');line.dataset.dropStatus='true';state.append(line)}line.textContent=activeDrop?'🎁 '+drop.participants+' Teilnehmende · noch '+Math.max(0,Math.ceil((drop.endsAt-Date.now())/1000))+' Sekunden':'🎁 Kein Drop aktiv.';line.hidden=!d.settings.dropsEnabled;const links=await api('widgets/status');widget.textContent='OBS: Drop '+(links.widgets?.drop?'eingerichtet':'nicht eingerichtet')+' · Glücksrad '+(links.widgets?.wheel?'eingerichtet':'nicht eingerichtet')+'. Ohne OBS funktionieren Chat und Spiel weiter.'}catch{widget.textContent='OBS-Linkstatus aktuell nicht prüfbar.'}}update();setInterval(update,3000);setInterval(()=>{const line=state.querySelector('[data-drop-status]');if(line&&line.textContent.includes('Teilnehmende'))update()},1000)})();`;
const DASHBOARD_SHORTCUT_SCRIPT = `(()=>{const overview=document.querySelector('#dashboard-overview'),actions=document.createElement('div');actions.className='row';for(const [label,href] of [['Imposter starten','#spiele'],['Umfrage erstellen','#community'],['OBS-Widgets öffnen','#obs']]){const a=document.createElement('a');a.href=href;a.textContent=label;a.className='button-link';actions.append(a)}overview.prepend(actions);const commands=document.querySelector('#dashboard-commands'),tip=document.createElement('p');tip.className='muted';tip.textContent='Im Chat zeigt !help die Kurz-Hilfe. Zuschauer können dort Themen wie Punkte, Spiele und Umfragen nachschlagen.';commands.prepend(tip)})();`;
const DASHBOARD_OBS_DEMO_SCRIPT = `(()=>{const select=document.querySelector('#obs-type'),host=document.querySelector('#obs-result');if(!select||!host)return;const box=document.createElement('div');box.className='preview-widget';box.setAttribute('aria-live','polite');const title=document.createElement('strong'),line=document.createElement('p');title.textContent='Vorschau';line.textContent='Beispielanzeige für die ausgewählte Browserquelle.';box.append(title,line);host.before(box);function update(){const labels={imposter:'CHAT-IMPOSTER · Anmeldung · 4 Teilnehmende · Countdown',detective:'WER HAT DAS GESCHRIEBEN? · „Beispielzitat aus dem Chat“',poll:'LIVE-UMFRAGE · Welche Runde als Nächstes?',quest:'LIVE-QUEST · Gemeinsam eine Aufgabe schaffen',pet:'COMMUNITY-PET · gemeinsamer Fortschritt',drop:'MYSTERY DROP · !claim zum Mitmachen',wheel:'CHAOS WHEEL · Das Rad dreht sich'};line.textContent=labels[select.value]+' — Beispiel; live erscheinen hier die echten Spieldaten.'}select.addEventListener('change',update);update()})();`;
const DASHBOARD_TIMER_SCRIPT = `(()=>{setInterval(()=>{const node=document.querySelector('#mini-next');if(!node)return;if(!node.querySelector('[data-countdown]')){node.dataset.phaseText=node.textContent;const timer=document.createElement('span');timer.dataset.countdown='true';node.append(timer)}const timer=node.querySelector('[data-countdown]');timer.textContent=miniEndsAt?' · Countdown '+Math.floor(Math.max(0,miniEndsAt-Date.now())/1000)+' Sek.':''},1000)})();`;
const DASHBOARD_APP_SCRIPT = `(()=>{
const streamerEntry=document.createElement('a');streamerEntry.href='/streamer';streamerEntry.textContent='🎛 Streamer-Modus';streamerEntry.className='streamer-entry';document.querySelector('.dashboard-top')?.append(streamerEntry);
document.querySelectorAll('#dashboard-legacy-source [style]').forEach(x=>x.removeAttribute('style'));
const views=[...document.querySelectorAll('[data-dashboard-view]')],mainNav=[...document.querySelectorAll('[data-view-target]')];
const gamePages=[...document.querySelectorAll('[data-game-page]')],gameNav=[...document.querySelectorAll('[data-game-target]')];
const communityPages=[...document.querySelectorAll('[data-community-page]')],communityNav=[...document.querySelectorAll('[data-community-target]')];
const settingPages=[...document.querySelectorAll('[data-setting-page]')],settingNav=[...document.querySelectorAll('[data-setting-target]')];
function pick(nodes,key,valueAttr,selected){nodes.forEach(n=>{const active=n.getAttribute(valueAttr)===selected;n.hidden=!active;if(active)n.dataset.active='true';else delete n.dataset.active});}
function setGame(id,write=true){pick(gamePages,id,'data-game-page',id);gameNav.forEach(b=>{const active=b.dataset.gameTarget===id;b.setAttribute('aria-current',active?'page':'false')});const catalog=document.querySelector('#game-catalog');if(catalog)catalog.hidden=Boolean(id);if(write)history.replaceState(null,'','#spiele/'+id)}
function setCommunity(id,write=true){pick(communityPages,id,'data-community-page',id);communityNav.forEach(b=>b.setAttribute('aria-current',b.dataset.communityTarget===id?'page':'false'));if(write)history.replaceState(null,'','#community/'+id)}
function setSetting(id,write=true){pick(settingPages,id,'data-setting-page',id);settingNav.forEach(b=>b.setAttribute('aria-current',b.dataset.settingTarget===id?'page':'false'));if(write)history.replaceState(null,'','#einstellungen/'+id)}
function setView(id,write=true){views.forEach(v=>{const active=v.dataset.dashboardView===id;v.hidden=!active;if(active)v.dataset.active='true';else delete v.dataset.active});mainNav.forEach(b=>b.setAttribute('aria-current',b.dataset.viewTarget===id?'page':'false'));if(id==='community'&&!communityPages.some(p=>p.dataset.active==='true'))setCommunity('events',false);if(id==='settings'&&!settingPages.some(p=>p.dataset.active==='true'))setSetting('messages',false);if(id==='games'&&!gamePages.some(p=>p.dataset.active==='true')){const catalog=document.querySelector('#game-catalog');if(catalog)catalog.hidden=false;pick(gamePages,'','data-game-page','');gameNav.forEach(b=>b.setAttribute('aria-current','false'))}if(write)history.replaceState(null,'','#'+id);window.scrollTo(0,0)}
function route(){const [raw,sub]=location.hash.slice(1).split('/');const names={uebersicht:'overview',spiele:'games',community:'community',obs:'obs',einstellungen:'settings',chat:'settings',befehle:'settings'};const view=names[raw]||'overview';setView(view,false);if(raw==='spiele'&&sub)setGame(sub,false);if(raw==='community'&&sub)setCommunity(sub,false);if(raw==='einstellungen'&&sub)setSetting(sub,false);if(raw==='chat')setSetting('messages',false);if(raw==='befehle')setSetting('commands',false)}
mainNav.forEach(b=>b.addEventListener('click',()=>setView(b.dataset.viewTarget)));gameNav.forEach(b=>b.addEventListener('click',()=>setGame(b.dataset.gameTarget)));communityNav.forEach(b=>b.addEventListener('click',()=>setCommunity(b.dataset.communityTarget)));settingNav.forEach(b=>b.addEventListener('click',()=>setSetting(b.dataset.settingTarget)));window.addEventListener('hashchange',route);
function pageButton(label,view,sub){const b=document.createElement('button');b.type='button';b.className='catalog-card card';const h=document.createElement('h3'),p=document.createElement('p');h.textContent=label;p.className='muted';p.textContent='Öffnen';b.replaceChildren(h,p);b.addEventListener('click',()=>{setView(view);if(sub)view==='games'?setGame(sub):view==='community'?setCommunity(sub):setSetting(sub)});return b}
const byTitle=t=>[...document.querySelectorAll('.card')].find(c=>c.querySelector('h2')?.textContent?.trim()===t);
const put=(node,target)=>{if(node&&target)target.append(node)};
const gameTarget=id=>document.querySelector('[data-game-page="'+id+'"] .view-grid');
const communityTarget=id=>document.querySelector('[data-community-page="'+id+'"] .view-grid');
const settingsTarget=id=>document.querySelector('[data-setting-page="'+id+'"] .view-grid');
// Move existing feature controls into their own routed views; event handlers remain bound to the same elements.
const mini=byTitle('Chat-Imposter & Chat-Detektiv');
if(mini){const h=mini.querySelector('h2');if(h)h.textContent='Chat-Imposter';mini.style.gridColumn='';mini.querySelector(':scope > p')?.remove();mini.querySelector('.guide-block')?.remove();for(const details of [...mini.querySelectorAll(':scope > details')])if(details.id!=='mini-quote-review'&&!details.querySelector('#mini-settings-form'))details.remove();const detective=document.createElement('article');detective.className='card';detective.innerHTML='<h2>Chat-Detektiv</h2><p class="muted">Der Chat errät den Urheber eines freiwillig eingereichten Zitats. Zuschauer tippen mit <code>!wer @Name</code>.</p><div id="detective-state" class="phase-box">Rundenstatus wird geladen …</div><p>Vor dem Start muss mindestens ein Zitat geprüft und freigegeben sein.</p>';const detectiveActions=mini.querySelector('#mini-detective-start')?.parentElement;if(detectiveActions)detective.append(detectiveActions);const quoteReview=mini.querySelector('#mini-quote-review');if(quoteReview)detective.append(quoteReview);const sharedSettings=mini.querySelector('#mini-settings-form')?.closest('details');if(sharedSettings){sharedSettings.querySelector('#mini-quote-review')?.remove();const settingsCard=document.createElement('article');settingsCard.className='card';settingsCard.innerHTML='<h2>Imposter- und Detektiv-Einstellungen</h2>';settingsCard.append(sharedSettings);put(settingsCard,settingsTarget('advanced'))}put(mini,gameTarget('imposter'));put(detective,gameTarget('detective'))}
const arcade=byTitle('Mystery Drops und Glücksrad')||byTitle('Pet, Überraschung und Glücksrad');
if(arcade){arcade.style.gridColumn='';const h=arcade.querySelector('h2');if(h)h.textContent='Chaos Wheel';arcade.querySelector('.guide-block')?.remove();arcade.querySelector(':scope > p')?.remove();const drop=document.createElement('article');drop.className='card';drop.innerHTML='<h2>Mystery Drops</h2><p class="muted">Jannick startet eine 60-Sekunden-Belohnungsrunde. Zuschauer schreiben <code>!claim</code>; XP und Ergebnis folgen automatisch.</p><div id="drop-page-status" class="phase-box">Dropstatus wird geladen …</div><div class="row" id="drop-page-actions"></div>';const dropButton=arcade.querySelector('#arcade-drop');put(dropButton,drop.querySelector('#drop-page-actions'));put(arcade,gameTarget('wheel'));put(drop,gameTarget('drop'))}
const elio=byTitle('Community-Pet')||byTitle('Elio 🐱');put(elio,communityTarget('elio'));
const experiments=[...document.querySelectorAll('.experiment-list')];experiments.forEach(x=>put(x,gameTarget('other')));
for(const c of [byTitle('Saison-Event')])put(c,communityTarget('events'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/Community-Quests|Quest-Abstimmung|Gemeinsame Vorschläge/u.test(x.querySelector('h2')?.textContent||'')))put(c,communityTarget('quests'));
put(byTitle('Gesprächs-Funken'),communityTarget('spark'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/Begrüßung neuer Chatter/u.test(x.querySelector('h2')?.textContent||'')))put(c,communityTarget('welcome'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/OBS: Widgets|Overlay-Vorschau/u.test(x.querySelector('h2')?.textContent||'')))put(c,document.querySelector('#dashboard-obs .view-grid'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/Eigene Chatbefehle|Erweiterte Befehlsverwaltung/u.test(x.querySelector('h2')?.textContent||'')))put(c,settingsTarget('commands'));
for(const c of [...document.querySelectorAll('.card')].filter(x=>/Bot-Status|Funktionen ein- und ausschalten|XP korrigieren|Zuschauer suchen|Community-Boss|Technische Grundeinstellungen|Kanalpunkte/u.test(x.querySelector('h2')?.textContent||'')))put(c,settingsTarget('advanced'));
for(const node of [document.querySelector('#chat-nachrichten .card')])put(node,settingsTarget('messages'));
const home=document.querySelector('#home-status');
const homeCurrent=document.querySelector('#home-current'),homeWarnings=document.querySelector('#home-warnings');
async function updateHome(){try{const s=await api('status'),miniData=await api('minigames'),arcadeData=await api('arcade');const websocket=s.eventSubSocket===true||s.eventSubSocket==='connected';home.replaceChildren();const tiles=[['Bot-Prozess',s.dashboardResponding?'Läuft':'Nicht erreichbar'],['Twitch-Verbindung',websocket?'Verbunden':'Wird geprüft'],['Chatempfang',s.chatReceive==='confirmed'?'Bestätigt':'Noch nicht bestätigt'],['Chatversand',s.botChatSend==='confirmed'?'Bestätigt':'Noch nicht bestätigt']];for(const [label,value] of tiles){const tile=document.createElement('div');tile.className='status-tile';const strong=document.createElement('strong'),span=document.createElement('span');strong.textContent=label;span.textContent=value;tile.append(strong,span);home.append(tile)}const current=miniData.state?.detective?.phase==='playing'?'Chat-Detektiv läuft':miniData.state?.imposter?.phase&&miniData.state.imposter.phase!=='idle'?'Chat-Imposter · '+miniData.state.imposter.phase:arcadeData.wheel?.activeAction?'Chaos Wheel · '+arcadeData.wheel.activeAction.title:arcadeData.drop?.drop&&['announced','claiming','resolving'].includes(arcadeData.drop.drop.status)?'Mystery Drop läuft':'Kein Spiel aktiv';homeCurrent.textContent=current;const warns=[];if(s.errorPresent)warns.push('Beim Bot liegt ein technischer Hinweis vor.');if(!websocket)warns.push('Twitch-Verbindung ist noch nicht bestätigt.');if(s.chatReceive!=='confirmed')warns.push('Eingehender Chat ist noch nicht durch eine echte Nachricht bestätigt.');if(s.botChatSend!=='confirmed')warns.push('Ausgehender Chat ist noch nicht durch eine bestätigte Antwort belegt.');homeWarnings.replaceChildren();if(!warns.length){const p=document.createElement('p');p.className='muted';p.textContent='Keine wichtigen Warnungen.';homeWarnings.append(p)}else for(const w of warns){const p=document.createElement('p');p.className='warning-item';p.textContent=w;homeWarnings.append(p)}const details=document.querySelector('#diagnostics');details.hidden=false;const diagRows=[['EventSub-WebSocket',websocket?'Verbunden':'Nicht verbunden'],['Chat-Abonnement',s.chatSubscription==='active'?'Aktiv':'Nicht bestätigt'],['Echte eingehende Chatnachricht',s.chatReceive==='confirmed'?'Bestätigt':'Nicht bestätigt'],['Bot-Antwort akzeptiert',s.botChatSend==='confirmed'?'Bestätigt':'Nicht bestätigt'],['Broadcaster-OAuth',s.broadcasterOAuth==='connected'?'Verbunden':'Nicht verbunden'],['Kanal',s.channel||'Nicht bekannt']];const grid=document.querySelector('#diagnostic-grid');grid.replaceChildren();for(const [k,v] of diagRows){const p=document.createElement('p');p.textContent=k+': '+v;grid.append(p)}}catch{home.textContent='Status derzeit nicht verfügbar.'}}
updateHome();setInterval(updateHome,12000);
async function updateDetective(){try{const d=await api('minigames'),round=d.state?.detective;const node=document.querySelector('#detective-state');if(node)node.textContent=round?(round.phase==='playing'?'Raten läuft · '+round.guesses+' Tipps · '+Math.max(0,Math.ceil((round.endsAt-Date.now())/1000))+' Sek.':round.phase==='results'?'Auflösung läuft':'Keine Runde aktiv'):'Keine Runde aktiv'}catch{}}
async function updateDrop(){try{const d=await api('arcade'),x=d.drop?.drop,n=document.querySelector('#drop-page-status');if(n)n.textContent=x&&['announced','claiming','resolving'].includes(x.status)?x.participants+' Teilnehmende · noch '+Math.max(0,Math.ceil((x.endsAt-Date.now())/1000))+' Sekunden':'Kein Drop aktiv.'}catch{}}
updateDetective();updateDrop();setInterval(updateDetective,3000);setInterval(updateDrop,3000);
document.querySelectorAll('[data-home-route]').forEach(b=>b.addEventListener('click',()=>{const [v,s]=b.dataset.homeRoute.split('/');setView(v);if(s)v==='games'?setGame(s):setCommunity(s)}));
const catalog=document.querySelector('#game-catalog');if(catalog)catalog.replaceChildren(...[['Chat-Imposter','imposter','Geheime Rollen, Diskussion und Abstimmung.'],['Chat-Detektiv','detective','Freiwillige Chat-Zitate erraten.'],['Mystery Drops','drop','Kurzrunde mit automatischer XP-Auswertung.'],['Chaos Wheel','wheel','Alle 30 Minuten automatische Community-Aktion.'],['Weitere Chatspiele','other','Experimentelle kleine Chatspiele.']].map(([name,id,desc])=>{const b=pageButton(name,'games',id);b.querySelector('p').textContent=desc;return b}));
const xpPage=communityTarget('xp');if(xpPage){const card=document.createElement('article');card.className='card';card.innerHTML='<h3>XP &amp; Level</h3><p>XP sind der dauerhafte Fortschritt der Community. Zuschauer prüfen ihren Stand im Chat mit <code>!level</code>; Saisonpunkte bleiben davon getrennt.</p>';xpPage.append(card)}
document.querySelectorAll('[data-community-home]').forEach(b=>b.addEventListener('click',()=>setCommunity(b.dataset.communityHome)));
function route(){const [raw,sub]=location.hash.slice(1).split('/'),mapping={uebersicht:'overview',spiele:'games',community:'community',obs:'obs',einstellungen:'settings'};const id=mapping[raw]||'overview';setView(id,false);if(raw==='spiele'&&sub)setGame(sub,false);if(raw==='community'&&sub)setCommunity(sub,false);if(raw==='einstellungen'&&sub)setSetting(sub,false)}
window.addEventListener('hashchange',route);route();
})();`;
const SETTINGS_SCRIPT = `api('settings').then(s=>document.querySelector('#settings-json').value=JSON.stringify(s,null,2)).catch(e=>show(e.message));document.querySelector('#settings-form').onsubmit=async e=>{e.preventDefault();try{const value=JSON.parse(document.querySelector('#settings-json').value);await api('settings','POST',value);show('Einstellungen gespeichert.')}catch(x){show(x.message)}};document.querySelector('#boss-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.hp=Number(v.hp);v.durationMs=Number(v.durationMs);try{await api('boss','POST',v);show('Bosskampf gestartet.');refresh()}catch(x){show(x.message)}};document.querySelector('#boss-end').onclick=async()=>{try{await api('boss','POST',{action:'end'});show('Bosskampf beendet.');refresh()}catch(x){show(x.message)}};async function renderCommandAdmin(){try{const c=await api('commands'),root=document.querySelector('#command-manager');root.replaceChildren();for(const command of c.commands){const row=document.createElement('div'),name=document.createElement('span');name.textContent='!'+command.name+(command.alias?' ('+command.alias+')':'')+' · '+(command.enabled?'aktiv':'inaktiv')+' ';row.append(name);const edit=document.createElement('button');edit.textContent='Bearbeiten';edit.onclick=()=>{const f=document.querySelector('#command-form');f.elements.namedItem('name').value=command.name;f.elements.namedItem('response').value=command.response;f.elements.namedItem('permission').value=command.permission;f.elements.namedItem('cooldownMs').value=command.cooldownMs;f.scrollIntoView({behavior:'smooth',block:'center'})};row.append(edit);const toggle=document.createElement('button');toggle.textContent=command.enabled?'Deaktivieren':'Aktivieren';toggle.onclick=async()=>{try{await api('commands','POST',{...command,enabled:!command.enabled});show('Chatbefehl geändert.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(toggle);const del=document.createElement('button');del.textContent='Löschen';del.onclick=async()=>{try{await api('commands/delete','POST',{name:command.name});show('Chatbefehl gelöscht.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(del);root.append(row)}}catch(x){show(x.message)}}renderCommandAdmin();setInterval(renderCommandAdmin,15000);`;

export class DashboardServer {
  private server: http.Server | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly states = new Map<string, number>();
  private readonly rates = new Map<string, { count: number; resets: number }>();
  private readonly eventStreams = new Map<http.ServerResponse, NodeJS.Timeout>();
  private readonly widgetStreams = new Map<http.ServerResponse, NodeJS.Timeout>();
  private readonly participantSessions = new Map<string, { userId: string; expiresAt: number }>();
  private readonly adminIds: Set<string>;
  private readonly clientId = process.env.TWITCH_CLIENT_ID?.trim() || '';
  private readonly clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim() || '';
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
        this.json(response, 500, { error: 'Interner Fehler.' });
      });
    });
    await new Promise<void>((resolve, reject) => this.server!.once('error', reject).listen(this.port, this.host, resolve));
    this.logger.info('Geschütztes Dashboard gestartet.', { host: this.host, port: this.port });
    return true;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const [response, timer] of this.eventStreams) { clearInterval(timer); response.end(); }
    this.eventStreams.clear();
    for (const [response, timer] of this.widgetStreams) { clearInterval(timer); response.end(); }
    this.widgetStreams.clear();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.sessions.clear();
  }

  address(): AddressInfo | undefined { const addr = this.server?.address(); return addr && typeof addr === 'object' ? addr : undefined; }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.headers(res);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!this.rateLimit(clientIp)) { this.json(res, 429, { error: 'Zu viele Anfragen. Bitte kurz warten.' }); return; }
    if (url.pathname === '/hilfe') {
      if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET');res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Nur lesender Aufruf erlaubt.');return;}
      const nonce=randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(renderPublicHelpPage(this.publicHelpAvailability(),url.searchParams.get('q')||'',nonce));return;
    }
    if (url.pathname === '/dashboard/login' && req.method === 'GET') { this.login(res); return; }
    if (url.pathname === '/streamer') {
      if (req.method !== 'GET') { res.statusCode=405;res.setHeader('Allow','GET');res.end('Methode nicht erlaubt.');return; }
      const session=this.authenticate(req,res);if(!session)return;
      const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(STREAMER_PAGE.replaceAll('__CSRF__',session.csrf).replaceAll('__NONCE__',nonce));return;
    }
    if (url.pathname === '/dashboard/oauth/callback' && req.method === 'GET') { await this.callback(url, req, res); return; }
    if (url.pathname === '/dashboard/spotify/callback' && req.method === 'GET') {
      res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
      try{if(!this.songRequests)throw new Error('Song Requests sind nicht eingerichtet.');await this.songRequests.handleCallback(url);res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spotify verbunden</title><body style="font:16px system-ui;background:#111;color:#eee;padding:2rem"><h1>Spotify verbunden</h1><p>Du kannst dieses Fenster schließen und die Musikwünsche im Dashboard fertig einrichten.</p><a style="color:#c9a8ff" href="/dashboard#community/music">Zum Dashboard</a></body></html>');}
      catch(error){res.statusCode=400;res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(error instanceof Error?error.message:'Spotify-Verbindung fehlgeschlagen.');}return;
    }
    if (url.pathname === '/games/imposter/login' && req.method === 'GET') { this.participantLogin(res); return; }
    if (url.pathname === '/games/imposter/callback' && req.method === 'GET') { await this.participantCallback(url, req, res); return; }
    if (url.pathname === '/games/imposter/role' && req.method === 'GET') { this.participantRole(req, res); return; }
    if (url.pathname === '/dashboard/api/logout' && req.method === 'POST') {
      const session = this.authenticate(req, res, true); if (!session) return;
      if (!this.checkCsrf(req, session)) { this.json(res, 403, { error: 'CSRF-Prüfung fehlgeschlagen.' }); return; }
      this.sessions.delete(this.cookieSession(req) || ''); this.clearCookie(res); this.json(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/dashboard' || url.pathname === '/dashboard/') {
      const session = this.authenticate(req, res); if (!session) return;
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const structure = `<nav class="main-nav" aria-label="Hauptnavigation"><button type="button" data-view-target="overview">◉ <span>Übersicht</span></button><button type="button" data-view-target="games">▣ <span>Spiele</span></button><button type="button" data-view-target="community">✦ <span>Community</span></button><button type="button" data-view-target="obs">▧ <span>OBS</span></button><button type="button" data-view-target="settings">⚙ <span>Einstellungen</span></button></nav><div id="dashboard-app" class="dash-layout"><section class="dashboard-view" data-dashboard-view="overview" id="view-overview"><div class="view-header"><div><h2>Übersicht</h2><p class="muted view-intro">Was gerade läuft und was Aufmerksamkeit braucht.</p></div></div><article class="card"><h3>Bot- und Chatstatus</h3><div id="home-status" class="overview-status" aria-live="polite"><p class="muted">Status wird geprüft …</p></div><details id="diagnostics"><summary>Technische Diagnose</summary><div id="diagnostic-grid" class="diagnostic-grid"></div><div id="diagnostic-content"></div></details></article><article class="card"><h3>Aktuelles Spiel</h3><p id="home-current">Status wird geladen …</p></article><article class="card"><h3>Schnellaktionen</h3><div class="quick-actions"><button type="button" data-home-route="games/imposter">Imposter öffnen</button><button type="button" data-home-route="games/drop">Mystery Drop öffnen</button><button type="button" data-home-route="obs">OBS einrichten</button></div></article><article class="card"><h3>Wichtige Hinweise</h3><div id="home-warnings" class="warning-list" aria-live="polite"></div></article></section><section class="dashboard-view" data-dashboard-view="games" id="view-games"><div class="view-header"><div><h2>Spiele</h2><p class="muted view-intro">Wähle ein Spiel. Auf der Spielseite siehst du nur dessen Ablauf und Steuerung.</p></div></div><div id="game-catalog" class="view-grid"></div><nav class="subnav game-subnav" aria-label="Spiele" id="game-nav"><button type="button" data-game-target="imposter">Imposter</button><button type="button" data-game-target="detective">Detektiv</button><button type="button" data-game-target="drop">Mystery Drop</button><button type="button" data-game-target="wheel">Chaos Wheel</button><button type="button" data-game-target="other">Weitere Spiele</button></nav><section data-game-page="imposter" class="subpage"><div class="view-grid"></div></section><section data-game-page="detective" class="subpage"><div class="view-grid"></div></section><section data-game-page="drop" class="subpage"><div class="view-grid"></div></section><section data-game-page="wheel" class="subpage"><div class="view-grid"></div></section><section data-game-page="other" class="subpage"><div class="view-grid"></div></section><div id="dashboard-games" class="legacy-staging"></div></section><section class="dashboard-view" data-dashboard-view="community" id="view-community"><div class="view-header"><div><h2>Community</h2><p class="muted view-intro">Events, Fortschritt und gemeinsame Ideen.</p></div></div><nav class="subnav" aria-label="Community-Bereiche"><button type="button" data-community-target="events">Saison-Events</button><button type="button" data-community-target="xp">XP &amp; Level</button><button type="button" data-community-target="elio">Elio 🐱</button><button type="button" data-community-target="quests">Quests</button><button type="button" data-community-target="spark">Gesprächs-Funken</button><button type="button" data-community-target="welcome">Begrüßung</button></nav><section data-community-page="events" class="subpage"><div class="view-grid"></div></section><section data-community-page="xp" class="subpage"><div class="view-grid"></div></section><section data-community-page="elio" class="subpage"><div class="view-grid"></div></section><section data-community-page="quests" class="subpage"><div class="view-grid"></div></section><section data-community-page="spark" class="subpage"><div class="view-grid"></div></section><section data-community-page="welcome" class="subpage"><div class="view-grid"></div></section><div id="dashboard-community" class="legacy-staging"></div></section><section class="dashboard-view" data-dashboard-view="obs" id="view-obs"><div class="view-header"><div><h2>OBS</h2><p class="muted view-intro">Stream-Einblendungen auswählen, ansehen und in OBS einrichten.</p></div></div><div class="view-grid"></div><div id="dashboard-obs" class="legacy-staging"></div></section><section class="dashboard-view" data-dashboard-view="settings" id="view-settings"><div class="view-header"><div><h2>Einstellungen</h2><p class="muted view-intro">Chat, Befehle und selten benötigte technische Optionen.</p></div></div><nav class="subnav" aria-label="Einstellungen"><button type="button" data-setting-target="messages">Chat-Nachrichten</button><button type="button" data-setting-target="commands">Chatbefehle</button><button type="button" data-setting-target="advanced">Erweitert</button></nav><section data-setting-page="messages" class="subpage"><div class="view-grid"><article class="card"><div id="automatic-chat-messages"><h3>Eigene Nachrichten</h3><p class="muted">Geplante Hinweise werden nur bei bestätigtem Live-Stream versendet.</p><form id="automatic-chat-form"><input type="hidden" name="id"><label>Titel<input name="title" maxlength="60" required placeholder="z. B. Discord-Hinweis"></label><label>Nachricht<textarea name="message" maxlength="500" required></textarea></label><label>Wiederholung<select name="interval"><option value="30">30 Minuten</option><option value="45">45 Minuten</option><option value="60">60 Minuten</option><option value="90">90 Minuten</option><option value="custom">Eigenes Intervall</option></select></label><label name="custom" hidden>Eigenes Intervall in Minuten<input name="customInterval" type="number" min="15" max="1440" value="30"></label><label><input name="enabled" type="checkbox" checked> Aktiviert</label><label><input name="activeChatOnly" type="checkbox"> Nur bei aktivem Chat</label><p id="automatic-chat-preview" class="chat-preview" aria-live="polite">【📢 INFO】 Vorschau</p><button type="submit">Nachricht speichern</button> <button type="button" name="cancel">Abbrechen</button></form><div id="automatic-chat-list"></div></div><h3>Community-Tipps</h3><div id="chat-response-settings"></div><div id="chat-identity-preview"></div></article></div></section><section data-setting-page="commands" class="subpage"><div class="view-grid"><div id="settings-commands" class="legacy-staging"></div></div></section><section data-setting-page="advanced" class="subpage"><div class="view-grid"><div id="settings-advanced" class="legacy-staging"></div></div></section><section id="dashboard-commands" class="legacy-staging"></section><section id="dashboard-settings" class="legacy-staging"></section></section></div>`;
      const integratedStructure=structure
        .replace('<button type="button" data-community-target="welcome">Begrüßung</button>','<button type="button" data-community-target="welcome">Begrüßung</button><button type="button" data-community-target="music">Song-Wünsche</button>')
        .replace('<section data-community-page="welcome"','<section data-community-page="music" class="subpage"><div class="view-grid">'+SONG_REQUESTS_CARD+'</div></section><section data-community-page="welcome"');
      const page = PAGE.replace('</style>', DASHBOARD_STYLE+'</style>').replace('<div class="row"><div><h1>Community Bot','<header class="dashboard-top"><div><h1>Community Bot').replace('</button></div><p id="notice"','</button></header><p id="notice"').replace('<p class="muted">Hier steuerst du Chatspiele und Stream-Anzeigen. Fast alles ist optional – starte nur, was du wirklich nutzen möchtest.</p>','').replace('</p><section class="grid">', `</p>${integratedStructure}<div id="dashboard-legacy-source" class="legacy-source"><section class="grid">`).replace('</section></main>', `</section><h2>Community-Aktionen</h2><p class="muted">Community-Spiele und Aktionen</p><section class="grid">${WELCOME_CARD}${QUEST_POLL_CARD}${SPARK_CARD}${MINI_GAME_CARD}${ARCADE_CARD}</section><h2>OBS</h2><section class="grid">${OBS_CARD}</section><h2>Einstellungen</h2><section class="grid">${CHANNEL_POINTS_CARD}${SETTINGS_CARD}</section></div></main>`)
        .replace('</script>', `${OBS_SCRIPT}${SETTINGS_SCRIPT}${WELCOME_SCRIPT}${QUEST_POLL_SCRIPT}${SPARK_SCRIPT}${MINI_GAME_SCRIPT}${CHANNEL_POINTS_SCRIPT}${ARCADE_SCRIPT}${ARCADE_SMART_CONTROLS_SCRIPT}${DASHBOARD_WORDING_SCRIPT}${DASHBOARD_STRUCTURE_SCRIPT}${DASHBOARD_CLEANUP_SCRIPT}${DASHBOARD_REMAINDER_SCRIPT}${DASHBOARD_OBS_GUARD_SCRIPT}${DASHBOARD_TIMER_SCRIPT}${DASHBOARD_OBS_DEMO_SCRIPT}${CHAT_RESPONSE_SCRIPT}${CHAT_IDENTITY_PREVIEW_SCRIPT}${DASHBOARD_UX_V3_SCRIPT}${DASHBOARD_APP_SCRIPT}</script>`);
      const messagesUi=page.replace('<article class="card"><div id="chat-response-settings">','<article class="card"><div id="automatic-chat-messages"><h3>Eigene Nachrichten</h3><p class="muted">Der Bot sendet diese Nachricht frühestens im gewählten Abstand – nur bei bestätigtem Live-Stream und mit Chatpause zwischen automatischen Hinweisen.</p><form id="automatic-chat-form"><input type="hidden" name="id"><label>Interner Titel<input name="title" maxlength="60" required placeholder="z. B. Discord-Hinweis"></label><label>Nachricht<textarea name="message" maxlength="500" required placeholder="Schau gern auf unserem Discord vorbei …"></textarea></label><label>Wiederholung<select name="interval"><option value="30">30 Minuten</option><option value="45">45 Minuten</option><option value="60">60 Minuten</option><option value="90">90 Minuten</option><option value="custom">Eigenes Intervall</option></select></label><label name="custom" hidden>Eigenes Intervall in Minuten<input name="customInterval" type="number" min="15" max="1440" value="30"></label><label><input name="enabled" type="checkbox" checked> Aktiviert</label><label><input name="activeChatOnly" type="checkbox"> Nur bei aktivem Chat (mindestens 6 echte Nachrichten)</label><p id="automatic-chat-preview" class="chat-preview" aria-live="polite">【📢 INFO】 Vorschau</p><button type="submit">Nachricht speichern</button> <button type="button" name="cancel">Abbrechen</button></form><div id="automatic-chat-list" aria-live="polite"></div></div></article><article class="card"><h3>Community-Tipps</h3><div id="chat-response-settings">');
      const autoScript=AUTOMATIC_CHAT_MESSAGES_SCRIPT.replace("const style=document.createElement('style');","const style=document.createElement('style');style.nonce=document.querySelector('script[nonce]')?.nonce||'';");
      const withAutomaticScript=messagesUi.replace('</script>',`${autoScript}${SONG_REQUESTS_SCRIPT}</script>`);
      res.end(withAutomaticScript.replaceAll('__CSRF__', session.csrf).replaceAll('__NONCE__', nonce)); return;
    }
    if (url.pathname.startsWith('/widgets/')) { await this.widgetRoute(url, req, res); return; }
    if (url.pathname.startsWith('/dashboard/api/')) {
      const session = this.authenticate(req, res, true); if (!session) return;
      if (req.method !== 'GET' && !this.checkCsrf(req, session)) { this.json(res, 403, { error: 'CSRF-Prüfung fehlgeschlagen.' }); return; }
      await this.api(url, req, res, session); return;
    }
    if (url.pathname === '/healthz' && req.method === 'GET') { this.json(res, 200, { ok: true }); return; }
    this.json(res, 404, { error: 'Nicht gefunden.' });
  }

  private async widgetRoute(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET') { this.json(res, 405, { error: 'Widgets sind nur lesend.' }); return; }
    const page = /^\/widgets\/(quest|poll|imposter|detective|pet|drop|wheel)$/u.exec(url.pathname);
    const api = /^\/widgets\/api\/(quest|poll|imposter|detective|pet|drop|wheel)$/u.exec(url.pathname);
    const stream = /^\/widgets\/stream\/(quest|poll|imposter|detective|pet|drop|wheel)$/u.exec(url.pathname);
    if (!page && !api && !stream) { this.json(res, 404, { error: 'Nicht gefunden.' }); return; }
    const type = (page?.[1] || api?.[1] || stream?.[1]) as WidgetType;
    const token = url.searchParams.get('token') || '';
    if (!/^[A-Za-z0-9_-]{40,100}$/u.test(token)) { this.json(res, 404, { error: 'Widget nicht verfügbar.' }); return; }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (!this.store.widgetTokenValid(type, tokenHash, Date.now())) { this.json(res, 404, { error: 'Widget nicht verfügbar.' }); return; }
    if (page) {
      const nonce = randomBytes(18).toString('base64');
      const settings = this.store.config('widget_settings', defaultWidgetSettings());
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(communityWidgetHtml(type, nonce, settings.fontSize, settings.theme));
      return;
    }
    if (api) { this.json(res, 200, this.widgetSnapshot(type)); return; }
    this.openWidgetEventStream(type, res);
  }

  private openWidgetEventStream(type: WidgetType, res: http.ServerResponse): void {
    if (this.widgetStreams.size >= 10) { this.json(res, 429, { error: 'Zu viele OBS-Verbindungen.' }); return; }
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
    const timer = setInterval(send, 1000);
    this.widgetStreams.set(res, timer);
    res.on('close', () => { clearInterval(timer); this.widgetStreams.delete(res); });
  }

  private widgetSnapshot(type: WidgetType): Record<string, unknown> {
    return this.store.widgetSnapshot(type, Date.now());
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
    if (validated.client_id !== this.clientId || !this.adminIds.has(validated.user_id)) { this.json(res, 403, { error: 'Dieses Twitch-Konto ist nicht für die Administration freigeschaltet.' }); return; }
    const userResponse = await this.fetchImpl('https://api.twitch.tv/helix/users', { headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok) { this.json(res, 401, { error: 'Twitch-Profil konnte nicht verifiziert werden.' }); return; }
    const userPayload = await userResponse.json() as { data?: HelixUser[] };
    const user = userPayload.data?.[0];
    if (!user || user.id !== validated.user_id) { this.json(res, 401, { error: 'Twitch-Identität stimmt nicht überein.' }); return; }
    for (const [sessionKey, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(sessionKey);
    const key = randomBytes(32).toString('hex');
    this.sessions.set(key, { userId: user.id, login: user.login, csrf: randomBytes(24).toString('hex'), expiresAt: Date.now() + SESSION_TTL_MS });
    res.setHeader('Set-Cookie', [
      'dashboard_oauth_state=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      `community_admin=${key}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    ]);
    res.statusCode = 303; res.setHeader('Location', '/dashboard'); res.end();
  }

  private participantLogin(res: http.ServerResponse): void {
    if (!this.miniGames) { this.json(res, 503, { error: 'Spielteilnehmer-Login ist nicht verfügbar.' }); return; }
    const state = randomBytes(24).toString('hex'); this.states.set(`participant:${state}`, Date.now() + 10 * 60_000);
    const auth = new URL('https://id.twitch.tv/oauth2/authorize');
    auth.searchParams.set('client_id', this.clientId);
    auth.searchParams.set('redirect_uri', new URL('/games/imposter/callback', new URL(this.redirectUri).origin).toString());
    auth.searchParams.set('response_type', 'code'); auth.searchParams.set('scope', ''); auth.searchParams.set('state', state);
    res.statusCode = 302; res.setHeader('Set-Cookie', `imposter_oauth_state=${state}; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    res.setHeader('Location', auth.toString()); res.end();
  }

  private async participantCallback(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const state = url.searchParams.get('state') || '', key = `participant:${state}`, expires = this.states.get(key) || 0;
    this.states.delete(key);
    const clear = 'imposter_oauth_state=; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
    if (!state || expires < Date.now() || this.cookieValue('imposter_oauth_state', req) !== state) { res.setHeader('Set-Cookie', clear); this.json(res, 400, { error: 'OAuth-State ungültig oder abgelaufen.' }); return; }
    if (url.searchParams.has('error')) { res.setHeader('Set-Cookie', clear); this.json(res, 400, { error: 'Twitch-Anmeldung abgebrochen.' }); return; }
    const redirectUri = new URL('/games/imposter/callback', new URL(this.redirectUri).origin).toString();
    const tokenResponse = await this.fetchImpl('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code: url.searchParams.get('code') || '', grant_type: 'authorization_code', redirect_uri: redirectUri }) });
    if (!tokenResponse.ok) { res.setHeader('Set-Cookie', clear); this.json(res, 401, { error: 'Twitch-Anmeldung konnte nicht bestätigt werden.' }); return; }
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) { res.setHeader('Set-Cookie', clear); this.json(res, 401, { error: 'Twitch-Token fehlt.' }); return; }
    const validation = await this.fetchImpl('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token.access_token}` } });
    if (!validation.ok) { res.setHeader('Set-Cookie', clear); this.json(res, 401, { error: 'Twitch-Token ungültig.' }); return; }
    const identity = await validation.json() as TokenValidation;
    const role = this.miniGames?.roleFor(identity.user_id);
    if (identity.client_id !== this.clientId || !role) { res.setHeader('Set-Cookie', clear); this.json(res, 403, { error: 'Für dieses Twitch-Konto ist keine aktive Spielrolle vorhanden.' }); return; }
    const session = randomBytes(32).toString('hex'); this.participantSessions.set(session, { userId: identity.user_id, expiresAt: Date.now() + 60 * 60_000 });
    res.setHeader('Set-Cookie', [clear, `imposter_participant=${session}; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`]);
    res.statusCode = 303; res.setHeader('Location', '/games/imposter/role'); res.end();
  }

  private participantRole(req: http.IncomingMessage, res: http.ServerResponse): void {
    const key = this.cookieValue('imposter_participant', req), session = key ? this.participantSessions.get(key) : undefined;
    const role = session && session.expiresAt > Date.now() ? this.miniGames?.roleFor(session.userId) : undefined;
    res.setHeader('Cache-Control', 'no-store');
    if (!role) { res.statusCode = 303; res.setHeader('Location', '/games/imposter/login'); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const message = role.role === 'imposter' ? 'Du bist der IMPOSTER! Beobachte den Chat und versuche, nicht aufzufallen.' : `Deine geheime Regel lautet: ${role.rule || ''}`;
    res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deine geheime Spielrolle</title><main><h1>Deine geheime Rolle</h1><p>${escapeHtml(message)}</p><p>Bitte teile diesen Bildschirm nicht und veröffentliche die Rolle nicht im Chat.</p></main></html>`); return;
  }

  private async api(url: URL, req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
    const route = url.pathname.slice('/dashboard/api/'.length);
    if (route === 'overview' && req.method === 'GET') { this.json(res, 200, { admin: { login: session.login }, status: { ...this.store.overview(), ...this.getStatus() } }); return; }
    if (route === 'status' && req.method === 'GET') { const runtime=this.getStatus();this.json(res,200,{dashboardResponding:true,eventSubSocket:runtime.twitchConnected,chatReceive:'unknown',botChatSend:'unknown',broadcasterOAuth:this.channelPoints?(this.channelPoints.connected()?'connected':'disconnected'):'unknown',errorPresent:Boolean(runtime.lastError),channel:runtime.channel,chatQueue:runtime.queued??0,chatSuppressed:(runtime.suppressed??0)+(runtime.chatResponse?.suppressed??0),chatDeferred:runtime.chatResponse?.deferred??0});return; }
    if (route === 'streamer-state' && req.method === 'GET') { const guess=this.store.state<{expiresAt:number}|null>('guess',null);this.json(res,200,{guess:guess&&guess.expiresAt>Date.now()?guess:null,guessEnabled:this.store.config<Record<string,boolean>>('modules',{}).guess!==false});return; }
    if (route === 'chat-messages' && req.method === 'GET') {
      const policy=this.chatPolicy??new ChatResponsePolicy(this.store.config('chat_response_settings',DEFAULT_CHAT_RESPONSE_SETTINGS));
      const runtime=this.getStatus(),snapshot=policy.snapshot();
      const profile=snapshot.profile;
      this.json(res,200,{...snapshot,suppressed:snapshot.suppressed+(runtime.suppressed??0),queued:runtime.queued??0,
        communityTips:this.communityTips?.status(profile),tipPreviews:this.communityTips?.preview(this.publicHelpAvailability())??[]});return;
    }
    if(route==='automatic-messages'&&req.method==='GET'){
      const messages=this.automaticChatMessages?.list()??[];
      this.json(res,200,{messages:messages.map(message=>({...message,preview:formatPublicChatMessage(message.message,'info')})),minIntervalMinutes:15});return;
    }
    if (route === 'widgets/status' && req.method === 'GET') { const types: WidgetType[]=['quest','poll','imposter','detective','pet','drop','wheel'];this.json(res,200,{widgets:Object.fromEntries(types.map(type=>[type,this.store.widgetTokenConfigured(type,Date.now())]))});return; }
    if (route === 'welcome' && req.method === 'GET') { this.json(res,200,this.store.config('first_chat_welcome',{enabled:false,message:'Willkommen im Chat, {user}! 🎮 Schreib !help, wenn du die Community-Befehle sehen möchtest.'})); return; }
    if (route === 'spark' && req.method === 'GET') {
      const settings = normalizeSparkConfig(this.store.config<unknown>('spark_settings',DEFAULT_SPARK_CONFIG));
      this.json(res, 200, { settings, topics: this.getSparkSnapshot?.() ?? [], pending: this.store.sparkProposals('pending_approval',100).length, proposals: this.store.sparkProposals('all',50), customTopics: this.store.config('spark_topics',[]), cooldowns: [] }); return;
    }
    if (route === 'minigames' && req.method === 'GET' && this.miniGames) { this.json(res, 200, { settings:this.miniGames.settings(), state:this.miniGames.snapshot(), quotes:this.miniGames.managedQuotes() }); return; }
    if (route === 'channel-points' && req.method === 'GET') { this.json(res, 200, this.channelPoints
      ? { available:true, settings:this.channelPoints.settings(), connected:this.channelPoints.connected(), message:this.channelPoints.oauthStatusMessage, redemptions:this.store.channelRedemptions(100) }
      : { available:false, settings:DEFAULT_CHANNEL_POINTS_SETTINGS, connected:false, message:'Diese optionale Twitch-Kanalpunkte-Verbindung ist hier nicht eingerichtet.', redemptions:[] }); return; }
    if(route==='song-requests'&&req.method==='GET'){this.json(res,200,this.songRequests?{available:true,settings:this.songRequests.settings(),spotifyConnected:this.songRequests.connected(),message:this.songRequests.statusMessage(),requests:this.songRequests.list()}
      :{available:false,settings:{enabled:false},spotifyConnected:false,message:'Song-Wünsche sind nicht eingerichtet.',requests:[]});return;}
    if (route === 'arcade' && req.method === 'GET' && this.arcade) { this.json(res,200,{settings:this.arcade.settings(),pet:this.arcade.pet(),challenges:this.arcade.manageChallenges(),wheel:this.arcade.wheelStatus(),drop:this.arcade.snapshot('drop')});return; }
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
    if (route === 'polls' && req.method === 'GET') {
      const active = this.store.activePoll(); const history = this.store.pollHistory(25);
      this.json(res, 200, { active: active ?? history.find((poll) => poll.status === 'ended') ?? null, history }); return;
    }
    if (route === 'stream' && req.method === 'GET') { this.openEventStream(url, req, res); return; }
    if (req.method !== 'POST') { this.json(res, 405, { error: 'Methode nicht erlaubt.' }); return; }
    const body = await this.readJson(req); if (!body) { this.json(res, 400, { error: 'Ungültiger JSON-Body.' }); return; }
    const now = Date.now();
    if(route==='chat-messages'){
      if(!['calm','normal','lively'].includes(String(body.profile))) { this.json(res,400,{error:'Bitte ein gültiges Antwortprofil auswählen.'});return; }
      if(body.communityTipsEnabled!==undefined&&typeof body.communityTipsEnabled!=='boolean'){this.json(res,400,{error:'Bitte Ein oder Aus für Community-Tipps wählen.'});return;}
      const welcomeBots=body.welcomeBots===undefined?DEFAULT_CHAT_RESPONSE_SETTINGS.welcomeBots:body.welcomeBots;
      if(!Array.isArray(welcomeBots)||welcomeBots.length>50||welcomeBots.some((x)=>typeof x!=='string'||x.length>50||!/^[a-z0-9_]+$/iu.test(x))){this.json(res,400,{error:'Die Bot-Ausschlussliste ist ungültig (maximal 50 Twitch-Namen).'});return;}
      const settings={profile:body.profile,welcomeBots:[...new Set(welcomeBots.map((x:string)=>x.toLowerCase()))]};
      this.store.setConfig('chat_response_settings',settings);this.chatPolicy?.configure(settings);
      if(typeof body.communityTipsEnabled==='boolean')this.communityTips?.configure(body.communityTipsEnabled);
      this.audit(session,'chat-response-settings','chat',{profile:settings.profile,welcomeBotCount:settings.welcomeBots.length,communityTipsEnabled:body.communityTipsEnabled===true},now);this.json(res,200,{ok:true});return;
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
        const settings = { ...current, enabled:boolValue(body.enabled,current.enabled??false,'Aktivierung'), paused:boolValue(body.paused,current.paused??false,'Pause'),
          chatSuggestionsEnabled:boolValue(body.chatSuggestionsEnabled,current.chatSuggestionsEnabled??false,'Chat-Hinweise'), pauseDuringPolls:boolValue(body.pauseDuringPolls,current.pauseDuringPolls??true,'Pausieren während Umfrage'),
          windowMs:minutes('windowMinutes',Number(current.windowMs||600000)/60000,1,60), minParticipants:boundedInt(body.minParticipants,Number(current.minParticipants||3),2,50),
          minMessages:boundedInt(body.minMessages,Number(current.minMessages||5),3,200), minScore:boundedInt(body.minScore,Number(current.minScore||12),1,1000),
          globalCooldownMs:minutes('globalCooldownMinutes',Number(current.globalCooldownMs||1200000)/60000,1,1440), topicCooldownMs:minutes('topicCooldownMinutes',Number(current.topicCooldownMs||3600000)/60000,1,10080),
          proposalTtlMs:minutes('proposalTtlMinutes',Number(current.proposalTtlMs||1800000)/60000,1,1440), maxPending:boundedInt(body.maxPending,Number(current.maxPending||5),1,50), allowedActionTypes:allowed };
        const topics=body.topics===undefined?this.store.config('spark_topics',[]):body.topics;
        if(!Array.isArray(topics)||topics.length>100||topics.some((t)=>!isRecord(t)||typeof t.id!=='string'||typeof t.label!=='string'||!Array.isArray(t.terms)||t.terms.length>30||t.terms.some((v)=>typeof v!=='string'||v.length>80)||!['poll','quest','challenge'].includes(String(t.actionType))))throw new Error('Topic-Liste ist ungültig.');
        this.store.setConfig('spark_settings',settings);this.store.setConfig('spark_topics',topics);this.audit(session,'spark-settings','conversation-spark',{enabled:settings.enabled},now);this.json(res,200,{ok:true});return;
      } catch(error) { this.json(res,400,{error:error instanceof Error?error.message:'Einstellungen ungültig.'});return; }
    }
    if (route === 'spark/action') {
      const id=String(body.id||''), action=String(body.action||''), proposal=this.store.sparkProposal(id);
      if(!proposal){this.json(res,404,{error:'Vorschlag nicht gefunden.'});return;}
      if(action==='approve'||action==='reject'){
        const ok=this.store.decideSparkProposal(id,action==='approve'?'approved':'rejected',session.userId,now);
        if(!ok){this.json(res,409,{error:'Vorschlag ist abgelaufen oder bereits entschieden.'});return;}
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
    if(route==='arcade'&&this.arcade){
      try{
        if(body.settings!==undefined){if(!isRecord(body.settings))throw new Error('Arcade-Einstellungen ungültig.');this.arcade.updateSettings(body.settings as never);if(body.settings.wheelAutoPilotEnabled===true)this.arcade.resumeAutoPilot();this.audit(session,'arcade-settings','arcade',{},now);this.json(res,200,{ok:true});return;}
        const action=String(body.action||'');let message='';
        if(action==='start-drop')message=this.arcade.startDropAdmin(session.userId,typeof body.rarity==='string'?body.rarity:undefined,now);
        else if(action==='spin')message=this.arcade.spinAdmin(session.userId,now);
        else if(action==='emergency-stop')message=this.arcade.emergencyStop(now);
        else if(action==='challenge'){if(typeof body.title!=='string')throw new Error('Challenge-Titel fehlt.');const actionType=body.actionType;if(!['start_mystery_drop','boost_pet'].includes(String(actionType)))throw new Error('Nur vollständig automatische Glücksrad-Aktionen sind zulässig.');this.arcade.configureChallenge(body.title,boundedInt(body.weight,1,1,1000),true,undefined,actionType as ChaosWheelActionType);this.audit(session,'arcade-challenge','arcade',{},now);this.json(res,200,{ok:true});return;}
        else {this.json(res,400,{error:'Arcade-Aktion ungültig.'});return;}
        if(message)await this.sendToChat?.(message,action==='start-drop'?'drop':action==='spin'&&this.arcade.spinActionTypeAt(now)==='boost_pet'?'pet':'wheel');this.audit(session,'arcade-action',action,{},now);this.json(res,200,{ok:true,message});return;
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
      this.json(res, 200, { ok: true, quest: result.quest, rewardedXp: result.rewardedXp }); return;
    }
    if (route === 'polls') {
      const question = normalizeCommunityText(String(body.question || ''), 3, 180);
      const options = Array.isArray(body.options) ? body.options.map((value) => normalizeCommunityText(String(value), 1, 100)) : [];
      const durationSeconds = Number(body.durationSeconds);
      if (!question || options.length < 2 || options.length > 5 || options.some((option) => !option)
        || new Set(options.map((option) => option!.toLocaleLowerCase())).size !== options.length
        || !Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) {
        this.json(res, 400, { error: 'Umfrage benötigt eine kurze Frage, 2–5 eindeutige Optionen und 10–3600 Sekunden Laufzeit.' }); return;
      }
      const settings = this.store.config('poll_settings', defaultPollSettings());
      const poll = this.store.createPoll({ type: 'chat', question, options: options.map((label) => ({ label: label! })),
        durationMs: durationSeconds * 1000, allowVoteChange: settings.allowVoteChange, createdBy: session.userId, now });
      if (!poll) { this.json(res, 409, { error: 'Eine Umfrage läuft bereits oder die Optionen sind ungültig.' }); return; }
      this.audit(session, 'poll-start', poll.id, { optionCount: options.length }, now); this.json(res, 201, { poll }); return;
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
      if (!['quest','poll','imposter','detective','pet','drop','wheel'].includes(String(type))) { this.json(res, 400, { error: 'Widget-Typ ist ungültig.' }); return; }
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

  private authenticate(req: http.IncomingMessage, res: http.ServerResponse, api = false): Session | undefined {
    const key = this.cookieSession(req); const session = key ? this.sessions.get(key) : undefined;
    if (!session || session.expiresAt <= Date.now() || !this.adminIds.has(session.userId)) {
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

  private rateLimit(ip: string): boolean {
    const now = Date.now(); const record = this.rates.get(ip);
    if (this.rates.size > 10_000) for (const [key, value] of this.rates) if (value.resets <= now) this.rates.delete(key);
    if (!record || record.resets <= now) { this.rates.set(ip, { count: 1, resets: now + 60_000 }); return true; }
    record.count += 1; return record.count <= 120;
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

  private openEventStream(url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.eventStreams.size >= 3) { this.json(res, 429, { error: 'Es sind bereits genügend Event-Streams geöffnet.' }); return; }
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
    this.eventStreams.set(res, timer);
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
      pet:arcade?.petEnabled??false,drops:arcade?.dropsEnabled??false,wheel:arcade?.wheelEnabled??false,
      imposter:mini?.enabled??false,detective:mini?.enabled??false,quests:modules.quests!==false&&quest.enabled!==false,spark:spark.enabled,
      eightBall:modules.eightBall!==false,rps:modules.rps!==false,guess:modules.guess!==false,duels:modules.duels!==false,seasonalEvents};
    if(activeEnabled&&active){help.activeEventName=active.name;help.activeEventCommand=active.command;}
    return help;
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
