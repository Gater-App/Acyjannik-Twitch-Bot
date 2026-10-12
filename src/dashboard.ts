import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { FeatureStore, type CustomCommand, type QuestPolicy, type QuestStatus, type SeasonalEvent, type WidgetType } from './feature-store.js';
import { communityWidgetHtml, QUEST_POLL_CARD, QUEST_POLL_SCRIPT } from './dashboard-community-ui.js';
import { SPARK_CARD, SPARK_SCRIPT } from './conversation-spark-ui.js';
import { DEFAULT_SPARK_CONFIG, type SparkActionType, type SparkConfig, type SparkTopic } from './conversation-spark.js';
import { CHANNEL_POINTS_CARD, CHANNEL_POINTS_SCRIPT } from './channel-points-ui.js';
import { DEFAULT_CHANNEL_POINTS_SETTINGS, type ChannelPointsService, type ChannelPointsSettings } from './channel-points.js';
import type { Logger } from './logger.js';
import type { MiniGames, MiniGameSettings } from './mini-games.js';
import { MINI_GAME_CARD, MINI_GAME_SCRIPT } from './mini-games-ui.js';

interface Session { userId: string; login: string; csrf: string; expiresAt: number; }
interface RuntimeStatus { twitchConnected: boolean; channel: string; startedAt: number; lastError?: string; }
interface TokenValidation { client_id: string; user_id: string; login: string; }
interface HelixUser { id: string; login: string; display_name: string; }
type DashboardQuestSettings = QuestPolicy & { enabled: boolean; chatEnabled: boolean; channelPointsEnabled: boolean;
  modsCanModerate: boolean; modsCanSkip: boolean; moderatorUserIds: string[] };
type DashboardPollSettings = { enabled: boolean; durationMs: number; allowVoteChange: boolean; ignoredUserIds: string[] };

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf" content="__CSRF__"><title>Community Bot · Admin</title><style nonce="__NONCE__">
:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#11131b;color:#eef0f8}body{margin:0;background:radial-gradient(ellipse at top right,#30234a 0,transparent 35%),#11131b}main{max-width:1100px;margin:auto;padding:28px 20px}h1{margin:0 0 8px}p{color:#aeb2c3}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:20px 0}.card{background:#1b1e29;border:1px solid #333746;border-radius:14px;padding:18px}.accent{color:#c0a0ff}input,select,textarea,button{font:inherit;color:inherit;background:#10121a;border:1px solid #44495d;border-radius:8px;padding:10px;max-width:100%;box-sizing:border-box}textarea{width:100%;min-height:70px}button{background:#7652bd;border:0;cursor:pointer;margin:4px 2px}button:hover{background:#8d6bd1}label{display:block;margin:9px 0;color:#c7cad6}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#cbd0e0}form{display:grid;gap:8px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.muted{color:#979caf;font-size:.9rem}#notice{min-height:1.4rem;color:#ffc987}.preview-widget{margin:12px 0;padding:14px;border:1px solid #b69cff;border-left:5px solid #b69cff;border-radius:12px;background:linear-gradient(130deg,rgba(19,22,32,.96),rgba(42,34,57,.9));overflow-wrap:anywhere}.preview-widget p{margin:8px 0;color:#eef0f8}.preview-widget small{color:#b6b8c6}@media(max-width:520px){main{padding:18px 12px}.card{padding:14px}}
</style></head><body><main><div class="row"><div><h1>Community Bot <span class="accent">Admin</span></h1><p id="who">Geschützte Verwaltung</p></div><button id="logout">Abmelden</button></div><p id="notice" role="status"></p><section class="grid"><article class="card"><h2>Übersicht</h2><pre id="overview">Lade Status …</pre></article><article class="card"><h2>Module</h2><div id="modules"></div></article><article class="card"><h2>Saison-Events</h2><div id="events"></div><form id="event-form"><input name="id" placeholder="ID, z. B. summer" required pattern="[a-z0-9_-]{2,40}"><input name="name" placeholder="Name" required><input name="emoji" placeholder="Emoji" value="✨"><input name="command" placeholder="Befehl, z. B. summerhunt" required><input name="currency" placeholder="Punktewährung" required><input name="cooldownMs" type="number" min="0" value="900000"><button>Event anlegen/aktualisieren</button></form></article><article class="card"><h2>XP-Korrektur</h2><form id="xp-form"><input name="userId" placeholder="Twitch User-ID" required><input name="amount" type="number" placeholder="XP + / -" required><input name="reason" placeholder="Begründung" required maxlength="200"><button>Korrektur protokollieren</button></form><p class="muted">Korrekturen sind begrenzt und werden auditiert.</p></article><article class="card"><h2>Chatbefehle</h2><pre id="commands"></pre><form id="command-form"><input name="name" placeholder="Befehlsname" required><textarea name="response" placeholder="Antwort; Platzhalter: {user}, {channel}, {game}, {uptime}" required></textarea><select name="permission"><option value="everyone">Alle</option><option value="moderator">Moderatoren</option><option value="broadcaster">Broadcaster</option></select><input name="cooldownMs" type="number" min="0" value="10000"><button>Befehl speichern</button></form></article><article class="card"><h2>Nutzer</h2><form id="users-form"><input name="q" placeholder="Name oder ID suchen"><button>Suchen</button></form><pre id="users"></pre></article></section></main><script nonce="__NONCE__">
const csrf=document.querySelector('meta[name=csrf]').content,notice=document.querySelector('#notice');async function api(path,method='GET',data){const r=await fetch('/dashboard/api/'+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(data?{body:JSON.stringify(data)}:{})});const d=await r.json().catch(()=>({error:'Ungültige Serverantwort'}));if(!r.ok)throw Error(d.error||'Anfrage fehlgeschlagen');return d}function show(text){notice.textContent=text;setTimeout(()=>notice.textContent='',5000)}async function refresh(){try{const d=await api('overview');document.querySelector('#who').textContent='Angemeldet als '+d.admin.login;document.querySelector('#overview').textContent=JSON.stringify(d.status,null,2);const mods=document.querySelector('#modules');mods.replaceChildren();for(const [key,on] of Object.entries(d.status.modules||{})){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=Boolean(on);box.addEventListener('change',async()=>{try{await api('modules','POST',{key,enabled:box.checked});show('Modul gespeichert.')}catch(e){box.checked=!box.checked;show(e.message)}});label.append(box,' '+key);mods.append(label)}const ev=await api('events');const box=document.querySelector('#events');box.replaceChildren();for(const event of ev.events){const line=document.createElement('div'),text=document.createElement('span');text.textContent=event.emoji+' '+event.name+' · '+(event.active?'aktiv':'inaktiv')+' ';line.append(text);const b=document.createElement('button');b.textContent=event.active?'Beenden':'Starten';b.onclick=async()=>{try{await api('events','POST',{id:event.id,active:!event.active});show('Eventstatus gespeichert.');refresh()}catch(e){show(e.message)}};line.append(b);box.append(line)}const c=await api('commands');document.querySelector('#commands').textContent=JSON.stringify(c.commands,null,2)}catch(e){show(e.message)}}document.querySelector('#event-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownMs);try{await api('events','POST',v);show('Event gespeichert.');e.currentTarget.reset();refresh()}catch(x){show(x.message)}};document.querySelector('#xp-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.amount=Number(v.amount);try{await api('xp-adjust','POST',v);show('XP-Korrektur protokolliert.');e.currentTarget.reset()}catch(x){show(x.message)}};document.querySelector('#command-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownMs);try{await api('commands','POST',v);show('Chatbefehl gespeichert.');refresh()}catch(x){show(x.message)}};document.querySelector('#users-form').onsubmit=async e=>{e.preventDefault();const v=new FormData(e.currentTarget);try{const u=await api('users?q='+encodeURIComponent(v.get('q')||''));document.querySelector('#users').textContent=JSON.stringify(u.users,null,2)}catch(x){show(x.message)}};document.querySelector('#logout').onclick=async()=>{try{await api('logout','POST',{});location.reload()}catch(e){show(e.message)}};refresh();setInterval(refresh,15000);
</script></body></html>`;

const SETTINGS_CARD = `<article class="card"><h2>XP, Spiele, Events & Community</h2><p class="muted">Erweiterte Werte als JSON bearbeiten. Änderungen werden geprüft und protokolliert.</p><form id="settings-form"><textarea id="settings-json" rows="14" spellcheck="false" aria-label="Bot-Einstellungen als JSON"></textarea><button>Einstellungen speichern</button></form></article><article class="card"><h2>Community-Boss</h2><form id="boss-form"><input name="name" placeholder="Bossname" value="Schattenkönig"><input name="hp" type="number" min="1" value="1000"><input name="durationMs" type="number" min="60000" value="900000"><button>Bosskampf starten</button></form><button id="boss-end">Bosskampf beenden</button></article><article class="card"><h2>Eigene Chatbefehle verwalten</h2><div id="command-manager"></div></article>`;
const SETTINGS_SCRIPT = `api('settings').then(s=>document.querySelector('#settings-json').value=JSON.stringify(s,null,2)).catch(e=>show(e.message));document.querySelector('#settings-form').onsubmit=async e=>{e.preventDefault();try{const value=JSON.parse(document.querySelector('#settings-json').value);await api('settings','POST',value);show('Einstellungen gespeichert.')}catch(x){show(x.message)}};document.querySelector('#boss-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.hp=Number(v.hp);v.durationMs=Number(v.durationMs);try{await api('boss','POST',v);show('Bosskampf gestartet.');refresh()}catch(x){show(x.message)}};document.querySelector('#boss-end').onclick=async()=>{try{await api('boss','POST',{action:'end'});show('Bosskampf beendet.');refresh()}catch(x){show(x.message)}};async function renderCommandAdmin(){try{const c=await api('commands'),root=document.querySelector('#command-manager');root.replaceChildren();for(const command of c.commands){const row=document.createElement('div'),name=document.createElement('span');name.textContent='!'+command.name+(command.alias?' ('+command.alias+')':'')+' · '+(command.enabled?'aktiv':'inaktiv')+' ';row.append(name);const edit=document.createElement('button');edit.textContent='Bearbeiten';edit.onclick=()=>{const f=document.querySelector('#command-form');f.elements.namedItem('name').value=command.name;f.elements.namedItem('response').value=command.response;f.elements.namedItem('permission').value=command.permission;f.elements.namedItem('cooldownMs').value=command.cooldownMs;f.scrollIntoView({behavior:'smooth',block:'center'})};row.append(edit);const toggle=document.createElement('button');toggle.textContent=command.enabled?'Deaktivieren':'Aktivieren';toggle.onclick=async()=>{try{await api('commands','POST',{...command,enabled:!command.enabled});show('Chatbefehl geändert.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(toggle);const del=document.createElement('button');del.textContent='Löschen';del.onclick=async()=>{try{await api('commands/delete','POST',{name:command.name});show('Chatbefehl gelöscht.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(del);root.append(row)}}catch(x){show(x.message)}}renderCommandAdmin();setInterval(renderCommandAdmin,15000);`;

export class DashboardServer {
  private server: http.Server | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly states = new Map<string, number>();
  private readonly rates = new Map<string, { count: number; resets: number }>();
  private readonly eventStreams = new Map<http.ServerResponse, NodeJS.Timeout>();
  private readonly widgetStreams = new Map<http.ServerResponse, NodeJS.Timeout>();
  private readonly participantStates = new Map<string, number>();
  private readonly participantSessions = new Map<string, {userId:string;expiresAt:number}>();
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
    private readonly getSparkSnapshot: () => unknown[] = () => [],
    private readonly channelPoints?:ChannelPointsService,
    private readonly getChannelPointsConnectUrl?:()=>string,
    private readonly miniGames?:MiniGames,
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
    this.participantSessions.clear(); this.participantStates.clear();
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
    if (url.pathname === '/games/imposter/callback' && req.method === 'GET') { await this.participantCallback(url,req,res); return; }
    if (url.pathname === '/games/imposter/role' && req.method === 'GET') { this.participantRole(req,res); return; }
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
      const page = PAGE.replace('</section></main>', `${SETTINGS_CARD}${QUEST_POLL_CARD}${SPARK_CARD}${CHANNEL_POINTS_CARD}${MINI_GAME_CARD}</section></main>`)
        .replace('</script>', `${SETTINGS_SCRIPT}${QUEST_POLL_SCRIPT}${SPARK_SCRIPT}${CHANNEL_POINTS_SCRIPT}${MINI_GAME_SCRIPT}</script>`);
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
    const page = /^\/widgets\/(quest|poll|imposter|detective)$/u.exec(url.pathname);
    const api = /^\/widgets\/api\/(quest|poll|imposter|detective)$/u.exec(url.pathname);
    const stream = /^\/widgets\/stream\/(quest|poll|imposter|detective)$/u.exec(url.pathname);
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
      res.end(type==='quest'||type==='poll'?communityWidgetHtml(type, nonce, settings.fontSize, settings.theme):miniGameWidgetHtml(type,nonce,settings.fontSize,settings.theme));
      return;
    }
    if (api) { this.json(res, 200, this.store.widgetSnapshot(type, Date.now())); return; }
    this.openWidgetEventStream(type, res);
  }

  private openWidgetEventStream(type: WidgetType, res: http.ServerResponse): void {
    if (this.widgetStreams.size >= 10) { this.json(res, 429, { error: 'Zu viele OBS-Verbindungen.' }); return; }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    let previous = '';
    const send = () => {
      try {
        const snapshot = this.store.widgetSnapshot(type, Date.now());
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

  private participantLogin(res:http.ServerResponse):void {
    const redirect=new URL('/games/imposter/callback',new URL(this.redirectUri).origin).toString();
    const state=randomBytes(24).toString('hex');this.participantStates.set(state,Date.now()+10*60_000);
    for(const [key,expires] of this.participantStates)if(expires<=Date.now())this.participantStates.delete(key);
    const auth=new URL('https://id.twitch.tv/oauth2/authorize');auth.searchParams.set('client_id',this.clientId);auth.searchParams.set('redirect_uri',redirect);auth.searchParams.set('response_type','code');auth.searchParams.set('scope','');auth.searchParams.set('state',state);
    res.statusCode=302;res.setHeader('Cache-Control','no-store');res.setHeader('Set-Cookie',`imposter_oauth_state=${state}; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);res.setHeader('Location',auth.toString());res.end();
  }

  private async participantCallback(url:URL,req:http.IncomingMessage,res:http.ServerResponse):Promise<void>{
    const state=url.searchParams.get('state')||'',expires=this.participantStates.get(state)||0;this.participantStates.delete(state);
    const clear='imposter_oauth_state=; Path=/games/imposter; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
    if(!state||expires<Date.now()||this.cookieValue('imposter_oauth_state',req)!==state){res.setHeader('Set-Cookie',clear);this.json(res,400,{error:'Teilnehmer-Anmeldung ist ungültig oder abgelaufen.'});return;}
    if(url.searchParams.has('error')){res.setHeader('Set-Cookie',clear);this.json(res,400,{error:'Twitch-Anmeldung abgebrochen.'});return;}
    const code=url.searchParams.get('code');if(!code){res.setHeader('Set-Cookie',clear);this.json(res,400,{error:'OAuth-Code fehlt.'});return;}
    const redirect=new URL('/games/imposter/callback',new URL(this.redirectUri).origin).toString();
    const tokenResponse=await this.fetchImpl('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,code,grant_type:'authorization_code',redirect_uri:redirect})});
    if(!tokenResponse.ok){res.setHeader('Set-Cookie',clear);this.json(res,401,{error:'Twitch-Anmeldung konnte nicht verifiziert werden.'});return;}
    const token=await tokenResponse.json() as {access_token?:string};if(!token.access_token){res.setHeader('Set-Cookie',clear);this.json(res,401,{error:'Twitch hat kein gültiges Token geliefert.'});return;}
    const validResponse=await this.fetchImpl('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${token.access_token}`}});const valid=validResponse.ok?await validResponse.json() as TokenValidation:undefined;
    const userResponse=valid?await this.fetchImpl('https://api.twitch.tv/helix/users',{headers:{'Client-Id':this.clientId,Authorization:`Bearer ${token.access_token}`}}):undefined;
    const payload=userResponse?.ok?await userResponse.json() as {data?:HelixUser[]}:undefined;const user=payload?.data?.[0];
    if(!valid||valid.client_id!==this.clientId||!user||valid.user_id!==user.id){res.setHeader('Set-Cookie',clear);this.json(res,401,{error:'Twitch-Identität konnte nicht bestätigt werden.'});return;}
    const role=this.miniGames?.roleFor(user.id);if(!role){res.setHeader('Set-Cookie',clear);this.json(res,403,{error:'Für dieses Twitch-Konto gibt es keine aktive Rolle.'});return;}
    const key=randomBytes(32).toString('hex');this.participantSessions.set(key,{userId:user.id,expiresAt:Date.now()+30*60_000});
    res.setHeader('Cache-Control','no-store');res.setHeader('Set-Cookie',[clear,`imposter_participant=${key}; Path=/games/imposter; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`]);res.statusCode=303;res.setHeader('Location','/games/imposter/role');res.end();
  }

  private participantRole(req:http.IncomingMessage,res:http.ServerResponse):void {
    res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');
    const key=this.cookieValue('imposter_participant',req)||'',session=this.participantSessions.get(key);
    if(!session||session.expiresAt<=Date.now()){if(key)this.participantSessions.delete(key);res.setHeader('Set-Cookie','imposter_participant=; Path=/games/imposter; HttpOnly; Secure; SameSite=Strict; Max-Age=0');res.statusCode=303;res.setHeader('Location','/games/imposter/login');res.end();return;}
    const role=this.miniGames?.roleFor(session.userId);if(!role){this.participantSessions.delete(key);this.json(res,410,{error:'Die Runde ist beendet oder deine Teilnahme wurde entfernt.'});return;}
    const nonce=randomBytes(18).toString('base64');res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);res.setHeader('Content-Type','text/html; charset=utf-8');
    const secret=role.role==='imposter'?'Du bist der IMPOSTER! Beobachte den Chat und versuche, nicht aufzufallen.':`Deine geheime Regel lautet: ${role.rule}`;
    res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Deine geheime Rolle</title><style nonce="${nonce}">body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11131b;color:#f5f2ff;font:20px system-ui}main{max-width:640px;margin:24px;padding:28px;border:1px solid #7652bd;border-radius:18px;background:#1b1e29}p{line-height:1.6;color:#d1c5f1}</style><main><h1>🎭 Deine geheime Rolle</h1><p>${escapeHtml(secret)}</p><small>Bitte teile diese Information nicht im öffentlichen Chat oder Stream.</small></main></html>`);
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
      `community_admin=${key}; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
    ]);
    res.statusCode = 303; res.setHeader('Location', '/dashboard'); res.end();
  }

  private async api(url: URL, req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
    const route = url.pathname.slice('/dashboard/api/'.length);
    if(route==='minigames'&&req.method==='GET'){
      if(!this.miniGames){this.json(res,503,{error:'Minispiele sind nicht initialisiert.'});return;}
      this.json(res,200,{settings:this.miniGames.settings(),state:this.miniGames.snapshot(Date.now()),quotes:this.miniGames.managedQuotes()});return;
    }
    if (route === 'overview' && req.method === 'GET') { this.json(res, 200, { admin: { login: session.login }, status: { ...this.store.overview(), ...this.getStatus() } }); return; }
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
    if (route === 'spark' && req.method === 'GET') {
      const settings=this.store.config<SparkConfig>('spark_settings',DEFAULT_SPARK_CONFIG);
      this.store.expireSparkProposals(Date.now());
      this.json(res,200,{settings,customTopics:this.store.config<SparkTopic[]>('spark_topics',[]),topics:this.getSparkSnapshot(),
        proposals:this.store.sparkProposals('all',50),pending:this.store.sparkProposals('pending_approval',100).length,
        cooldowns:this.store.sparkCooldowns(Date.now())}); return;
    }
    if(route==='channel-points'&&req.method==='GET'){
      const settings=this.channelPoints?.settings()||this.store.config<ChannelPointsSettings>('channel_points_settings',DEFAULT_CHANNEL_POINTS_SETTINGS);
      this.json(res,200,{settings,connected:this.channelPoints?.connected()||false,redemptions:this.store.channelRedemptions(100),
        message:this.channelPoints?.connected()?'API-Berechtigung verfügbar.':(this.channelPoints?.oauthStatusMessage||'Broadcaster-OAuth mit channel:manage:redemptions fehlt.')});return;
    }
    if(route==='channel-points/rewards'&&req.method==='GET'){
      if(!this.channelPoints){this.json(res,503,{error:'Kanalpunkte-Service ist nicht gestartet.'});return;}
      try{this.json(res,200,{rewards:await this.channelPoints.manageableRewards()});}
      catch(error){this.json(res,502,{error:error instanceof Error?error.message:'Twitch-Rewards konnten nicht geladen werden.'});}return;
    }
    if (route === 'stream' && req.method === 'GET') { this.openEventStream(url, req, res); return; }
    if (req.method !== 'POST') { this.json(res, 405, { error: 'Methode nicht erlaubt.' }); return; }
    const body = await this.readJson(req); if (!body) { this.json(res, 400, { error: 'Ungültiger JSON-Body.' }); return; }
    const now = Date.now();
    if(route==='minigames/action'){
      if(!this.miniGames){this.json(res,503,{error:'Minispiele sind nicht initialisiert.'});return;}
      const action=String(body.action||'');let message='';
      if(action==='settings'&&typeof body.enabled==='boolean'){
        this.miniGames.updateSettings({...this.miniGames.settings(),enabled:body.enabled});this.audit(session,'minigames-enabled','bot',{enabled:body.enabled},now);this.json(res,200,{ok:true});return;
      }
      if(action==='save-settings'&&isRecord(body.settings)){
        try{const current=this.miniGames.settings(),raw=body.settings,imp=isRecord(raw.imposter)?raw.imposter:{},det=isRecord(raw.detective)?raw.detective:{};
          const number=(v:unknown,old:number,min:number,max:number)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`Zahl muss zwischen ${min} und ${max} liegen.`);return n;};
          const bool=(v:unknown,old:boolean)=>{if(typeof v!=='boolean')throw Error('Boolescher Einstellungswert fehlt.');return v;};
          if(!Array.isArray(imp.rules)||imp.rules.length<1||imp.rules.length>50)throw Error('Mindestens eine Regel (maximal 50) ist erforderlich.');
          const rules=imp.rules.map((r)=>{if(!isRecord(r)||typeof r.id!=='string'||!/^[a-z0-9_-]{1,40}$/u.test(r.id)||typeof r.name!=='string'||!r.name.trim()||r.name.length>60||typeof r.description!=='string'||r.description.trim().length<8||r.description.length>240||typeof r.enabled!=='boolean')throw Error('Regel ungültig: ID, Name, verständliche Beschreibung und Aktiv-Status prüfen.');return {id:r.id,name:r.name.trim(),description:r.description.trim(),enabled:r.enabled};});
          if(!rules.some(r=>r.enabled))throw Error('Mindestens eine Regel muss aktiviert bleiben.');
          const tieOutcome=imp.tieOutcome??current.imposter.tieOutcome;if(tieOutcome!=='imposter'&&tieOutcome!=='neutral')throw Error('Gleichstandsregel muss imposter oder neutral sein.');
          const settings:MiniGameSettings={enabled:bool(raw.enabled,current.enabled),imposter:{minPlayers:number(imp.minPlayers,current.imposter.minPlayers,3,20),maxPlayers:number(imp.maxPlayers,current.imposter.maxPlayers,4,100),registrationMs:number(imp.registrationMs,current.imposter.registrationMs,15_000,900_000),playMs:number(imp.playMs,current.imposter.playMs,30_000,900_000),votingMs:number(imp.votingMs,current.imposter.votingMs,10_000,300_000),cooldownMs:number(imp.cooldownMs,current.imposter.cooldownMs,0,86_400_000),allowVoteChange:bool(imp.allowVoteChange,current.imposter.allowVoteChange),noSelfVote:bool(imp.noSelfVote,current.imposter.noSelfVote),tieOutcome,winXp:number(imp.winXp,current.imposter.winXp,0,1000),participationXp:number(imp.participationXp,current.imposter.participationXp,0,1000),rules},detective:{roundMs:number(det.roundMs,current.detective.roundMs,10_000,300_000),quoteRetentionDays:number(det.quoteRetentionDays,current.detective.quoteRetentionDays,1,365),winXp:number(det.winXp,current.detective.winXp,0,1000),dailyXpCap:number(det.dailyXpCap,current.detective.dailyXpCap,0,10_000),allowGuessChange:bool(det.allowGuessChange,current.detective.allowGuessChange)}};
          if(settings.imposter.minPlayers>=settings.imposter.maxPlayers)throw Error('Die Höchstzahl muss über der Mindestzahl liegen.');
          this.miniGames.updateSettings(settings);this.audit(session,'minigames-settings-update','community-games',{enabled:settings.enabled,ruleCount:rules.length},now);this.json(res,200,{ok:true});return;
        }catch(error){this.json(res,400,{error:error instanceof Error?error.message:'Spielkonfiguration ungültig.'});return;}
      }
      if(action==='start-imposter')message=this.miniGames.startImposter(session.userId,now);
      else if(action==='close-imposter')message=this.miniGames.startRoles(session.userId,now);
      else if(action==='vote-imposter')message=this.miniGames.beginVote(now);
      else if(action==='start-detective')message=this.miniGames.startDetective(now);
      else if(action==='quote'&&(body.status==='approved'||body.status==='rejected')){
        const ok=this.miniGames.moderateQuote(String(body.id||''),body.status,now);if(!ok){this.json(res,409,{error:'Zitat nicht mehr wartend oder nicht gefunden.'});return;}
        this.audit(session,'quote-'+body.status,String(body.id||''),{},now);this.json(res,200,{ok:true});return;
      } else if(action==='quote'&&body.status==='deleted'){
        const id=String(body.id||'');if(!this.miniGames.removeQuote(id)){this.json(res,404,{error:'Zitat nicht gefunden.'});return;}
        this.audit(session,'quote-remove',id,{},now);this.json(res,200,{ok:true});return;
      } else {this.json(res,400,{error:'Spielaktion ungültig.'});return;}
      this.audit(session,'minigame-'+action,'community-games',{},now);this.json(res,200,{ok:true,message});return;
    }
    if(route==='channel-points/connect'){
      if(!this.channelPoints||!this.getChannelPointsConnectUrl){this.json(res,503,{error:'Kanalpunkte-OAuth ist nicht konfiguriert.'});return;}
      this.json(res,200,{url:this.getChannelPointsConnectUrl()});return;
    }
    if(route==='channel-points/settings'){
      if(!this.channelPoints){this.json(res,503,{error:'Kanalpunkte-Service ist nicht gestartet.'});return;}
      const current=this.channelPoints.settings(),enabled=body.enabled,fulfillOnApproval=body.fulfillOnApproval,cost=Number(body.cost);
      if(typeof enabled!=='boolean'||typeof fulfillOnApproval!=='boolean'||!Number.isSafeInteger(cost)||cost<1||cost>1_000_000){this.json(res,400,{error:'Kanalpunkte-Schalter oder Kosten ungültig.'});return;}
      try{
        await this.channelPoints.saveSettings({...current,enabled,fulfillOnApproval,cost});
        this.store.setConfig('quest_settings',{...this.store.config('quest_settings',defaultQuestSettings()),channelPointsEnabled:enabled});
        this.audit(session,'channel-points-settings','quest-reward',{enabled,cost,fulfillOnApproval},now);this.json(res,200,{ok:true});
      }catch(error){this.json(res,409,{error:error instanceof Error?error.message:'Kanalpunkte-Einstellungen konnten nicht gespeichert werden.'});}return;
    }
    if(route==='channel-points/reward'){
      if(!this.channelPoints){this.json(res,503,{error:'Kanalpunkte-Service ist nicht gestartet.'});return;}
      try{
        const reward=body.action==='create'?await this.channelPoints.createReward(Number(body.cost))
          :body.action==='select'?await this.channelPoints.selectReward(String(body.rewardId||'')):undefined;
        if(!reward){this.json(res,400,{error:'Reward-Aktion ungültig.'});return;}
        this.store.setConfig('quest_settings',{...this.store.config('quest_settings',defaultQuestSettings()),channelPointsEnabled:false});
        this.audit(session,body.action==='create'?'channel-points-reward-created':'channel-points-reward-selected',reward.id,{cost:reward.cost},now);
        this.json(res,200,{reward});
      }catch(error){this.json(res,409,{error:error instanceof Error?error.message:'Twitch-Belohnung konnte nicht verknüpft werden.'});}return;
    }
    if(route==='channel-points/retry'){
      if(!this.channelPoints){this.json(res,503,{error:'Kanalpunkte-Service ist nicht gestartet.'});return;}
      try{await this.channelPoints.retry(String(body.id||''));this.audit(session,'channel-points-retry',String(body.id||''),{},now);this.json(res,200,{ok:true});}
      catch(error){this.json(res,409,{error:error instanceof Error?error.message:'Redemption konnte nicht wiederholt werden.'});}return;
    }
    if (route === 'spark/settings') {
      try {
        const settings=normalizeSparkConfig(body,this.store.config<SparkConfig>('spark_settings',DEFAULT_SPARK_CONFIG));
        const topics=normalizeSparkTopics(body.topics);
        this.store.setConfig('spark_settings',settings); this.store.setConfig('spark_topics',topics);
        this.audit(session,'spark-settings-update','conversation-spark',{enabled:settings.enabled,topicCount:topics.length},now);
        this.json(res,200,{ok:true}); return;
      } catch(error) { this.json(res,400,{error:error instanceof Error?error.message:'Conversation-Spark-Einstellungen ungültig.'}); return; }
    }
    if (route === 'spark/action') {
      const id=String(body.id||''),action=String(body.action||''),proposal=this.store.sparkProposal(id);
      if (!proposal) { this.json(res,404,{error:'Vorschlag nicht gefunden.'}); return; }
      if (proposal.expiresAt<=now) { this.store.expireSparkProposals(now); this.json(res,409,{error:'Dieser Vorschlag ist abgelaufen.'}); return; }
      if (action==='approve'||action==='reject'||action==='cancel') {
        const status=action==='approve'?'approved':action==='reject'?'rejected':'canceled';
        if (!this.store.decideSparkProposal(id,status,session.userId,now,action==='reject'?clean(String(body.reason||''),160)||null:null)) {
          this.json(res,409,{error:'Der Vorschlag kann in seinem aktuellen Status nicht geändert werden.'}); return;
        }
        this.audit(session,`spark-${action}`,id,{},now); this.json(res,200,{ok:true}); return;
      }
      if (proposal.status!=='approved') { this.json(res,409,{error:'Bitte den Vorschlag zuerst ausdrücklich freigeben.'}); return; }
      if (action==='create-poll') {
        if (proposal.actionType!=='poll') { this.json(res,409,{error:'Dieser Vorschlag ist nicht als Umfrage vorgesehen.'}); return; }
        const modules=this.store.config<Record<string,boolean>>('modules',{}),pollSettings=this.store.config('poll_settings',defaultPollSettings());
        if (modules.polls===false||!pollSettings.enabled) { this.json(res,409,{error:'Umfragen sind deaktiviert.'}); return; }
        const question=normalizeCommunityText(String(body.question||''),3,180);
        const options=Array.isArray(body.options)?body.options.map(value=>normalizeCommunityText(String(value),1,80)):[];
        const seconds=Number(body.durationSeconds);
        if (!question||options.length<2||options.length>5||options.some(value=>!value)||new Set(options.map(value=>value!.toLowerCase())).size!==options.length
          ||!Number.isInteger(seconds)||seconds<10||seconds>3600) { this.json(res,400,{error:'Bitte eine Frage, 2–5 unterschiedliche Optionen und 10–3600 Sekunden angeben.'}); return; }
        const poll=this.store.createPoll({type:'chat',question,options:options.map(label=>({label:label!})),durationMs:seconds*1000,
          allowVoteChange:pollSettings.allowVoteChange,createdBy:session.userId,now});
        if (!poll) { this.json(res,409,{error:'Eine Umfrage läuft bereits oder konnte nicht erstellt werden.'}); return; }
        this.store.decideSparkProposal(id,'executed',session.userId,now); this.audit(session,'spark-create-poll',id,{pollId:poll.id},now);
        this.json(res,201,{poll}); return;
      }
      if (action==='create-quest') {
        if (proposal.actionType!=='quest') { this.json(res,409,{error:'Dieser Vorschlag ist nicht als Quest vorgesehen.'}); return; }
        const policy=this.questPolicy(),title=normalizeCommunityText(String(body.title||`Community-Quest zum Thema ${proposal.topicLabel}`),3,policy.maxLength);
        if (!title) { this.json(res,400,{error:'Quest-Titel ungültig.'}); return; }
        const quest=this.store.submitQuest({submitterUserId:session.userId,displayName:clean(session.login,48),title,source:'dashboard'},policy,now);
        if (!quest.ok) { this.json(res,409,{error:'Quest-Vorschlag konnte nicht angelegt werden: '+quest.reason}); return; }
        this.store.decideSparkProposal(id,'executed',session.userId,now); this.audit(session,'spark-create-quest',id,{questId:quest.quest.id},now);
        this.json(res,201,{quest:quest.quest}); return;
      }
      this.json(res,400,{error:'Spark-Aktion ungültig.'}); return;
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
        if(questSettings.channelPointsEnabled&&(!this.channelPoints?.connected()||!this.channelPoints.settings().rewardId))
          throw new Error('Kanalpunkte-Quests lassen sich erst über die Kanalpunkte-Verwaltung nach OAuth und Reward-Verknüpfung aktivieren.');
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
      if(status==='approved'||status==='rejected')await this.channelPoints?.resolveQuest(id,status);
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
      const type = body.type;
      if (type !== 'quest' && type !== 'poll') { this.json(res, 400, { error: 'Widget-Typ ist ungültig.' }); return; }
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

  private clearCookie(res: http.ServerResponse): void { res.setHeader('Set-Cookie', 'community_admin=; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=0'); }

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
function escapeHtml(value:string):string{return value.replace(/[&<>"']/gu,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c));}
function miniGameWidgetHtml(type:'imposter'|'detective',nonce:string,fontSize:number,theme:string):string{
  const size=Math.max(22,Math.min(54,Number.isInteger(fontSize)?fontSize:34)),accent=theme==='magenta'?'#ff65bd':'#b69cff';
  const title=type==='imposter'?'CHAT-IMPOSTER':'WER HAT DAS GESCHRIEBEN?';
  const publicBody=type==='detective'?'(g.phase===\'results\'||g.phase===\'finished\')?\'Das Zitat stammt von @\'+(g.result?.authorName||\'Unbekannt\')+\'! Richtige Tipps: \'+(g.result?.winners||[]).join(\', \'):g.text||\'\'':'(g.phase===\'results\'||g.phase===\'finished\')?(g.result?.neutral?\'Gleichstand – neutrale Runde. \':g.result?.caught?\'Imposter erkannt: \':\'Imposter gewinnt: \')+(g.result?.imposterName||\'Unbekannt\')+\' · Regel: \'+(g.result?.rule||\'–\'):(g.participants+\' Teilnehmende · \'+g.votes+\' Stimmen\')';
  const script=`const root=document.querySelector('main');async function update(){try{const d=await fetch('/widgets/api/${type}'+location.search,{cache:'no-store'}).then(r=>r.json()),g=d.game;if(!d.visible||!g){root.hidden=true;return}root.hidden=false;document.querySelector('#phase').textContent=g.phase==='registration'?'ANMELDUNG':g.phase==='playing'?'SPIEL LÄUFT':g.phase==='voting'?'ABSTIMMUNG':'AUFLÖSUNG';document.querySelector('#body').textContent=${publicBody};const left=Math.max(0,Math.ceil((g.endsAt-Date.now())/1000));document.querySelector('#time').textContent=left?left+'s':''}catch{}}update();setInterval(update,1000);`;
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:transparent;color:#f7f4ff;font:700 ${size}px system-ui;text-align:center}main{padding:20px;border-radius:18px;background:linear-gradient(120deg,#171923ed,#32233fed);border:2px solid ${accent};text-shadow:0 2px 8px #000}h1{font-size:.6em;letter-spacing:.08em;color:${accent};margin:0 0 12px}#body{font-size:.82em;overflow-wrap:anywhere}#phase,#time{font-size:.5em;color:#d1c5f1;margin:8px}</style><main hidden><h1>${title}</h1><div id="phase"></div><div id="body"></div><div id="time"></div></main><script nonce="${nonce}">${script}</script></html>`;
}
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

function normalizeSparkConfig(input:Record<string,unknown>,current:SparkConfig):SparkConfig {
  const number=(key:string,min:number,max:number):number=>{
    const value=Number(input[key]); if(!Number.isInteger(value)||value<min||value>max) throw new Error(`${key} muss zwischen ${min} und ${max} liegen.`); return value;
  };
  if (typeof input.enabled!=='boolean'||typeof input.paused!=='boolean'||typeof input.chatSuggestionsEnabled!=='boolean'||typeof input.pauseDuringPolls!=='boolean') {
    throw new Error('Spark-Schalter müssen boolesch sein.');
  }
  const allowedActionTypes=Array.isArray(input.allowedActionTypes)?input.allowedActionTypes.filter((v):v is SparkActionType=>v==='poll'||v==='quest'||v==='challenge'):[];
  if (!allowedActionTypes.length||allowedActionTypes.length!==new Set(allowedActionTypes).size) throw new Error('Mindestens ein eindeutiger Aktionstyp ist erforderlich.');
  return { enabled:input.enabled,paused:input.paused,chatSuggestionsEnabled:input.chatSuggestionsEnabled,pauseDuringPolls:input.pauseDuringPolls,
    windowMs:number('windowMinutes',1,60)*60_000,
    minParticipants:number('minParticipants',2,50),minMessages:number('minMessages',3,200),
    minScore:number('minScore',1,1000),globalCooldownMs:number('globalCooldownMinutes',1,1440)*60_000,
    topicCooldownMs:number('topicCooldownMinutes',1,10080)*60_000,
    proposalTtlMs:number('proposalTtlMinutes',1,1440)*60_000,
    maxPending:number('maxPending',1,50),metadataRetentionMs:current.metadataRetentionMs,allowedActionTypes};
}

function normalizeSparkTopics(input:unknown):SparkTopic[] {
  if (!Array.isArray(input)||input.length>50) throw new Error('Topic-Regeln müssen eine Liste mit höchstens 50 Einträgen sein.');
  const seen=new Set<string>();
  return input.map((value)=>{
    if(!isRecord(value)) throw new Error('Topic-Regel ungültig.');
    const id=String(value.id||'').trim().toLowerCase(),label=clean(String(value.label||''),64),actionType=value.actionType;
    const terms=Array.isArray(value.terms)?[...new Set(value.terms.filter((term):term is string=>typeof term==='string').map((term)=>clean(term,64).toLowerCase()).filter((term)=>term.length>=3))]:[];
    if(!/^[a-z0-9_-]{2,40}$/u.test(id)||seen.has(id)||!label||!['poll','quest','challenge'].includes(String(actionType))||!terms.length||terms.length>100)
      throw new Error('Topic-ID, Bezeichnung, Aktion oder Keywords ungültig.');
    seen.add(id); return {id,label,actionType:actionType as SparkActionType,terms};
  });
}

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
