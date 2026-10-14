import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { chromium } from 'playwright';
import { DashboardServer } from '../src/dashboard.js';
import { FeatureStore } from '../src/feature-store.js';
import { CommunityArcade } from '../src/community-arcade.js';
import { MiniGames } from '../src/mini-games.js';
import { testConfig } from '../src/test-config.js';
import { logger } from '../src/logger.js';
import { CommunityFeatures } from '../src/community-features.js';
import { ViewerCommunityPortal } from '../src/community-portal.js';

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
  store.awardXp('browser-ux-seed', 'viewer-42', 'Testviewer', 250, 'Browser-Testkonto', Date.now());
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
  const arcade = new CommunityArcade(store, 'channel-1');
  const miniGames = new MiniGames(store, testConfig());
  const communityFeatures = new CommunityFeatures(store, testConfig());
  const portal = new ViewerCommunityPortal(store, communityFeatures, testConfig(), fetchImpl);
  const dashboard = new DashboardServer(store, () => ({ twitchConnected: true, channel: 'acyjannik', startedAt: 1 }), logger, fetchImpl, undefined, undefined, undefined, miniGames, arcade, undefined, undefined, undefined, undefined, undefined, portal);
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
    const apiResponses: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.message} at ${error.stack}`));
    page.on('response', (response) => { if (new URL(response.url()).pathname.startsWith('/dashboard/api/')) apiResponses.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const assertSubpage = async (selector: string, active: boolean) => {
      const state = await page.locator(selector).evaluate((node) => ({ hidden: (node as HTMLElement).hidden, display: getComputedStyle(node).display, active: (node as HTMLElement).dataset.active === 'true' }));
      assert.equal(state.hidden, !active, `${selector} hidden-Flag`);
      assert.equal(state.display === 'block', active, `${selector} CSS-Anzeige`);
      assert.equal(state.active, active, `${selector} aktiver Zustand`);
    };

    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const view = (name: string) => page.locator(`[data-dashboard-view="${name}"]`);
    await view('overview').waitFor({ state: 'visible' });
    const ux50ScreenshotDir = process.env.DASHBOARD_UX50_SCREENSHOT_DIR;
    const screenshot = async (name: string) => {
      if (!ux50ScreenshotDir) return;
      fs.mkdirSync(ux50ScreenshotDir, { recursive: true });
      await page.screenshot({ path: path.join(ux50ScreenshotDir, `${name}.png`), fullPage: true });
    };
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.getByRole('link', { name: 'Streamer-Steuerung öffnen' }).getAttribute('href'), '/streamer');
    assert.equal(await page.getByRole('link', { name: 'Öffentliches Community-Portal öffnen' }).getAttribute('href'), '/community');
    assert.match((await page.locator('.main-nav [aria-current="page"]').innerText()).replace(/\s+/gu, ' '), /Übersicht/u);
    await screenshot('acy-ux50-desktop-overview');
    const navigate = async (name: string) => {
      await page.locator(`[data-view-target="${name}"]`).click();
      await page.waitForFunction((key) => document.querySelector(`[data-dashboard-view="${key}"]`)?.getAttribute('data-active') === 'true', name, { timeout: 2000 }).catch(async () => {
        assert.fail(`Ansicht ${name} wird nicht aktiviert; hash=${await page.evaluate(() => location.hash)}; pageErrors=${pageErrors.join(' | ')}`);
      });
      for (const other of ['overview', 'games', 'community', 'obs', 'settings']) {
        if (other !== name) assert.equal(await view(other).isVisible(), false, `${other} darf bei Ansicht ${name} nicht sichtbar sein`);
      }
    };
    for (const name of ['games', 'community', 'obs', 'settings', 'overview']) {
      await navigate(name);
      await screenshot(`acy-ux50-desktop-${name}`);
    }

    await navigate('games');
    await page.getByRole('button', { name: /Chat-Imposter/u }).click();
    await assertSubpage('[data-game-page="imposter"]', true);
    assert.match(await page.locator('[data-game-page="imposter"] .subpage-guide').innerText(), /Zuschauer melden sich mit !joinimposter an/u);
    assert.equal(await page.locator('#game-catalog').isVisible(), false, 'Detailseite blendet den Spielekatalog aus');
    await screenshot('acy-ux50-desktop-game-imposter');
    await assertSubpage('[data-game-page="detective"]', false);
    await page.locator('[data-game-page="imposter"] .subpage-back').click();
    assert.equal(await page.locator('#game-catalog').isVisible(), true, 'Zurück zu Alle Spiele zeigt wieder den Katalog');
    await page.getByRole('button', { name: /Chat-Imposter/u }).click();
    await assertSubpage('[data-game-page="imposter"]', true);
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
    await page.locator('[data-community-target="elio"]').click();
    assert.match(await page.locator('[data-community-page="elio"] .subpage-guide').innerText(), /Status zeigt Lebensphase/u);
    await screenshot('acy-ux50-desktop-community-elio');
    await page.locator('[data-community-page="elio"] .subpage-back').click();
    await assertSubpage('[data-community-page="events"]', true);
    await page.locator('[data-community-target="elio"]').click();
    const elioStatus = page.locator('#pet-status');
    await elioStatus.getByText(/Elio.*Level.*Hunger.*Energie.*Zufriedenheit/u).waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
      assert.fail(`Elio-Status fehlt: ${JSON.stringify(await page.evaluate(() => ({ petStatus: document.querySelector('#pet-status')?.textContent, arcadeState: document.querySelector('#arcade-state')?.textContent, arcadeCard: document.querySelector('#dashboard-community')?.textContent, arcadeCount: document.querySelectorAll('#arcade-state').length, arcadeButtonCount: document.querySelectorAll('#arcade-drop').length, arcadeLoad: typeof (window as unknown as {arcadeLoad?:unknown}).arcadeLoad, inlineHasArcade: [...document.scripts].some(s=>s.textContent.includes('arcadeLoad')) })))}, pageErrors=${pageErrors.join(' | ')}, api=${apiResponses.join(', ')}`);
    });
    assert.match(await elioStatus.innerText(), /Kätzchen/u, 'Elio zeigt seine Lebensphase');
    const screenshotDir = process.env.DASHBOARD_SCREENSHOT_DIR;
    if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: path.join(screenshotDir, 'acy-dashboard-elio.png'), fullPage: true }); }
    await page.locator('[data-community-target="music"]').click();
    await assertSubpage('[data-community-page="music"]', true);
    assert.equal(await page.locator('#sr-setup').isVisible(), true, 'Song-Setup ist bei fehlenden Verbindungen sichtbar');
    assert.equal(await page.locator('#sr-manage').isVisible(), false, 'Verwaltung erscheint erst nach vollständiger Einrichtung');
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'acy-dashboard-song-setup.png'), fullPage: true });
    await page.locator('#sr-playlist-select').click();
    assert.equal(await page.locator('#sr-error').isVisible(), true, 'fehlende Playlist-Auswahl zeigt eine verständliche Validierung');
    let songEnabled = false;
    const songRequest = { createdAt: 1_797_000_000_000, displayName: 'Viewer', status: 'added', userInput: 'Daft Punk - One More Time', trackName: 'One More Time', trackArtist: 'Daft Punk', lastError: null };
    await page.route('**/dashboard/api/song-requests**', async (route) => {
      if (route.request().method() === 'POST') songEnabled = Boolean((route.request().postDataJSON() as { enabled?: boolean }).enabled);
      await route.fulfill({ json: { available: true, settings: { enabled: songEnabled, rewardId: 'mock-reward', rewardTitle: '🎵 Song wünschen', cost: 1000, playlistId: 'mock-playlist', playlistName: 'Stream-Songs' }, spotifyConnected: true, broadcasterConnected: true, message: 'Einrichtung vollständig.', requests: [songRequest] } });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await navigate('community');
    await page.locator('[data-community-target="music"]').click();
    await page.locator('#sr-enable').click();
    await page.waitForFunction(() => document.querySelector('[data-sr-step="enable"]')?.getAttribute('data-state') === 'done', undefined, { timeout: 3000 });
    assert.equal(await page.locator('#sr-setup').isVisible(), false, `abgeschlossene Einrichtung wird nach Aktivierung ausgeblendet: enabled=${songEnabled} state=${JSON.stringify(await page.evaluate(()=>({setupHidden:(document.querySelector('#sr-setup') as HTMLElement).hidden,steps:[...document.querySelectorAll('[data-sr-step]')].map(x=>(x as HTMLElement).dataset.state),manageHidden:(document.querySelector('#sr-manage') as HTMLElement).hidden})))} status=${await page.locator('#sr-status').innerText()} error=${await page.locator('#sr-error').innerText()} api=${apiResponses.filter(x=>x.includes('song-requests')).join(',')}`);
    assert.equal(await page.locator('#sr-manage').isVisible(), true, 'Verwaltung wird nach Einrichtung angezeigt');
    assert.doesNotMatch(await page.locator('#sr-manage').innerText(), /mock-reward|mock-playlist/u, 'technische Twitch-/Spotify-IDs werden nicht angezeigt');
    await page.locator('#sr-requests').getByText(/One More Time/u).first().waitFor({ state: 'visible' });
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'acy-dashboard-song-management.png'), fullPage: true });
    await page.locator('#sr-manage-connections').click();
    assert.equal(await page.locator('#sr-setup').isVisible(), true, 'Verbindungen lassen sich aus der Verwaltung heraus ändern');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await navigate('community');
    await page.locator('[data-community-target="music"]').click();
    assert.equal(await page.locator('#sr-manage').isVisible(), true, 'aktivierter Status bleibt nach Neuladen sichtbar');
    assert.equal(await page.locator('#sr-setup').isVisible(), false, 'Einrichtungsfelder bleiben nach Neuladen verborgen');

    await navigate('settings');
    assert.equal(await page.locator('#automatic-chat-form label[name="custom"]').isVisible(), false, 'optionales Intervallfeld bleibt verborgen, bis „Eigenes Intervall“ gewählt wird');
    assert.equal(await page.locator('[data-setting-target="general"]').count(), 0, 'leere Allgemein-Seite wurde aus der Navigation entfernt');
    for (const name of ['messages', 'commands', 'functions', 'integrations', 'moderation', 'diagnostics']) {
      await page.locator(`[data-setting-target="${name}"]`).click();
      await assertSubpage(`[data-setting-page="${name}"]`, true);
      const settingText = (await page.locator(`[data-setting-page="${name}"]`).innerText()).trim();
      assert.ok(settingText.length > 20, `${name} zeigt zugehörige Einstellungen und bleibt keine leere Seite: ${settingText.slice(0, 180)}`);
      if (name === 'diagnostics') {
        assert.equal(await page.locator('#settings-json').isVisible(), false, 'rohe JSON-Konfiguration erscheint nicht in den normalen Einstellungen');
        assert.equal(await page.locator('#settings-json').evaluate((node) => node.closest('details')?.open), false, 'technische Konfiguration bleibt geschlossen');
      }
      if (name === 'commands') assert.doesNotMatch(settingText, /Millisekunden|\bms\b/u, 'Chatbefehle zeigen keine Millisekundenwerte');
      if (name === 'moderation') {
        await page.getByLabel('Twitch-Name', { exact: true }).fill('testviewer');
        await page.getByRole('button', { name: 'Twitch-Konto suchen' }).click();
        await page.getByRole('button', { name: 'Für Korrektur auswählen' }).click();
        assert.match(await page.locator('#xp-user-selected').innerText(), /Testviewer.*250 XP/u, 'Zuschauerwahl zeigt den Namen und den aktuellen XP-Stand');
        assert.equal(await page.locator('#xp-form [name="userId"]').isVisible(), false, 'interne Twitch-ID bleibt aus dem normalen Formular verborgen');
        assert.equal(await page.locator('#xp-form [name="userId"]').inputValue(), 'viewer-42', 'Ausgewähltes Konto wird intern korrekt zugeordnet');
      }
      if(name==='messages')assert.equal(await page.getByText('Community-Portal gelegentlich im Chat vorstellen').isVisible(),true,'Portal-Tipp ist über den verständlichen Schalter erreichbar');
      if (name === 'integrations') {
        assert.match(settingText, /nicht eingerichtet/u, 'Fehlende optionale Kanalpunkte-Anbindung wird erklärt statt die Seite leer zu lassen');
        assert.equal(await page.locator('[data-integration-empty]').isVisible(), true, 'nicht eingerichtete Verbindung wird als klarer Status angezeigt');
        assert.doesNotMatch(settingText, /Reward-ID|rewardId|\bID:/u, 'Kanalpunkte-Oberfläche zeigt keine technischen Reward-IDs');
      }
      for (const other of ['messages', 'commands', 'functions', 'integrations', 'moderation', 'diagnostics']) {
        if (other !== name) await assertSubpage(`[data-setting-page="${other}"]`, false);
      }
      await screenshot(`acy-ux50-desktop-settings-${name}`);
    }
    await page.evaluate(() => { location.hash = '#einstellungen/general'; });
    await assertSubpage('[data-setting-page="diagnostics"]', true);

    await navigate('community');
    await page.locator('[data-community-target="spark"]').click();
    assert.equal(await page.locator('#spark-settings textarea').count(), 0, 'eigene Themen werden ohne JSON-Editor verwaltet');
    await page.getByText('Erkennung und eigene Themen einstellen').click();
    assert.equal(await page.getByRole('button', { name: 'Thema hinzufügen' }).isVisible(), true, 'eigene Gesprächsthemen können verständlich ergänzt werden');
    await page.getByRole('button', { name: 'Thema hinzufügen' }).click();
    const newTopic = page.locator('.spark-topic').last();
    await newTopic.getByLabel('Thema', { exact: true }).fill('Browser-Testthema');
    await newTopic.getByLabel('Erkennungsbegriffe (durch Kommas trennen)', { exact: true }).fill('browser test, ux prüfung');
    await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
    await page.getByText('Einstellungen und Themen gespeichert.').waitFor({ state: 'visible' });
    const savedSpark = await page.evaluate(async () => (await (await fetch('/dashboard/api/spark')).json()).customTopics);
    assert.ok(savedSpark.some((topic: { label: string }) => topic.label === 'Browser-Testthema'), 'Themenformular speichert eigene Themen dauerhaft über die API');
    await screenshot('acy-ux50-desktop-community-spark');

    // Check the primary navigation and page width at tablet and iPhone sizes.
    for (const [label, width, height] of [['tablet', 768, 1024], ['iphone', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const name of ['overview', 'games', 'community', 'obs', 'settings']) {
        await navigate(name);
        assert.ok(await view(name).isVisible(), `${name} bleibt bei ${label} sichtbar`);
        const widthCheck = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll('body *')].map((node) => ({ tag: node.tagName, id: (node as HTMLElement).id, className: typeof (node as HTMLElement).className === 'string' ? (node as HTMLElement).className : '', right: Math.round(node.getBoundingClientRect().right), width: Math.round(node.getBoundingClientRect().width) })).filter((node) => node.right > document.documentElement.clientWidth + 1 && node.width > 0).sort((a, b) => b.right - a.right).slice(0, 5) }));
        assert.ok(widthCheck.content <= widthCheck.viewport + 1, `${name} hat bei ${label} keinen horizontalen Seitenüberlauf: ${JSON.stringify(widthCheck)}`);
        await screenshot(`acy-ux50-${label}-${name}`);
      }
    }

    const streamerPage = await browser.newPage();
    await streamerPage.context().addCookies([{ name: 'community_admin', value: sessionCookie.split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    streamerPage.on('pageerror', (error) => pageErrors.push(error.message));
    await streamerPage.route('**/dashboard/api/minigames', (route) => route.fulfill({ json: { settings: { enabled: true }, state: { imposter: { phase: 'registration', players: [{}, {}], endsAt: Date.now() + 60_000 }, detective: null } } }));
    await streamerPage.goto(`${base}/streamer`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    assert.equal(await streamerPage.getByRole('heading', { name: /Streamer-Steuerung/u }).isVisible(), true);
    assert.equal(await streamerPage.locator('form, input, select, textarea').count(), 0, 'Streamer-Modus bleibt eine Bedienoberfläche ohne Konfigurationsformulare');
    await streamerPage.getByText(/Anmeldung läuft/u).first().waitFor({ state: 'visible' });
    assert.equal(await streamerPage.locator('#active button').count(), 0, 'Statusbereich zeigt laufende Spiele ohne doppelte Steuerknöpfe');
    assert.equal(await streamerPage.locator('#games').getByRole('button', { name: 'Rollen verteilen' }).isVisible(), true, 'nächste Imposter-Aktion ist an einer einzigen Stelle verfügbar');
    assert.match(await streamerPage.locator('#stream-status').innerText(), /Twitch-Chat:/u, 'Verbindungsstatus benennt den geprüften Bereich');
    for (const [label, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['iphone', 390, 844]] as const) {
      await streamerPage.setViewportSize({ width, height });
      const size = await streamerPage.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      assert.ok(size.content <= size.viewport + 1, `Streamer-Modus hat bei ${label} keinen horizontalen Überlauf: ${JSON.stringify(size)}`);
      if (ux50ScreenshotDir) {
        fs.mkdirSync(ux50ScreenshotDir, { recursive: true });
        await streamerPage.screenshot({ path: path.join(ux50ScreenshotDir, `acy-ux50-${label}-streamer.png`), fullPage: true });
      }
    }
    await streamerPage.close();

    const portalPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    portalPage.on('pageerror', (error) => pageErrors.push(error.message));
    await portalPage.goto(`${base}/community`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await portalPage.getByRole('link', { name: 'Mit Twitch anmelden' }).waitFor({ state: 'visible' });
    assert.equal(await portalPage.getByRole('link', { name: /Dashboard/u }).count(), 0, 'öffentliches Portal verweist nicht auf die Admin-Verwaltung');
    for (const [label, width, height] of [['desktop', 1440, 1000], ['iphone', 390, 844]] as const) {
      await portalPage.setViewportSize({ width, height });
      const size = await portalPage.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      assert.ok(size.content <= size.viewport + 1, `Community-Portal hat bei ${label} keinen horizontalen Überlauf: ${JSON.stringify(size)}`);
      if (ux50ScreenshotDir) {
        fs.mkdirSync(ux50ScreenshotDir, { recursive: true });
        await portalPage.screenshot({ path: path.join(ux50ScreenshotDir, `acy-ux50-${label}-community-portal.png`), fullPage: true });
      }
    }
    await portalPage.close();

    const logoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/dashboard/api/logout');
    await page.locator('#logout').click();
    const logoutResult = await logoutResponse;
    assert.equal(logoutResult.status(), 200, 'Logout-API muss die Sitzung beenden');
    const logoutRequestHeaders = await logoutResult.request().allHeaders();
    assert.equal(logoutResult.request().method(), 'POST');
    assert.ok(logoutRequestHeaders['x-csrf-token'], 'Logout sendet CSRF-Token');
    assert.equal(logoutRequestHeaders.origin, base, 'Logout sendet Browser-Origin');
    await page.waitForURL((url) => url.hostname === 'id.twitch.tv' && url.pathname === '/oauth2/authorize', { waitUntil: 'commit', timeout: 5000 });
    assert.deepEqual(pageErrors, [], `Dashboard darf bei Navigation, Elio, Song-Wünschen und Logout keine JavaScript-Ausnahmen werfen: ${pageErrors.join('; ')}`);
    assert.equal(apiResponses.filter((response) => response.startsWith('429 ')).length, 0, 'die geprüfte Navigation und Einrichtung erzeugen keine Rate-Limit-Antworten');
  } finally {
    await browser?.close();
    await dashboard.stop();
    portal.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  }
});
