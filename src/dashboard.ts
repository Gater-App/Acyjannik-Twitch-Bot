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

interface Session { userId: string; login: string; csrf: string; expiresAt: number; }
interface RuntimeStatus { twitchConnected: boolean; channel: string; startedAt: number; lastError?: string; queued?: number; suppressed?: number; chatResponse?: { profile: string; suppressed: number; deferred: number }; }
interface TokenValidation { client_id: string; user_id: string; login: string; }
interface HelixUser { id: string; login: string; display_name: string; }
type DashboardQuestSettings = QuestPolicy & { enabled: boolean; chatEnabled: boolean; channelPointsEnabled: boolean;
  modsCanModerate: boolean; modsCanSkip: boolean; moderatorUserIds: string[] };
type DashboardPollSettings = { enabled: boolean; durationMs: number; allowVoteChange: boolean; ignoredUserIds: string[] };

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DASHBOARD_STYLE = `.main-nav{position:sticky;top:0;z-index:5;display:flex;gap:8px;overflow:auto;padding:10px;margin:12px -6px;background:#11131bee;border-bottom:1px solid #333746;backdrop-filter:blur(12px)}.main-nav a,.secondary-nav a{white-space:nowrap;color:#e4d8ff;text-decoration:none;padding:9px 12px;border-radius:9px}.main-nav a:hover,.secondary-nav a:hover{background:#302344}.secondary-nav{display:flex;justify-content:flex-end;gap:6px;margin:-8px 0 12px;font-size:.9rem}.dash-section{scroll-margin-top:74px;padding-top:8px}.dash-section>h2{margin:24px 0 4px}.dash-section>.grid{align-items:start}.dash-section .card{height:fit-content;align-self:start}.legacy{display:none}.guide-block,.shared-proposals,.experiment-list{border:1px solid #393d4d;border-radius:11px;padding:12px;margin:10px 0;background:#171923}.guide-block h3,.shared-proposals h3,.experiment-list h3{margin:4px 0 8px}.guide-block p{margin:6px 0}.tag{display:inline-block;border-radius:999px;padding:3px 9px;margin-right:6px;background:#382c50;color:#e8dcff;font-size:.82rem}.next-step{border-left:4px solid #b99aff;padding:10px 12px;background:#292237;border-radius:8px}.status-badge{font-weight:600}@media(max-width:520px){.main-nav{margin-left:-12px;margin-right:-12px}.secondary-nav{justify-content:flex-start;overflow:auto}}`;
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
const DASHBOARD_STRUCTURE_SCRIPT = `(()=>{const groups={uebersicht:document.querySelector('#dashboard-overview'),spiele:document.querySelector('#dashboard-games'),community:document.querySelector('#dashboard-community'),obs:document.querySelector('#dashboard-obs'),befehle:document.querySelector('#dashboard-commands'),einstellungen:document.querySelector('#dashboard-settings')};const byTitle=t=>Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()===t);const move=(t,g)=>{const c=byTitle(t);if(c&&g)g.append(c)};move('Bot-Status',groups.uebersicht);move('Funktionen ein- und ausschalten',groups.einstellungen);move('Saison-Event',groups.community);move('XP korrigieren (nur bei Bedarf)',groups.einstellungen);move('Eigene Chatbefehle (optional)',groups.befehle);move('Zuschauer suchen',groups.einstellungen);move('Begrüßung neuer Chatter',groups.community);move('Community-Quests und Umfragen',groups.community);move('Quest-Abstimmung',groups.community);move('Chat-Umfrage',groups.community);move('Gesprächs-Funken',groups.community);move('Chat-Imposter und Chat-Detektiv',groups.spiele);move('Pet, Überraschung und Glücksrad',groups.spiele);move('OBS: Widgets für den Stream',groups.obs);move('Kanalpunkte',groups.einstellungen);move('Community-Boss',groups.spiele);})();`;
const DASHBOARD_STATUS_SCRIPT = `(()=>{const root=document.querySelector('#dashboard-overview'),card=Array.from(document.querySelectorAll('.card')).find(x=>x.querySelector('h2')?.textContent==='Bot-Status');if(!root||!card)return;const panel=document.createElement('div');panel.className='phase-box';root.append(panel);async function update(){try{const s=await api('status'),label=v=>v==='connected'?'Verbunden':v==='disconnected'?'Nicht verbunden':v===true?'Verbindung offen':v===false?'Getrennt':'Nicht separat geprüft';panel.replaceChildren();for(const [name,value] of [['Dashboard/Bot-Dienst antwortet',s.dashboardResponding?'Ja':'Nein'],['EventSub-WebSocket',label(s.eventSubSocket)],['Eingehender Chat / Befehle',label(s.chatReceive)],['Bot darf Chat senden',label(s.botChatSend)],['Broadcaster-Anmeldung für Kanalpunkte',label(s.broadcasterOAuth)]]){const line=document.createElement('p');line.textContent=name+': '+value;panel.append(line)}if(s.lastError){const err=document.createElement('p');err.textContent='Letzter Fehler: '+s.lastError;panel.append(err)}const note=document.createElement('p');note.textContent='Ein offener WebSocket beweist noch nicht, dass Chat-Ereignisse ankommen. Unbekannte Werte werden nicht als „funktioniert“ angezeigt.';panel.append(note)}catch{panel.textContent='Status konnte gerade nicht geladen werden.'}}update();setInterval(update,15000)})();`;
const DASHBOARD_CLEANUP_SCRIPT = `(()=>{const groups=document.querySelector('#dashboard-obs');const duplicate=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()==='OBS-Widgets');if(duplicate&&groups)groups.append(duplicate);for(const h of document.querySelectorAll('main>h2'))if(['Community-Aktionen','Im Stream anzeigen','Erweiterte Einstellungen'].includes(h.textContent.trim())){h.hidden=true;if(h.nextElementSibling)h.nextElementSibling.hidden=true;if(h.nextElementSibling?.nextElementSibling)h.nextElementSibling.nextElementSibling.hidden=true}for(const s of document.querySelectorAll('main>section.grid'))if(!s.querySelector('.card'))s.hidden=true})();`;
const DASHBOARD_REMAINDER_SCRIPT = `(()=>{const settings=document.querySelector('#dashboard-settings'),obs=document.querySelector('#dashboard-obs');for(const node of [document.querySelector('#settings-form'),document.querySelector('#command-manager')]){const card=node?.closest('.card');if(card&&settings)settings.append(card)}for(const title of ['Quests über Twitch-Kanalpunkte']){const card=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()===title);if(card&&settings)settings.append(card)}const preview=Array.from(document.querySelectorAll('.card')).find(c=>c.querySelector('h2')?.textContent?.trim()==='Overlay-Vorschau');if(preview&&obs)obs.append(preview);for(const section of document.querySelectorAll('main>section.grid'))if(!section.querySelector('.card'))section.hidden=true})();`;
const DASHBOARD_OBS_GUARD_SCRIPT = `document.querySelectorAll('.widget-rotate').forEach(b=>b.onclick=async()=>{if(!confirm('Neuen Link für '+b.dataset.widget+' erstellen? Der bisherige Link und die damit eingerichtete OBS-Quelle werden sofort ungültig.'))return;try{const d=await api('widgets/token','POST',{type:b.dataset.widget,action:'rotate'});document.querySelector('#widget-url').value=d.url;show('Neuer OBS-Link erstellt; die OBS-Quelle muss aktualisiert werden.')}catch(e){show(e.message)}});document.querySelectorAll('.widget-revoke').forEach(b=>b.onclick=async()=>{if(!confirm('Widget-Link widerrufen? Die bisherige OBS-Quelle funktioniert dann nicht mehr.'))return;try{await api('widgets/token','POST',{type:b.dataset.widget,action:'revoke'});document.querySelector('#widget-url').value='';show('OBS-Link widerrufen.')}catch(e){show(e.message)}});`;
const DASHBOARD_GUIDES_SCRIPT = `(()=>{const guides={'Community-Quests und Umfragen':'Was ist das? Zuschauer schlagen Aufgaben vor; du prüfst sie und startest eine Quest selbst. Für eine Chat-Umfrage gibst du Frage und Antworten ein. Zuschauer wählen mit !vote 1, !vote 2 usw. Das Ergebnis startet nichts automatisch. Du musst Questvorschläge freigeben und eine Quest manuell starten oder abschließen. Das Quest-/Umfrage-Widget zeigt den aktiven Stand.','Quest-Abstimmung':'Wähle freigegebene Aufgaben aus und starte die Abstimmung. Zuschauer stimmen mit !vote ab. Nach Ende siehst du das Ergebnis; die Gewinner-Quest wird nur nach deiner Bestätigung gestartet. OBS zeigt Frage und Stimmen.','Chat-Umfrage':'Frage und 2–5 Antworten eingeben und Umfrage starten. Zuschauer stimmen mit !vote Nummer ab. Die Umfrage endet nach dem Timer; du entscheidest danach, was passiert. Das Umfrage-Widget zeigt Stimmen und Ergebnis.','Gesprächs-Funken':'Der Bot zählt vorübergehend Themenhinweise aus dem öffentlichen Kanalchat. Wenn genug verschiedene Personen über ein Thema schreiben, schlägt er eine Aktion vor. Er startet keine Abstimmung ohne Freigabe. Standardmäßig aus; keine privaten Nachrichten.','Pet, Überraschung und Glücksrad':'Community-Pet: Zuschauer können das Pet mit Chatbefehlen gemeinsam entwickeln. Mystery Drop: du startest ihn hier oder das Glücksrad startet ihn automatisch; Zuschauer nehmen mit !claim teil und der Bot verteilt XP nach Ablauf. Chaos Wheel: manuelle Challenge heißt Aufgabe für dich; automatische Felder führen eine Bot-Aktion aus. Aktiviere die Funktionen erst, wenn du sie verwenden möchtest. OBS kann Pet, Drop und Wheel jeweils anzeigen.','Begrüßung neuer Chatter':'Optional: Der Bot begrüßt einen Chatter einmalig, wenn er zum ersten Mal im Kanal schreibt. Hier legst du Text und Platzhalter {user} fest. Die Begrüßung sendet der Bot automatisch; hier musst du danach nichts tun.'};for(const c of document.querySelectorAll('.card')){const h=c.querySelector('h2'),text=h&&guides[h.textContent.trim()];if(!text||c.querySelector('details[data-simple-guide]'))continue;const d=document.createElement('details');d.dataset.simpleGuide='true';const s=document.createElement('summary');s.textContent='Einfach erklärt';const p=document.createElement('p');p.textContent=text;d.append(s,p);c.insertBefore(d,c.children[1]||null)}})();`;
const DASHBOARD_STATUS_SAFE_SCRIPT = `(()=>{const root=document.querySelector('#dashboard-overview'),raw=document.querySelector('#overview');if(raw)raw.hidden=true;const panel=document.createElement('div');panel.className='phase-box';root.append(panel);async function update(){try{const s=await api('status'),label=v=>v==='connected'?'Verbunden':v===true?'Verbindung offen':v===false?'Getrennt':'Nicht separat geprüft';panel.replaceChildren();for(const [name,value] of [['Bot-Dashboard antwortet',s.dashboardResponding?'Ja':'Nein'],['Twitch-Kanal',s.channel||'Nicht bekannt'],['EventSub-Verbindung',label(s.eventSubSocket)],['Chat-Empfang / Befehle',label(s.chatReceive)],['Chat-Nachrichten senden',label(s.botChatSend)],['Kanalpunkte-Twitch-Verbindung',label(s.broadcasterOAuth)]]){const p=document.createElement('p');p.textContent=name+': '+value;panel.append(p)}if(s.errorPresent){const p=document.createElement('p');p.textContent='Technischer Hinweis vorhanden; bitte vor Livebetrieb prüfen.';panel.append(p)}const p=document.createElement('p');p.textContent='Eine offene EventSub-Verbindung allein belegt noch keinen eingehenden Chatempfang.';panel.append(p)}catch{panel.textContent='Status konnte gerade nicht geladen werden.'}}update();setInterval(update,15000)})();`;
const CHAT_RESPONSE_SCRIPT = `(()=>{const root=document.querySelector('#chat-response-settings');if(!root)return;api('chat-messages').then(s=>{root.replaceChildren();const form=document.createElement('form'),title=document.createElement('h3');title.textContent='Wie oft soll der Bot schreiben?';const select=document.createElement('select');select.name='profile';for(const [value,label] of [['calm','Ruhig – möglichst wenige Antworten'],['normal','Ausgewogen – empfohlen'],['lively','Lebhaft – mehr direkte Reaktionen']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option)}select.value=s.profile;const help=document.createElement('p');help.className='muted';help.textContent='Ruhig und Ausgewogen: persönliche Statusabfragen (!level, !rank, !pumpkins, !dropstats) und Routine-Erfolge werden nicht öffentlich beantwortet. Twitch-Whispers bzw. eine private Zuschauer-Seite sind derzeit nicht eingerichtet; es werden keine neuen Berechtigungen angefordert. Wichtige Spielstarts, Ergebnisse und Fehler bleiben sichtbar. Lebhaft zeigt mehr Einzelreaktionen.';const names=document.createElement('textarea');names.name='welcomeBots';names.rows=3;names.value=(s.welcomeBots||[]).join(', ');names.setAttribute('aria-label','Bots von Begrüßungen ausschließen');const label=document.createElement('label');label.textContent='Bots nicht begrüßen (Komma-getrennte Namen)';label.append(names);const save=document.createElement('button');save.textContent='Speichern';form.append(title,select,help,label,save);form.onsubmit=async e=>{e.preventDefault();try{await api('chat-messages','POST',{profile:select.value,welcomeBots:names.value.split(',').map(x=>x.trim()).filter(Boolean)});show('Chat-Antworten gespeichert.');refreshStats()}catch(err){show(err.message)}};root.append(form);const stats=document.createElement('p');stats.className='muted';root.append(stats);async function refreshStats(){try{const current=await api('chat-messages');stats.textContent='Seit Bot-Start: '+(current.suppressed||0)+' Antworten unterdrückt, '+(current.deferred||0)+' wegen Chattempo begrenzt, '+(current.queued||0)+' Nachrichten warten im Chatversand.'}catch{stats.textContent='Versandstatus derzeit nicht verfügbar.'}}refreshStats();setInterval(refreshStats,15000)}).catch(e=>{root.textContent='Einstellungen konnten nicht geladen werden: '+e.message})})();`;
const CHAT_IDENTITY_PREVIEW_SCRIPT = `(()=>{const root=document.querySelector('#chat-identity-preview');if(!root)return;root.innerHTML='<h3>Chat-Stil: COMMUNITY</h3><p class="muted">Jede öffentliche Bot-Nachricht erhält automatisch ein passendes, gut erkennbares Kategorien-Schild.</p>';for(const text of ['【🎁 DROP】 Mystery Drop gestartet! Schreibt !claim.','【🎭 IMPOSTER】 Die Abstimmung beginnt!','【❓ HILFE】 Verfügbare Befehle findest du mit !help.']){const sample=document.createElement('p');sample.className='chat-preview';sample.textContent=text;root.append(sample)}})();`;
const ARCADE_SMART_CONTROLS_SCRIPT = `(()=>{const dropButton=document.querySelector('#arcade-drop'),spinButton=document.querySelector('#arcade-spin'),stopButton=document.querySelector('#arcade-stop'),state=document.querySelector('#arcade-state'),widget=document.querySelector('#arcade-widget-status');async function update(){try{const d=await api('arcade'),w=d.wheel,drop=d.drop?.drop,activeDrop=Boolean(drop&&['announced','claiming','resolving'].includes(drop.status));dropButton.hidden=!d.settings.dropsEnabled||activeDrop;dropButton.disabled=!d.settings.dropsEnabled||activeDrop;dropButton.title=activeDrop?'Der aktuelle Drop läuft bereits.':d.settings.dropsEnabled?'60 Sekunden Teilnahme mit !claim':'Schalte Drops in den optionalen Einstellungen ein.';spinButton.hidden=!d.settings.wheelEnabled||!w.autoPilotEnabled;stopButton.hidden=!w.autoPilotEnabled;spinButton.disabled=!w.canSpin;let line=state.querySelector('[data-drop-status]');if(!line){line=document.createElement('p');line.dataset.dropStatus='true';state.append(line)}line.textContent=activeDrop?'🎁 '+drop.participants+' Teilnehmende · noch '+Math.max(0,Math.ceil((drop.endsAt-Date.now())/1000))+' Sekunden':'🎁 Kein Drop aktiv.';line.hidden=!d.settings.dropsEnabled;const links=await api('widgets/status');widget.textContent='OBS: Drop '+(links.widgets?.drop?'eingerichtet':'nicht eingerichtet')+' · Glücksrad '+(links.widgets?.wheel?'eingerichtet':'nicht eingerichtet')+'. Ohne OBS funktionieren Chat und Spiel weiter.'}catch{widget.textContent='OBS-Linkstatus aktuell nicht prüfbar.'}}update();setInterval(update,3000);setInterval(()=>{const line=state.querySelector('[data-drop-status]');if(line&&line.textContent.includes('Teilnehmende'))update()},1000)})();`;
const DASHBOARD_SHORTCUT_SCRIPT = `(()=>{const overview=document.querySelector('#dashboard-overview'),actions=document.createElement('div');actions.className='row';for(const [label,href] of [['Imposter starten','#spiele'],['Umfrage erstellen','#community'],['OBS-Widgets öffnen','#obs']]){const a=document.createElement('a');a.href=href;a.textContent=label;a.className='button-link';actions.append(a)}overview.prepend(actions);const commands=document.querySelector('#dashboard-commands'),tip=document.createElement('p');tip.className='muted';tip.textContent='Im Chat zeigt !help die Kurz-Hilfe. Zuschauer können dort Themen wie Punkte, Spiele und Umfragen nachschlagen.';commands.prepend(tip)})();`;
const DASHBOARD_OBS_DEMO_SCRIPT = `(()=>{const select=document.querySelector('#obs-type'),host=document.querySelector('#obs-result');if(!select||!host)return;const box=document.createElement('div');box.className='preview-widget';box.setAttribute('aria-live','polite');const title=document.createElement('strong'),line=document.createElement('p');title.textContent='Vorschau';line.textContent='Beispielanzeige für die ausgewählte Browserquelle.';box.append(title,line);host.before(box);function update(){const labels={imposter:'CHAT-IMPOSTER · Anmeldung · 4 Teilnehmende · Countdown',detective:'WER HAT DAS GESCHRIEBEN? · „Beispielzitat aus dem Chat“',poll:'LIVE-UMFRAGE · Welche Runde als Nächstes?',quest:'LIVE-QUEST · Gemeinsam eine Aufgabe schaffen',pet:'COMMUNITY-PET · gemeinsamer Fortschritt',drop:'MYSTERY DROP · !claim zum Mitmachen',wheel:'CHAOS WHEEL · Das Rad dreht sich'};line.textContent=labels[select.value]+' — Beispiel; live erscheinen hier die echten Spieldaten.'}select.addEventListener('change',update);update()})();`;
const DASHBOARD_TIMER_SCRIPT = `(()=>{setInterval(()=>{const node=document.querySelector('#mini-next');if(!node)return;if(!node.querySelector('[data-countdown]')){node.dataset.phaseText=node.textContent;const timer=document.createElement('span');timer.dataset.countdown='true';node.append(timer)}const timer=node.querySelector('[data-countdown]');timer.textContent=miniEndsAt?' · Countdown '+Math.floor(Math.max(0,miniEndsAt-Date.now())/1000)+' Sek.':''},1000)})();`;
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
    if (url.pathname === '/dashboard/login' && req.method === 'GET') { this.login(res); return; }
    if (url.pathname === '/dashboard/oauth/callback' && req.method === 'GET') { await this.callback(url, req, res); return; }
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
      const structure = `<nav class="main-nav" aria-label="Hauptbereiche"><a href="#uebersicht">Übersicht</a><a href="#spiele">Spiele</a><a href="#community">Community</a><a href="#obs">OBS</a></nav><nav class="secondary-nav" aria-label="Weitere Werkzeuge"><a href="#chat-nachrichten">Chat-Nachrichten</a><a href="#befehle">Chatbefehle</a><a href="#einstellungen">Weitere Einstellungen</a></nav><section id="uebersicht" class="dash-section"><h2>Übersicht</h2><p class="muted">Status und schnelle Orientierung. Unbekannt heißt: Diese Information kann gerade nicht sicher bestätigt werden.</p><div id="dashboard-overview" class="grid"></div></section><section id="spiele" class="dash-section"><h2>Spiele</h2><div id="dashboard-games" class="grid"></div></section><section id="community" class="dash-section"><h2>Community</h2><div id="dashboard-community" class="grid"></div></section><section id="obs" class="dash-section"><h2>OBS</h2><div id="dashboard-obs" class="grid"></div></section><section id="chat-nachrichten" class="dash-section"><h2>Chat-Nachrichten</h2><p class="muted">Lege fest, wie häufig der Bot antwortet. Das ändert weder Spieleinstellungen noch Twitch-Berechtigungen.</p><article class="card"><div id="chat-response-settings"></div><div id="chat-identity-preview" class="chat-identity-preview"></div></article></section><section id="befehle" class="dash-section"><h2>Chatbefehle</h2><div id="dashboard-commands" class="grid"></div></section><section id="einstellungen" class="dash-section"><h2>Weitere Einstellungen</h2><p class="muted">Selten benötigte Einstellungen. Für den normalen Betrieb musst du hier meist nichts ändern.</p><div id="dashboard-settings" class="grid"></div></section>`;
      const page = PAGE.replace('</style>', DASHBOARD_STYLE+'</style>').replace('</p><section class="grid">', `</p>${structure}<section class="grid">`).replace('</section></main>', `</section><h2>Community-Aktionen</h2><p class="muted">Hier startest du Dinge, die Zuschauer gemeinsam im Chat spielen oder entscheiden können.</p><section class="grid">${WELCOME_CARD}${QUEST_POLL_CARD}${SPARK_CARD}${MINI_GAME_CARD}${ARCADE_CARD}</section><h2>Im Stream anzeigen</h2><p class="muted">OBS-Widgets sind Stream-Einblendungen. Die Einrichtung dauert nur wenige Schritte.</p><section class="grid">${OBS_CARD}</section><h2>Erweiterte Einstellungen</h2><p class="muted">Nur ändern, wenn du genau weißt, was du anpassen möchtest. Die Grundeinstellungen musst du hier nicht anfassen.</p><section class="grid">${CHANNEL_POINTS_CARD}${SETTINGS_CARD}</section></main>`)
        .replace('</script>', `${OBS_SCRIPT}${SETTINGS_SCRIPT}${WELCOME_SCRIPT}${QUEST_POLL_SCRIPT}${SPARK_SCRIPT}${MINI_GAME_SCRIPT}${CHANNEL_POINTS_SCRIPT}${ARCADE_SCRIPT}${ARCADE_SMART_CONTROLS_SCRIPT}${DASHBOARD_WORDING_SCRIPT}${DASHBOARD_STRUCTURE_SCRIPT}${DASHBOARD_STATUS_SCRIPT}${DASHBOARD_CLEANUP_SCRIPT}${DASHBOARD_REMAINDER_SCRIPT}${DASHBOARD_OBS_GUARD_SCRIPT}${DASHBOARD_TIMER_SCRIPT}${DASHBOARD_SHORTCUT_SCRIPT}${DASHBOARD_OBS_DEMO_SCRIPT}${DASHBOARD_STATUS_SAFE_SCRIPT}${CHAT_RESPONSE_SCRIPT}${CHAT_IDENTITY_PREVIEW_SCRIPT}document.querySelector('#dashboard-overview .phase-box')?.remove();${DASHBOARD_UX_V3_SCRIPT}</script>`);
      res.end(page.replaceAll('__CSRF__', session.csrf).replaceAll('__NONCE__', nonce)); return;
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
    if (route === 'chat-messages' && req.method === 'GET') {
      const policy=this.chatPolicy??new ChatResponsePolicy(this.store.config('chat_response_settings',DEFAULT_CHAT_RESPONSE_SETTINGS));
      const runtime=this.getStatus(),snapshot=policy.snapshot();
      this.json(res,200,{...snapshot,suppressed:snapshot.suppressed+(runtime.suppressed??0),queued:runtime.queued??0});return;
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
      const welcomeBots=body.welcomeBots===undefined?DEFAULT_CHAT_RESPONSE_SETTINGS.welcomeBots:body.welcomeBots;
      if(!Array.isArray(welcomeBots)||welcomeBots.length>50||welcomeBots.some((x)=>typeof x!=='string'||x.length>50||!/^[a-z0-9_]+$/iu.test(x))){this.json(res,400,{error:'Die Bot-Ausschlussliste ist ungültig (maximal 50 Twitch-Namen).'});return;}
      const settings={profile:body.profile,welcomeBots:[...new Set(welcomeBots.map((x:string)=>x.toLowerCase()))]};
      this.store.setConfig('chat_response_settings',settings);this.chatPolicy?.configure(settings);this.audit(session,'chat-response-settings','chat',{profile:settings.profile,welcomeBotCount:settings.welcomeBots.length},now);this.json(res,200,{ok:true});return;
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
    if(route==='arcade'&&this.arcade){
      try{
        if(body.settings!==undefined){if(!isRecord(body.settings))throw new Error('Arcade-Einstellungen ungültig.');this.arcade.updateSettings(body.settings as never);if(body.settings.wheelAutoPilotEnabled===true)this.arcade.resumeAutoPilot();this.audit(session,'arcade-settings','arcade',{},now);this.json(res,200,{ok:true});return;}
        const action=String(body.action||'');let message='';
        if(action==='start-drop')message=this.arcade.startDropAdmin(session.userId,typeof body.rarity==='string'?body.rarity:undefined,now);
        else if(action==='spin')message=this.arcade.spinAdmin(session.userId,now);
        else if(action==='emergency-stop')message=this.arcade.emergencyStop(now);
        else if(action==='challenge'){if(typeof body.title!=='string')throw new Error('Challenge-Titel fehlt.');const actionType=body.actionType??'manual_challenge';if(!['manual_challenge','start_mystery_drop','boost_pet'].includes(String(actionType)))throw new Error('Wheel-Aktion ist ungültig.');this.arcade.configureChallenge(body.title,boundedInt(body.weight,1,1,1000),true,undefined,actionType as ChaosWheelActionType);this.audit(session,'arcade-challenge','arcade',{},now);this.json(res,200,{ok:true});return;}
        else {this.json(res,400,{error:'Arcade-Aktion ungültig.'});return;}
        if(message)await this.sendToChat?.(message,action==='start-drop'?'drop':'wheel');this.audit(session,'arcade-action',action,{},now);this.json(res,200,{ok:true,message});return;
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
