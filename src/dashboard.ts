import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { FeatureStore, type CustomCommand, type SeasonalEvent } from './feature-store.js';
import type { Logger } from './logger.js';

interface Session { userId: string; login: string; csrf: string; expiresAt: number; }
interface RuntimeStatus { twitchConnected: boolean; channel: string; startedAt: number; lastError?: string; }
interface TokenValidation { client_id: string; user_id: string; login: string; }
interface HelixUser { id: string; login: string; display_name: string; }

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf" content="__CSRF__"><title>Community Bot · Admin</title><style nonce="__NONCE__">
:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#11131b;color:#eef0f8}body{margin:0;background:radial-gradient(ellipse at top right,#30234a 0,transparent 35%),#11131b}main{max-width:1100px;margin:auto;padding:28px 20px}h1{margin:0 0 8px}p{color:#aeb2c3}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:20px 0}.card{background:#1b1e29;border:1px solid #333746;border-radius:14px;padding:18px}.accent{color:#c0a0ff}input,select,textarea,button{font:inherit;color:inherit;background:#10121a;border:1px solid #44495d;border-radius:8px;padding:10px;max-width:100%;box-sizing:border-box}textarea{width:100%;min-height:70px}button{background:#7652bd;border:0;cursor:pointer;margin:4px 2px}button:hover{background:#8d6bd1}label{display:block;margin:9px 0;color:#c7cad6}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#cbd0e0}form{display:grid;gap:8px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.muted{color:#979caf;font-size:.9rem}#notice{min-height:1.4rem;color:#ffc987}@media(max-width:520px){main{padding:18px 12px}.card{padding:14px}}
</style></head><body><main><div class="row"><div><h1>Community Bot <span class="accent">Admin</span></h1><p id="who">Geschützte Verwaltung</p></div><button id="logout">Abmelden</button></div><p id="notice" role="status"></p><section class="grid"><article class="card"><h2>Übersicht</h2><pre id="overview">Lade Status …</pre></article><article class="card"><h2>Module</h2><div id="modules"></div></article><article class="card"><h2>Saison-Events</h2><div id="events"></div><form id="event-form"><input name="id" placeholder="ID, z. B. summer" required pattern="[a-z0-9_-]{2,40}"><input name="name" placeholder="Name" required><input name="emoji" placeholder="Emoji" value="✨"><input name="command" placeholder="Befehl, z. B. summerhunt" required><input name="currency" placeholder="Punktewährung" required><input name="cooldownMs" type="number" min="0" value="900000"><button>Event anlegen/aktualisieren</button></form></article><article class="card"><h2>XP-Korrektur</h2><form id="xp-form"><input name="userId" placeholder="Twitch User-ID" required><input name="amount" type="number" placeholder="XP + / -" required><input name="reason" placeholder="Begründung" required maxlength="200"><button>Korrektur protokollieren</button></form><p class="muted">Korrekturen sind begrenzt und werden auditiert.</p></article><article class="card"><h2>Chatbefehle</h2><pre id="commands"></pre><form id="command-form"><input name="name" placeholder="Befehlsname" required><textarea name="response" placeholder="Antwort; Platzhalter: {user}, {channel}, {game}, {uptime}" required></textarea><select name="permission"><option value="everyone">Alle</option><option value="moderator">Moderatoren</option><option value="broadcaster">Broadcaster</option></select><input name="cooldownMs" type="number" min="0" value="10000"><button>Befehl speichern</button></form></article><article class="card"><h2>Nutzer</h2><form id="users-form"><input name="q" placeholder="Name oder ID suchen"><button>Suchen</button></form><pre id="users"></pre></article></section></main><script nonce="__NONCE__">
const csrf=document.querySelector('meta[name=csrf]').content,notice=document.querySelector('#notice');async function api(path,method='GET',data){const r=await fetch('/dashboard/api/'+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(data?{body:JSON.stringify(data)}:{})});const d=await r.json().catch(()=>({error:'Ungültige Serverantwort'}));if(!r.ok)throw Error(d.error||'Anfrage fehlgeschlagen');return d}function show(text){notice.textContent=text;setTimeout(()=>notice.textContent='',5000)}async function refresh(){try{const d=await api('overview');document.querySelector('#who').textContent='Angemeldet als '+d.admin.login;document.querySelector('#overview').textContent=JSON.stringify(d.status,null,2);const mods=document.querySelector('#modules');mods.replaceChildren();for(const [key,on] of Object.entries(d.status.modules||{})){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=Boolean(on);box.addEventListener('change',async()=>{try{await api('modules','POST',{key,enabled:box.checked});show('Modul gespeichert.')}catch(e){box.checked=!box.checked;show(e.message)}});label.append(box,' '+key);mods.append(label)}const ev=await api('events');const box=document.querySelector('#events');box.replaceChildren();for(const event of ev.events){const line=document.createElement('div'),text=document.createElement('span');text.textContent=event.emoji+' '+event.name+' · '+(event.active?'aktiv':'inaktiv')+' ';line.append(text);const b=document.createElement('button');b.textContent=event.active?'Beenden':'Starten';b.onclick=async()=>{try{await api('events','POST',{id:event.id,active:!event.active});show('Eventstatus gespeichert.');refresh()}catch(e){show(e.message)}};line.append(b);box.append(line)}const c=await api('commands');document.querySelector('#commands').textContent=JSON.stringify(c.commands,null,2)}catch(e){show(e.message)}}document.querySelector('#event-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownMs);try{await api('events','POST',v);show('Event gespeichert.');e.currentTarget.reset();refresh()}catch(x){show(x.message)}};document.querySelector('#xp-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.amount=Number(v.amount);try{await api('xp-adjust','POST',v);show('XP-Korrektur protokolliert.');e.currentTarget.reset()}catch(x){show(x.message)}};document.querySelector('#command-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.cooldownMs=Number(v.cooldownMs);try{await api('commands','POST',v);show('Chatbefehl gespeichert.');refresh()}catch(x){show(x.message)}};document.querySelector('#users-form').onsubmit=async e=>{e.preventDefault();const v=new FormData(e.currentTarget);try{const u=await api('users?q='+encodeURIComponent(v.get('q')||''));document.querySelector('#users').textContent=JSON.stringify(u.users,null,2)}catch(x){show(x.message)}};document.querySelector('#logout').onclick=async()=>{try{await api('logout','POST',{});location.reload()}catch(e){show(e.message)}};refresh();setInterval(refresh,15000);
</script></body></html>`;

const SETTINGS_CARD = `<article class="card"><h2>XP, Spiele & Eventregeln</h2><p class="muted">Erweiterte Werte als JSON bearbeiten. Änderungen werden geprüft und protokolliert.</p><form id="settings-form"><textarea id="settings-json" rows="14" spellcheck="false" aria-label="Bot-Einstellungen als JSON"></textarea><button>Einstellungen speichern</button></form></article><article class="card"><h2>Community-Boss</h2><form id="boss-form"><input name="name" placeholder="Bossname" value="Schattenkönig"><input name="hp" type="number" min="1" value="1000"><input name="durationMs" type="number" min="60000" value="900000"><button>Bosskampf starten</button></form><button id="boss-end">Bosskampf beenden</button></article><article class="card"><h2>Eigene Chatbefehle verwalten</h2><div id="command-manager"></div></article>`;
const SETTINGS_SCRIPT = `api('settings').then(s=>document.querySelector('#settings-json').value=JSON.stringify(s,null,2)).catch(e=>show(e.message));document.querySelector('#settings-form').onsubmit=async e=>{e.preventDefault();try{const value=JSON.parse(document.querySelector('#settings-json').value);await api('settings','POST',value);show('Einstellungen gespeichert.')}catch(x){show(x.message)}};document.querySelector('#boss-form').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.hp=Number(v.hp);v.durationMs=Number(v.durationMs);try{await api('boss','POST',v);show('Bosskampf gestartet.');refresh()}catch(x){show(x.message)}};document.querySelector('#boss-end').onclick=async()=>{try{await api('boss','POST',{action:'end'});show('Bosskampf beendet.');refresh()}catch(x){show(x.message)}};async function renderCommandAdmin(){try{const c=await api('commands'),root=document.querySelector('#command-manager');root.replaceChildren();for(const command of c.commands){const row=document.createElement('div'),name=document.createElement('span');name.textContent='!'+command.name+(command.alias?' ('+command.alias+')':'')+' · '+(command.enabled?'aktiv':'inaktiv')+' ';row.append(name);const edit=document.createElement('button');edit.textContent='Bearbeiten';edit.onclick=()=>{const f=document.querySelector('#command-form');f.elements.namedItem('name').value=command.name;f.elements.namedItem('response').value=command.response;f.elements.namedItem('permission').value=command.permission;f.elements.namedItem('cooldownMs').value=command.cooldownMs;f.scrollIntoView({behavior:'smooth',block:'center'})};row.append(edit);const toggle=document.createElement('button');toggle.textContent=command.enabled?'Deaktivieren':'Aktivieren';toggle.onclick=async()=>{try{await api('commands','POST',{...command,enabled:!command.enabled});show('Chatbefehl geändert.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(toggle);const del=document.createElement('button');del.textContent='Löschen';del.onclick=async()=>{try{await api('commands/delete','POST',{name:command.name});show('Chatbefehl gelöscht.');renderCommandAdmin()}catch(x){show(x.message)}};row.append(del);root.append(row)}}catch(x){show(x.message)}}renderCommandAdmin();setInterval(renderCommandAdmin,15000);`;

export class DashboardServer {
  private server: http.Server | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly states = new Map<string, number>();
  private readonly rates = new Map<string, { count: number; resets: number }>();
  private readonly eventStreams = new Map<http.ServerResponse, NodeJS.Timeout>();
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
      const page = PAGE.replace('</section></main>', `${SETTINGS_CARD}</section></main>`).replace('</script>', `${SETTINGS_SCRIPT}</script>`);
      res.end(page.replaceAll('__CSRF__', session.csrf).replaceAll('__NONCE__', nonce)); return;
    }
    if (url.pathname.startsWith('/dashboard/api/')) {
      const session = this.authenticate(req, res, true); if (!session) return;
      if (req.method !== 'GET' && !this.checkCsrf(req, session)) { this.json(res, 403, { error: 'CSRF-Prüfung fehlgeschlagen.' }); return; }
      await this.api(url, req, res, session); return;
    }
    if (url.pathname === '/healthz' && req.method === 'GET') { this.json(res, 200, { ok: true }); return; }
    this.json(res, 404, { error: 'Nicht gefunden.' });
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
      `community_admin=${key}; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
    ]);
    res.statusCode = 303; res.setHeader('Location', '/dashboard'); res.end();
  }

  private async api(url: URL, req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
    const route = url.pathname.slice('/dashboard/api/'.length);
    if (route === 'overview' && req.method === 'GET') { this.json(res, 200, { admin: { login: session.login }, status: { ...this.store.overview(), ...this.getStatus() } }); return; }
    if (route === 'events' && req.method === 'GET') { this.json(res, 200, { events: this.store.events() }); return; }
    if (route === 'settings' && req.method === 'GET') {
      this.json(res, 200, { xp_settings: this.store.config('xp_settings', {}), game_settings: this.store.config('game_settings', {}),
        '8ball_answers': this.store.config('8ball_answers', []), level_titles: this.store.config('level_titles', {}), events: this.store.events() }); return;
    }
    if (route === 'commands' && req.method === 'GET') { this.json(res, 200, { commands: this.store.customCommands() }); return; }
    if (route === 'users' && req.method === 'GET') { this.json(res, 200, { users: this.store.users((url.searchParams.get('q') || '').slice(0, 80), 50) }); return; }
    if (route === 'stream' && req.method === 'GET') { this.openEventStream(url, req, res); return; }
    if (req.method !== 'POST') { this.json(res, 405, { error: 'Methode nicht erlaubt.' }); return; }
    const body = await this.readJson(req); if (!body) { this.json(res, 400, { error: 'Ungültiger JSON-Body.' }); return; }
    const now = Date.now();
    if (route === 'modules') {
      const key = String(body.key || ''); const enabled = body.enabled;
      const allowed = new Set(['xp','events','eightBall','rps','guess','duels','boss','customCommands']);
      if (!allowed.has(key) || typeof enabled !== 'boolean') { this.json(res, 400, { error: 'Modul-Eingabe ungültig.' }); return; }
      const modules = this.store.config<Record<string, boolean>>('modules', {}); modules[key] = enabled; this.store.setConfig('modules', modules);
      this.audit(session, 'module-toggle', key, { enabled }, now); this.json(res, 200, { ok: true }); return;
    }
    if (route === 'settings') {
      try {
        const expected = new Set(['xp_settings','game_settings','8ball_answers','level_titles','events']);
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
        this.store.saveEvents(events);
        this.store.setConfig('xp_settings', xp); this.store.setConfig('game_settings', game);
        this.store.setConfig('8ball_answers', body['8ball_answers']); this.store.setConfig('level_titles', body.level_titles);
        this.audit(session, 'settings-update', 'bot', { eventCount: events.length }, now); this.json(res, 200, { ok: true }); return;
      } catch (error) { this.json(res, 400, { error: error instanceof Error ? error.message : 'Einstellungen ungültig.' }); return; }
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
function boundedInt(value: unknown, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function numberOrNull(value: unknown, fallback: number | null): number | null { if (value === undefined || value === null || value === '') return fallback; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

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
