import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function assertInlineScriptsParse(html: string): void {
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/gu)];
  assert.ok(scripts.length > 0, 'Nonce-geschütztes Dashboard-/Widget-Script muss vorhanden sein');
  for (const [, source] of scripts) new vm.Script(source || '');
}

test('Dashboard validiert Twitch-Identität, Allowlist, Session, CSRF und Admin-API', async () => {
  const env = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jannik-dashboard-'));
  const store = new FeatureStore(path.join(directory, 'bot.sqlite'));
  const port = await freePort();
  process.env.TWITCH_CLIENT_ID = 'test-client'; process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  process.env.DASHBOARD_REDIRECT_URI = 'https://bot.example.test/dashboard/oauth/callback';
  process.env.DASHBOARD_ADMIN_IDS = 'admin-id'; process.env.DASHBOARD_HOST = '127.0.0.1'; process.env.DASHBOARD_PORT = String(port);
  let verifiedUserId = 'admin-id';
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'ephemeral-token' });
    if (url.endsWith('/oauth2/validate')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'OAuth ephemeral-token');
      return Response.json({ client_id: 'test-client', user_id: verifiedUserId, login: 'admin' });
    }
    if (url.endsWith('/helix/users')) return Response.json({ data: [{ id: verifiedUserId, login: 'admin', display_name: 'Admin' }] });
    throw new Error(`Unerwarteter externer Aufruf: ${url}`);
  };
  const dashboard = new DashboardServer(store, () => ({ twitchConnected: true, channel: 'acyjannik', startedAt: 1 }), logger, fetchImpl);
  try {
    assert.equal(await dashboard.start(), true);
    const base = `http://127.0.0.1:${port}`;
    const firstLogin = await fetch(`${base}/dashboard/login`, { redirect: 'manual' });
    const firstLocation = new URL(firstLogin.headers.get('location') || '');
    const firstState = firstLocation.searchParams.get('state') || '';
    const firstStateCookie = firstLogin.headers.get('set-cookie')?.split(';')[0] || '';
    const csrfAttempt = await fetch(`${base}/dashboard/oauth/callback?code=x&state=${firstState}`, { redirect: 'manual' });
    assert.equal(csrfAttempt.status, 400, 'OAuth-State muss an denselben Browser gebunden sein');

    verifiedUserId = 'intruder-id';
    const unauthorizedLogin = await fetch(`${base}/dashboard/login`, { redirect: 'manual' });
    const unauthorizedState = new URL(unauthorizedLogin.headers.get('location') || '').searchParams.get('state') || '';
    const unauthorizedCookie = unauthorizedLogin.headers.get('set-cookie')?.split(';')[0] || '';
    const unauthorized = await fetch(`${base}/dashboard/oauth/callback?code=x&state=${unauthorizedState}`, { headers: { Cookie: unauthorizedCookie }, redirect: 'manual' });
    assert.equal(unauthorized.status, 403);
    verifiedUserId = 'admin-id';

    const login = await fetch(`${base}/dashboard/login`, { redirect: 'manual' });
    const state = new URL(login.headers.get('location') || '').searchParams.get('state') || '';
    const stateCookie = login.headers.get('set-cookie')?.split(';')[0] || '';
    const callback = await fetch(`${base}/dashboard/oauth/callback?code=x&state=${state}`, {
      headers: { Cookie: stateCookie }, redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    const cookies = callback.headers.getSetCookie();
    const sessionCookie = cookies.find((value) => value.startsWith('community_admin='))?.split(';')[0] || '';
    assert.match(cookies.find((value) => value.startsWith('community_admin=')) || '', /HttpOnly; Secure; SameSite=Lax/u);

    const page = await fetch(`${base}/dashboard`, { headers: { Cookie: sessionCookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assertInlineScriptsParse(html);
    const csrf = html.match(/name="csrf" content="([a-f0-9]+)"/u)?.[1] || '';
    assert.ok(csrf);
    assert.match(page.headers.get('content-security-policy') || '', /nonce-/u);
    assert.doesNotMatch(page.headers.get('content-security-policy') || '', /unsafe-inline/u);
    assert.match(html,/Begrüßung neuer Chatter/u);
    assert.match(html,/Community-Aktionen/u);
    assert.match(html,/OBS: Widgets für den Stream/u);
    assert.match(html,/Schritt für Schritt in OBS einrichten/u);
    assert.match(html,/Teilnehmer-Link:/u);
    assert.match(html,/Twitch-Anmeldung für Mitspieler öffnen/u);
    assert.match(html,/!joinimposter/u);
    assert.match(html,/!sus @Name/u);
    assert.match(html,/!savequote Mein Zitat/u);
    assert.match(html,/Mindestteilnehmer für Imposter/u);
    assert.match(html,/Diskussion \(Minuten\)/u);
    assert.match(html,/Geheime Regeln für Mitspieler/u);
    assert.doesNotMatch(html,/id="mini-config"/u,'normale Minispiel-Einstellungen dürfen kein JSON-Textfeld zeigen');
    assert.match(html,/Nächster Phasenwechsel in/u,'geführter Imposter-Status zeigt den Countdown');
    assert.match(html,/Mindestzahl von/u,'Rollenverteilung bleibt gesperrt bis genug Mitspielende angemeldet sind');
    assert.match(html,/Chat-Nachrichten/u,'das Antwortverhalten ist im Dashboard auffindbar');
    for (const label of ['Übersicht','Spiele','Community','OBS','Chatbefehle','Einstellungen']) assert.match(html,new RegExp(label,'u'));
    assert.match(html,/<nav class="main-nav" aria-label="Hauptbereiche"><a href="#uebersicht">Übersicht<\/a><a href="#spiele">Spiele<\/a><a href="#community">Community<\/a><a href="#obs">OBS<\/a><\/nav>/u,'die Hauptnavigation bleibt auf vier Bereiche begrenzt');
    assert.match(html,/<nav class="secondary-nav" aria-label="Weitere Werkzeuge">[\s\S]*Chatbefehle[\s\S]*Weitere Einstellungen/u,'Chatbefehle und Einstellungen sind sekundär erreichbar');
    assert.match(html,/Community-Boss[\s\S]*hideCard\('Community-Boss'\)/u,'Boss-Feature wird in der normalen Oberfläche nur ausgeblendet');
    assert.match(html,/Chat-Umfrage[\s\S]*hideCard\('Chat-Umfrage'\)/u,'allgemeine Umfrage wird in der normalen Oberfläche nur ausgeblendet');
    assert.match(html,/Weitere Chatspiele[\s\S]*Experimentell[\s\S]*!8ball Frage[\s\S]*!duel @Name[\s\S]*!startguess[\s\S]*!rps schere/u,'experimentelle Chatspiele bleiben mit konkreten Befehlen auffindbar');
    assert.match(html,/Gemeinsame Vorschläge[\s\S]*Community-Quests[\s\S]*Gesprächs-Funken/u,'Quest- und Funkenvorschläge sind nach Herkunft gekennzeichnet');
    assert.match(html,/Saisonpunkte für Halloween, Weihnachten und Ostern sind davon getrennt/u,'Saisonpunkte werden klar von XP getrennt');
    assert.match(html,/Privater OBS-Link/u);
    assert.match(html,/Erweiterte Einstellungen/u);
    assert.match(html,/Für Fortgeschrittene: Erkennung einstellen/u);
    const runtimeStatus=await fetch(`${base}/dashboard/api/status`,{headers:{Cookie:sessionCookie}});
    const runtimeData=await runtimeStatus.json() as {dashboardResponding:boolean;chatReceive:string;botChatSend:string};
    assert.equal(runtimeData.dashboardResponding,true);
    assert.equal(runtimeData.chatReceive,'unknown','eine offene Verbindung darf nicht als Chat-Empfangsnachweis erscheinen');
    assert.equal(runtimeData.botChatSend,'unknown','Senden muss separat gemessen sein');
    const optionalChannelPoints=await fetch(`${base}/dashboard/api/channel-points`,{headers:{Cookie:sessionCookie}});
    assert.equal(optionalChannelPoints.status,200,'fehlende optionale Kanalpunkte-Integration soll keinen 405-Fehler erzeugen');
    const optionalChannelPointsData=await optionalChannelPoints.json() as {available:boolean;connected:boolean;message:string};
    assert.equal(optionalChannelPointsData.available,false);
    assert.equal(optionalChannelPointsData.connected,false);
    assert.match(optionalChannelPointsData.message,/nicht eingerichtet/u);
    const emptyWidgetStatus=await fetch(`${base}/dashboard/api/widgets/status`,{headers:{Cookie:sessionCookie}});
    assert.equal((await emptyWidgetStatus.json() as {widgets:Record<string,boolean>}).widgets.quest,false);
    const welcomeBefore=await fetch(`${base}/dashboard/api/welcome`,{headers:{Cookie:sessionCookie}});
    assert.equal((await welcomeBefore.json() as {enabled:boolean}).enabled,false);
    const welcomeSave=await fetch(`${base}/dashboard/api/welcome`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,message:'Willkommen, {user}!'})});
    assert.equal(welcomeSave.status,200);
    assert.equal((await (await fetch(`${base}/dashboard/api/welcome`,{headers:{Cookie:sessionCookie}})).json() as {enabled:boolean}).enabled,true);
    const chatSettingsBefore=await fetch(`${base}/dashboard/api/chat-messages`,{headers:{Cookie:sessionCookie}});
    assert.equal((await chatSettingsBefore.json() as {profile:string}).profile,'normal');
    const chatSettingsSave=await fetch(`${base}/dashboard/api/chat-messages`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({profile:'calm',welcomeBots:['StreamElements','nightbot']})});
    assert.equal(chatSettingsSave.status,200,await chatSettingsSave.clone().text());
    assert.deepEqual(store.config('chat_response_settings',{}),{profile:'calm',welcomeBots:['streamelements','nightbot']});
    const invalidChatSettings=await fetch(`${base}/dashboard/api/chat-messages`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({profile:'quiet',welcomeBots:[]})});
    assert.equal(invalidChatSettings.status,400,'unbekanntes Profil wird abgewiesen');

    store.setConfig('spark_settings',{enabled:false,paused:false,minParticipants:3});
    const sparkResponse = await fetch(`${base}/dashboard/api/spark`, { headers: { Cookie: sessionCookie } });
    assert.equal(sparkResponse.status, 200);
    const sparkData = await sparkResponse.json() as { settings: { enabled: boolean; allowedActionTypes:string[]; windowMs:number }; pending: number };
    assert.equal(sparkData.settings.enabled, false, 'Conversation Spark must default to disabled');
    assert.deepEqual(sparkData.settings.allowedActionTypes,['poll','quest','challenge'],'ältere SQLite-Einstellungen werden für die Oberfläche vervollständigt');
    assert.equal(sparkData.settings.windowMs,600_000);
    const sparkProposal = store.createSparkProposal({ id: 'dashboard-spark-test', channelId: 'channel-id', topicId: 'fortnite',
      topicLabel: 'Fortnite', score: 15, participants: 3, messages: 5, actionType: 'poll', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }, 5, 60_000, 120_000);
    assert.ok(sparkProposal);
    const sparkApprove = await fetch(`${base}/dashboard/api/spark/action`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sparkProposal.id, action: 'approve' }),
    });
    assert.equal(sparkApprove.status, 200, await sparkApprove.clone().text());
    const sparkPoll = await fetch(`${base}/dashboard/api/spark/action`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sparkProposal.id, action: 'create-poll', question: 'Welche Runde?', options: ['Ranked', 'Casual'], durationSeconds: 60 }),
    });
    assert.equal(sparkPoll.status, 201, await sparkPoll.clone().text());
    assert.equal(store.sparkProposal(sparkProposal.id)?.status, 'executed');

    const moduleChange = await fetch(`${base}/dashboard/api/modules`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'xp', enabled: false }),
    });
    assert.equal(moduleChange.status, 200);
    assert.equal(store.config<Record<string, boolean>>('modules', {}).xp, false);
    const settingsResponse = await fetch(`${base}/dashboard/api/settings`, { headers: { Cookie: sessionCookie } });
    const settings = await settingsResponse.json() as Record<string, any>;
    settings.xp_settings.levelBase = 200;
    settings.level_titles['2'] = 'Aufsteiger';
    const updateSettings = await fetch(`${base}/dashboard/api/settings`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    assert.equal(updateSettings.status, 200, await updateSettings.clone().text());
    assert.equal(store.config<Record<string, number>>('xp_settings', {}).levelBase, 200);
    assert.equal(store.config<Record<string, unknown>>('quest_settings', {}).maxLength, 180);
    assert.equal(store.config<Record<string, unknown>>('poll_settings', {}).durationMs, 60_000);

    const policy = { maxLength: 180, queueLimit: 20, maxOpenPerUser: 2, cooldownMs: 60_000, activeDurationMs: 0, completionXp: 25 };
    const quest = store.submitQuest({ submitterUserId: 'viewer-id', displayName: 'Viewer', title: 'Nächste Runde nur Pistolen', source: 'chat' }, policy, Date.now());
    assert.equal(quest.ok, true);
    if (!quest.ok) throw new Error('Widget-Testquest konnte nicht erstellt werden.');
    store.transitionQuest(quest.quest.id, 'approved', 'admin-id', Date.now(), policy);
    store.transitionQuest(quest.quest.id, 'active', 'admin-id', Date.now(), policy);
    const tokenResponse = await fetch(`${base}/dashboard/api/widgets/token`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'quest', action: 'rotate' }),
    });
    assert.equal(tokenResponse.status, 201);
    const configuredWidgetStatus=await fetch(`${base}/dashboard/api/widgets/status`,{headers:{Cookie:sessionCookie}});
    assert.equal((await configuredWidgetStatus.json() as {widgets:Record<string,boolean>}).widgets.quest,true);
    const tokenData = await tokenResponse.json() as { url: string };
    const widgetToken = new URL(tokenData.url).searchParams.get('token') || '';
    assert.ok(widgetToken.length >= 40);
    const widgetBase = `${base}/widgets`;
    const widgetPage = await fetch(`${widgetBase}/quest?token=${widgetToken}`);
    assert.equal(widgetPage.status, 200);
    await fetch(`${base}/dashboard`, { headers: { Cookie: sessionCookie } });
    assert.equal((await fetch(`${widgetBase}/quest?token=${widgetToken}`)).status, 200, 'Dashboard-Aufruf darf einen bestehenden OBS-Link nicht widerrufen');
    assert.match(widgetPage.headers.get('content-security-policy') || '', /connect-src 'self'/u);
    const widgetHtml = await widgetPage.text();
    assert.match(widgetHtml, /LIVE-QUEST/u);
    assertInlineScriptsParse(widgetHtml);
    const widgetSnapshotResponse = await fetch(`${widgetBase}/api/quest?token=${widgetToken}`);
    assert.equal(widgetSnapshotResponse.status, 200);
    const widgetSnapshot = await widgetSnapshotResponse.json() as { visible: boolean; quest: Record<string, unknown> };
    assert.equal(widgetSnapshot.visible, true);
    assert.equal(widgetSnapshot.quest.title, 'Nächste Runde nur Pistolen');
    assert.equal('submitterUserId' in widgetSnapshot.quest, false);
    assert.equal((await fetch(`${widgetBase}/api/poll?token=${widgetToken}`)).status, 404, 'Quest-Token darf kein Poll-Widget lesen');
    const streamController = new AbortController();
    const widgetStream = await fetch(`${widgetBase}/stream/quest?token=${widgetToken}`, { signal: streamController.signal });
    assert.equal(widgetStream.headers.get('content-type')?.startsWith('text/event-stream'), true);
    const widgetChunk = await widgetStream.body?.getReader().read();
    assert.match(new TextDecoder().decode(widgetChunk?.value), /snapshot/u, 'Widget-Neuverbindung bekommt sofort einen Snapshot');
    await streamController.abort();
    const tokenRevoke = await fetch(`${base}/dashboard/api/widgets/token`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'quest', action: 'revoke' }),
    });
    assert.equal(tokenRevoke.status, 200);
    assert.equal((await fetch(`${widgetBase}/api/quest?token=${widgetToken}`)).status, 404, 'widerrufene Widget-URL ist sofort ungültig');

    const disablePolls = await fetch(`${base}/dashboard/api/modules`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'polls', enabled: false }),
    });
    assert.equal(disablePolls.status, 200);
    const blockedPollStart = await fetch(`${base}/dashboard/api/polls`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Welche Option?', options: ['A', 'B'], durationSeconds: 60 }),
    });
    assert.equal(blockedPollStart.status, 409, 'deaktivierte Umfragen können auch im Dashboard nicht gestartet werden');

    const invalidSettings = await fetch(`${base}/dashboard/api/settings`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, game_settings: { ...settings.game_settings, guessMax: settings.game_settings.guessMin } }),
    });
    assert.equal(invalidSettings.status, 400);
    const channelPointsSettings = await fetch(`${base}/dashboard/api/settings`, { headers: { Cookie: sessionCookie } }).then((response) => response.json()) as Record<string, any>;
    channelPointsSettings.quest_settings.channelPointsEnabled = true;
    const unsupportedChannelPoints = await fetch(`${base}/dashboard/api/settings`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify(channelPointsSettings),
    });
    assert.equal(unsupportedChannelPoints.status, 400, 'nicht angebundene Kanalpunkte-Redemptions bleiben explizit deaktiviert');
    const badCsrf = await fetch(`${base}/dashboard/api/modules`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'xp', enabled: true }),
    });
    assert.equal(badCsrf.status, 403);
    const blocked = await fetch(`${base}/dashboard/api/overview`);
    assert.equal(blocked.status, 401);

    store.recordCommunityEvent('overlay.test', { label: 'structured event' }, Date.now());
    const controller = new AbortController();
    const stream = await fetch(`${base}/dashboard/api/stream?after=0`, { headers: { Cookie: sessionCookie }, signal: controller.signal });
    assert.equal(stream.headers.get('content-type')?.startsWith('text/event-stream'), true);
    const reader = stream.body?.getReader();
    const firstChunk = await reader?.read();
    assert.match(new TextDecoder().decode(firstChunk?.value), /overlay\.test/u);
    await controller.abort();

    const logout = await fetch(`${base}/dashboard/api/logout`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${base}/dashboard/api/overview`, { headers: { Cookie: sessionCookie } });
    assert.equal(afterLogout.status, 401);
    assert.ok(firstStateCookie.startsWith('dashboard_oauth_state='));

  } finally {
    await dashboard.stop(); store.close(); fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  }
});
