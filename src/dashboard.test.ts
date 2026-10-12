import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
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

test('Dashboard validiert Twitch-Identität, Allowlist, Session, CSRF und Admin-API', async () => {
  const env = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yannick-dashboard-'));
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
    const csrf = html.match(/name="csrf" content="([a-f0-9]+)"/u)?.[1] || '';
    assert.ok(csrf);
    assert.match(page.headers.get('content-security-policy') || '', /nonce-/u);
    assert.doesNotMatch(page.headers.get('content-security-policy') || '', /unsafe-inline/u);

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
    assert.equal(updateSettings.status, 200);
    assert.equal(store.config<Record<string, number>>('xp_settings', {}).levelBase, 200);
    const invalidSettings = await fetch(`${base}/dashboard/api/settings`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, game_settings: { ...settings.game_settings, guessMax: settings.game_settings.guessMin } }),
    });
    assert.equal(invalidSettings.status, 400);
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
