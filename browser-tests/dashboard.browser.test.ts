import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { chromium } from 'playwright';
import { DashboardServer } from '../src/dashboard.js';
import { FeatureStore } from '../src/feature-store.js';
import { logger } from '../src/logger.js';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('Dashboard-Navigation, Teilansichten und Logout funktionieren im Browser', async () => {
  const env = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acy-dashboard-browser-'));
  const store = new FeatureStore(path.join(directory, 'bot.sqlite'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  process.env.TWITCH_CLIENT_ID = 'test-client';
  process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  process.env.DASHBOARD_REDIRECT_URI = 'https://bot.example.test/dashboard/oauth/callback';
  process.env.DASHBOARD_ADMIN_IDS = 'admin-id';
  process.env.DASHBOARD_HOST = '127.0.0.1';
  process.env.DASHBOARD_PORT = String(port);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'ephemeral-token' });
    if (url.endsWith('/oauth2/validate')) return Response.json({ client_id: 'test-client', user_id: 'admin-id', login: 'admin' });
    if (url.endsWith('/helix/users')) return Response.json({ data: [{ id: 'admin-id', login: 'admin', display_name: 'Admin' }] });
    throw new Error(`Unerwarteter externer Aufruf: ${url}`);
  };
  const dashboard = new DashboardServer(store, () => ({ twitchConnected: true, channel: 'acyjannik', startedAt: 1 }), logger, fetchImpl);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    assert.equal(await dashboard.start(), true);
    const login = await fetch(`${base}/dashboard/login`, { redirect: 'manual' });
    const state = new URL(login.headers.get('location') || '').searchParams.get('state') || '';
    const stateCookie = login.headers.get('set-cookie')?.split(';')[0] || '';
    const callback = await fetch(`${base}/dashboard/oauth/callback?code=test&state=${state}`, {
      headers: { Cookie: stateCookie }, redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    const sessionCookie = callback.headers.getSetCookie().find((value) => value.startsWith('community_admin='))?.split(';')[0] || '';
    assert.ok(sessionCookie, 'OAuth-Login muss eine Sitzung ausstellen');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'community_admin', value: sessionCookie.split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const assertSubpage = async (selector: string, active: boolean) => {
      const state = await page.locator(selector).evaluate((node) => ({ hidden: (node as HTMLElement).hidden, display: getComputedStyle(node).display, active: (node as HTMLElement).dataset.active === 'true' }));
      assert.equal(state.hidden, !active, `${selector} hidden-Flag`);
      assert.equal(state.display === 'block', active, `${selector} CSS-Anzeige`);
      assert.equal(state.active, active, `${selector} aktiver Zustand`);
    };

    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const view = (name: string) => page.locator(`[data-dashboard-view="${name}"]`);
    await view('overview').waitFor({ state: 'visible' });
    const navigate = async (name: string) => {
      await page.locator(`[data-view-target="${name}"]`).click();
      await page.waitForFunction((key) => document.querySelector(`[data-dashboard-view="${key}"]`)?.getAttribute('data-active') === 'true', name, { timeout: 2000 }).catch(async () => {
        assert.fail(`Ansicht ${name} wird nicht aktiviert; hash=${await page.evaluate(() => location.hash)}; pageErrors=${pageErrors.join(' | ')}`);
      });
      for (const other of ['overview', 'games', 'community', 'obs', 'settings']) {
        if (other !== name) assert.equal(await view(other).isVisible(), false, `${other} darf bei Ansicht ${name} nicht sichtbar sein`);
      }
    };
    for (const name of ['games', 'community', 'obs', 'settings', 'overview']) await navigate(name);

    await navigate('games');
    await page.getByRole('button', { name: /Chat-Imposter/u }).click();
    await assertSubpage('[data-game-page="imposter"]', true);
    await assertSubpage('[data-game-page="detective"]', false);
    await page.locator('[data-view-target="games"]').click();
    assert.equal(await page.locator('#game-catalog').isVisible(), true, 'erneuter Wechsel zu Spiele zeigt wieder den Katalog');
    await page.getByRole('button', { name: /Chat-Detektiv/u }).click();
    await assertSubpage('[data-game-page="detective"]', true);
    await assertSubpage('[data-game-page="imposter"]', false);

    await navigate('community');
    for (const name of ['events', 'xp', 'elio', 'quests', 'spark', 'welcome', 'music']) {
      await page.locator(`[data-community-target="${name}"]`).click();
      await assertSubpage(`[data-community-page="${name}"]`, true);
      for (const other of ['events', 'xp', 'elio', 'quests', 'spark', 'welcome', 'music']) {
        if (other !== name) await assertSubpage(`[data-community-page="${other}"]`, false);
      }
    }

    await navigate('settings');
    for (const name of ['messages', 'commands', 'advanced']) {
      await page.locator(`[data-setting-target="${name}"]`).click();
      await assertSubpage(`[data-setting-page="${name}"]`, true);
      for (const other of ['messages', 'commands', 'advanced']) {
        if (other !== name) await assertSubpage(`[data-setting-page="${other}"]`, false);
      }
    }

    const logoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/dashboard/api/logout');
    await page.locator('#logout').click();
    const logoutResult = await logoutResponse;
    assert.equal(logoutResult.status(), 200, 'Logout-API muss die Sitzung beenden');
    const logoutRequestHeaders = await logoutResult.request().allHeaders();
    assert.equal(logoutResult.request().method(), 'POST');
    assert.ok(logoutRequestHeaders['x-csrf-token'], 'Logout sendet CSRF-Token');
    assert.equal(logoutRequestHeaders.origin, base, 'Logout sendet Browser-Origin');
    await page.waitForURL((url) => url.hostname === 'id.twitch.tv' && url.pathname === '/oauth2/authorize', { waitUntil: 'commit', timeout: 5000 });
    assert.deepEqual(pageErrors, [], `Dashboard darf bei Navigation und Logout keine JavaScript-Ausnahmen werfen: ${pageErrors.join('; ')}`);
  } finally {
    await browser?.close();
    await dashboard.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  }
});
