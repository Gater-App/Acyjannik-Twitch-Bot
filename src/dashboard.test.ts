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
  const dashboard = new DashboardServer(store, () => ({ twitchConnected: true, channel: 'yannick', startedAt: 1 }), logger, fetchImpl);
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
    assert.match(cookies.find((value) => value.startsWith('community_admin=')) || '', /HttpOnly; Secure; SameSite=Strict/u);

    const page = await fetch(`${base}/dashboard`, { headers: { Cookie: sessionCookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assertInlineScriptsParse(html);
    const csrf = html.match(/name="csrf" content="([a-f0-9]+)"/u)?.[1] || '';
    assert.ok(csrf);
    assert.match(page.headers.get('content-security-policy') || '', /nonce-/u);
    assert.doesNotMatch(page.headers.get('content-security-policy') || '', /unsafe-inline/u);

    const sparkResponse = await fetch(`${base}/dashboard/api/spark`, { headers: { Cookie: sessionCookie } });
    assert.equal(sparkResponse.status, 200);
    const sparkData = await sparkResponse.json() as { settings: { enabled: boolean }; pending: number };
    assert.equal(sparkData.settings.enabled, false, 'Conversation Spark must default to disabled');
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
    const tokenData = await tokenResponse.json() as { url: string };
    const widgetToken = new URL(tokenData.url).searchParams.get('token') || '';
    assert.ok(widgetToken.length >= 40);
    const widgetBase = `${base}/widgets`;
    const widgetPage = await fetch(`${widgetBase}/quest?token=${widgetToken}`);
    assert.equal(widgetPage.status, 200);
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
