import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
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
import { CommunityVault } from '../src/community-vault.js';
import { CommunityTips } from '../src/community-tips.js';
import { BotLifecycle } from '../src/bot-lifecycle.js';

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
  const botLifecycle=new BotLifecycle(store);
  store.awardXp('browser-ux-seed', 'viewer-42', 'Testviewer', 250, 'Browser-Testkonto', Date.now());
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  process.env.TWITCH_CLIENT_ID = 'test-client';
  process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  process.env.DASHBOARD_REDIRECT_URI = `${base}/dashboard/oauth/callback`;
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
  communityFeatures.vault.updateSettings({enabled:true});
  assert.equal(communityFeatures.vault.startManual(Date.now()).ok,true);
  store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='042' WHERE status='active'").run());
  const portal = new ViewerCommunityPortal(store, communityFeatures, testConfig(), fetchImpl);
  const communityTips=new CommunityTips(store);
  const dashboard = new DashboardServer(store, () => ({ twitchConnected: true, channel: 'acyjannik', startedAt: 1 }), logger, fetchImpl, undefined, undefined, undefined, miniGames, arcade, async()=>{}, undefined, communityTips, undefined, undefined, portal, communityFeatures.vault, async()=>true, communityFeatures.moderatorPranks,async(login)=>({id:'123456',login,displayName:'Testviewer'}),undefined,undefined,botLifecycle);
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
      await page.evaluate(()=>{window.scrollTo(0,0);const notice=document.querySelector('#notice');if(notice)notice.textContent=''});
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

    assert.equal(await page.getByRole('heading', { name: 'Stream bereit machen' }).isVisible(), true, 'Startseite enthält eine Einrichtungs-Checkliste');
    assert.match(await page.locator('#home-status').innerText(), /Bot antwortet[\s\S]*Twitch-Verbindung/u, 'Kompaktstatus zeigt Bot und Twitch');
    assert.match(await page.locator('#setup-checklist').innerText(), /Chat kann Nachrichten empfangen[\s\S]*OBS-Widget-Link/u, 'Checkliste zeigt Chat-Nachweis und optionale OBS-Einrichtung');
    await screenshot('acy-dashboard-setup-checklist');

    await navigate('settings');
    await page.locator('[data-setting-target="messages"]').click();
    const hintPanel=page.locator('#chat-response-settings');
    await hintPanel.getByRole('heading',{name:'Automatische Chat-Hinweise'}).waitFor({state:'visible'});
    const lifecycleToggle=hintPanel.getByLabel('Bei geplanten Neustarts verabschieden und zurückmelden');
    assert.equal(await lifecycleToggle.isChecked(),false,'Neustartnachrichten sind anfangs aus');
    await lifecycleToggle.check();
    await page.waitForFunction(async()=>Boolean((await(await fetch('/dashboard/api/bot-lifecycle')).json()).enabled));
    assert.match(await hintPanel.innerText(),/Bot schreibt während eines Live-Streams/u);
    await hintPanel.getByRole('button',{name:'Geplanten Neustart vorbereiten'}).click();
    await hintPanel.getByText(/Geplanter Neustart ist vorbereitet/u).waitFor();
    assert.equal(await hintPanel.getByRole('button',{name:'Geplanten Neustart vorbereiten'}).isDisabled(),true);
    assert.match(await hintPanel.innerText(),/Ruhig[\s\S]*Normal[\s\S]*Lebhaft/u,'Profile und tatsächliche Grenzen werden angezeigt');
    assert.match(await hintPanel.innerText(),/Community-Tresor[\s\S]*!code 427/u,'aktiviertes Spiel zeigt den belegten Zuschauerbefehl');
    assert.match(await hintPanel.innerText(),/Vorschau · kein Versand/u,'Vorschau versendet keine Twitch-Nachricht');
    assert.match(await hintPanel.innerText(),/Event nicht aktiv; Hinweise pausieren automatisch/u,'inaktives Saison-Event wird klar gekennzeichnet');
    assert.equal(await hintPanel.locator('[data-category]').count(),15,'alle implementierten Hinweis-Kategorien werden angezeigt');
    assert.equal(await hintPanel.locator('[data-category="halloween"] .chat-preview').count(),2,'Halloween-Vorschauen erscheinen auch ohne aktives Event als Beispiele');
    const screenshotDir=process.env.DASHBOARD_SCREENSHOT_DIR;
    if(screenshotDir){fs.mkdirSync(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,'automatic-chat-hints-desktop.png'),fullPage:true});}
    const questCard=hintPanel.locator('[data-category="quest"]');
    assert.match(await questCard.innerText(),/!quest IDEE/u);assert.match(await questCard.innerText(),/Jannick oder ein Mod startet/u);
    const hallow=hintPanel.locator('[data-category="halloween"] input[type="checkbox"]');await hallow.uncheck();
    await hintPanel.locator('select').nth(1).selectOption('normal');
    await hintPanel.getByRole('button',{name:'Einstellungen speichern'}).click();
    await page.waitForFunction(async()=>{const d=await(await fetch('/dashboard/api/chat-messages')).json();return d.communityTips?.halloweenEnabled===false&&d.communityTips?.halloweenFrequency==='normal'&&d.communityTips?.enabledCategories?.halloween===false});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Chat-Hinweise passen mobil ohne seitliches Scrollen');
    if(screenshotDir){await page.screenshot({path:path.join(screenshotDir,'automatic-chat-hints-mobile.png'),fullPage:true});}
    await page.setViewportSize({width:1440,height:1000});

    await navigate('obs');
    assert.equal(await page.getByRole('heading', { name: 'OBS-Einrichtung' }).isVisible(), true, 'OBS wird als geführter Einrichtungsschritt dargestellt');
    assert.equal(await page.locator('#obs-type option').count(), 8, 'Assistent listet alle unterstützten Einzel-Widgets');
    await page.locator('#obs-type').selectOption('vault');
    assert.match(await page.locator('#obs-description').innerText(), /Geheimcode bleibt verborgen/u, 'Tresorvorschau erklärt den Schutz des Codes');
    assert.match(await page.locator('#obs-size').innerText(), /900 × 440 Pixel/u, 'Assistent empfiehlt eine verständliche Quellgröße');
    await screenshot('acy-dashboard-obs-assistant');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#obs-create').click();
    await page.locator('#obs-result input').waitFor({ state: 'visible', timeout: 4000 }).catch(async () => assert.fail(`Widget-Link wurde nicht erstellt. Meldung: ${await page.locator('#notice').innerText()} · Status: ${await page.locator('#obs-link-status').innerText()} · API: ${apiResponses.join(', ')}`));
    await page.locator('#obs-test').click();
    await page.getByText(/Widget-Seite ist erreichbar/u).waitFor({ state: 'visible', timeout: 3000 });
    assert.match(await page.locator('#obs-test-status').innerText(), /OBS-Sichtbarkeit ist damit noch nicht bestätigt/u, 'Linktest verspricht keine Sichtbarkeit in OBS');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'OBS-Assistent passt mobil ohne seitliches Scrollen');
    await page.setViewportSize({ width: 1440, height: 1000 });

    await navigate('games');
    await page.locator('#game-catalog').getByRole('button', {name:'Community-Tresor'}).click();
    await assertSubpage('[data-game-page="vault"]', true);
    await page.getByRole('heading', { name: '🔐 Community-Tresor' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#vault-status')?.textContent?.includes('Tresor offen'));
    const dashboardVault=await page.evaluate(async()=>await (await fetch('/dashboard/api/vault')).json());
    assert.equal(dashboardVault.snapshot.vault.resultCode,null,'Dashboard-Snapshot liefert während der Runde keinen Code');
    assert.equal(JSON.stringify(dashboardVault).includes('secret_code'),false,'Dashboard-API gibt keine Geheimcode-Spalte aus');
    const duplicateStart=await page.evaluate(async()=>{const csrf=(document.querySelector('meta[name=csrf]') as HTMLMetaElement).content;return (await fetch('/dashboard/api/vault/action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({action:'start'})})).status});
    assert.equal(duplicateStart,409,'eine zweite Tresor-Runde wird abgewiesen');
    await screenshot('acy-community-vault-desktop');
    await page.setViewportSize({width:390,height:844});
    const vaultSize=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
    assert.ok(vaultSize.content<=vaultSize.viewport+1,`Community-Tresor passt mobil ohne seitliches Scrollen: ${JSON.stringify(vaultSize)}`);
    await screenshot('acy-community-vault-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('[data-game-page="vault"] .subpage-back').click();
    assert.equal(await page.locator('#game-catalog').isVisible(),true,'Tresor-Unterseite kann zum Spielekatalog zurückkehren');

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
    await page.locator('[data-community-target="quests"]').click();
    assert.equal(await page.locator('.quest-flow-steps li').count(), 3, 'Quest-Verwaltung erklärt den Ablauf in drei Schritten');
    assert.equal(await page.getByRole('heading', { name: '1. Neue Vorschläge prüfen' }).isVisible(), true, 'Neue Vorschläge sind der erste sichtbare Schritt');
    await page.getByText('Noch keine neuen Vorschläge.').waitFor({ state: 'visible' });
    await page.getByText('Noch keine freigegebenen Aufgaben.').waitFor({ state: 'visible' });
    await screenshot('acy-dashboard-quests-workflow');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Aufgabenablauf passt mobil ohne seitliches Scrollen');
    await screenshot('acy-dashboard-quests-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-community-target="elio"]').click();
    await page.locator('[data-community-page="elio"] .subpage-back').click();
    await assertSubpage('[data-community-page="events"]', true);
    await page.locator('[data-community-target="elio"]').click();
    const elioStatus = page.locator('#pet-status');
    await elioStatus.getByText(/Elio.*Level.*Hunger.*Energie.*Zufriedenheit/u).waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
      assert.fail(`Elio-Status fehlt: ${JSON.stringify(await page.evaluate(() => ({ petStatus: document.querySelector('#pet-status')?.textContent, arcadeState: document.querySelector('#arcade-state')?.textContent, arcadeCard: document.querySelector('#dashboard-community')?.textContent, arcadeCount: document.querySelectorAll('#arcade-state').length, arcadeButtonCount: document.querySelectorAll('#arcade-drop').length, arcadeLoad: typeof (window as unknown as {arcadeLoad?:unknown}).arcadeLoad, inlineHasArcade: [...document.scripts].some(s=>s.textContent.includes('arcadeLoad')) })))}, pageErrors=${pageErrors.join(' | ')}, api=${apiResponses.join(', ')}`);
    });
    assert.match(await elioStatus.innerText(), /Kätzchen/u, 'Elio zeigt seine Lebensphase');
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
      if(name==='messages')assert.equal(await page.locator('#chat-response-settings [data-category="communityPortal"] input[type="checkbox"]').isVisible(),true,'Portal-Tipp ist über den Kategorie-Schalter erreichbar');
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
    await page.getByText('Chat-Ideen einstellen').click();
    assert.equal(await page.getByLabel('Wie früh soll der Bot ein Thema erkennen?').isVisible(), true, 'Erkennung hat eine verständliche Empfindlichkeit');
    assert.equal(await page.locator('#spark-settings select[name="publishMode"]').isVisible(), true, 'Veröffentlichung kann intern oder erst nach Freigabe erfolgen');
    assert.equal(await page.locator('#spark-categories input[type="checkbox"]').count(), 11, 'alle Themenkategorien sind einzeln schaltbar');
    assert.equal(await page.getByRole('button', { name: 'Thema hinzufügen' }).isVisible(), true, 'eigene Gesprächsthemen können verständlich ergänzt werden');
    await page.getByRole('button', { name: 'Thema hinzufügen' }).click();
    const newTopic = page.locator('.spark-topic').last();
    await newTopic.getByLabel('Thema', { exact: true }).fill('Browser-Testthema');
    await newTopic.getByLabel('Erkennungsbegriffe, durch Kommas getrennt', { exact: true }).fill('browser test, ux prüfung');
    await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
    await page.getByText('Chat-Ideen gespeichert.').waitFor({ state: 'visible' });
    const savedSpark = await page.evaluate(async () => (await (await fetch('/dashboard/api/spark')).json()).customTopics);
    assert.ok(savedSpark.some((topic: { label: string }) => topic.label === 'Browser-Testthema'), 'Themenformular speichert eigene Themen dauerhaft über die API');
    await screenshot('acy-ux50-desktop-community-spark');

    await navigate('games');
    await page.locator('#game-catalog').getByRole('button', { name: /Chaos & Pranks/u }).click();
    await assertSubpage('[data-game-page="pranks"]',true);
    for(const title of ['Elio übernimmt die Macht 👑','Elio verdächtigt jemanden 🕵️','Tresor-Fehlalarm 🚨','Das unseriöse Orakel 🔮'])assert.equal(await page.getByRole('heading',{name:title}).isVisible(),true);
    await screenshot('acy-chaos-pranks-desktop');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Chaos & Pranks passt mobil ohne horizontalen Überlauf');
    await screenshot('acy-chaos-pranks-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.getByLabel('Aktivieren',{exact:true}).first().check();
    await page.getByRole('button',{name:'Für 60 Sekunden starten'}).click();
    await page.getByText(/Elio als Stream-Chef läuft noch/u).waitFor({state:'visible'});
    await screenshot('acy-chaos-pranks-active-desktop');
    await page.getByRole('button',{name:'Laufenden Prank beenden'}).click();
    await page.locator('#prank-result').getByText('Prank beendet.').waitFor({state:'visible'});
    await navigate('community');
    await page.locator('[data-community-target="fairness"]').click();
    await assertSubpage('[data-community-page="fairness"]',true);
    await page.getByText(/Theoretisch: Gewinn 62\.00 % · Verlust 33\.00 % · neutral 5\.00 %/u).waitFor({state:'visible'});
    await screenshot('acy-halloween-fairness-desktop');

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
    const publicVaultState=await portalPage.evaluate(async()=>await(await fetch('/community/api/state',{cache:'no-store'})).json());
    assert.equal(publicVaultState.public.vault.status,'active','Community-Portal zeigt den laufenden Tresor');
    assert.equal(publicVaultState.personal,null,'unangemeldete Zuschauer erhalten keine persönlichen Tipps');
    assert.equal(publicVaultState.public.vault.resultCode,null,'Community-API zeigt während einer aktiven Runde kein Ergebnis');
    assert.equal(Object.hasOwn(publicVaultState.public.vault,'secretCode'),false,'Community-API gibt kein Geheimcode-Feld aus');
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
    const afterLogout = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    assert.equal(afterLogout.status, 302, 'nach Logout ist die Admin-Sitzung serverseitig ungültig');
    assert.equal(afterLogout.headers.get('location'), '/dashboard/login');
    const loginAgain = await fetch(`${base}/dashboard/login`, { redirect: 'manual' });
    assert.equal(new URL(loginAgain.headers.get('location') || '').hostname, 'id.twitch.tv', 'abgemeldete Sitzung kann wieder zur Twitch-Anmeldung wechseln');
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

test('Chaos-Wheel-OBS-Widget zeigt das festgelegte gewichtete Ergebnis und landet exakt am Zeiger',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-wheel-browser-')),store=new FeatureStore(path.join(directory,'state.sqlite')),port=await freePort();
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI=`http://127.0.0.1:${port}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='admin-id';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  const base=`http://127.0.0.1:${port}`,arcade=new CommunityArcade(store,'admin-id',()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,petEnabled:true,dropsEnabled:true});
  const fetchImpl:typeof fetch=async input=>String(input).endsWith('/oauth2/token')?Response.json({access_token:'ephemeral-wheel-token'}):String(input).endsWith('/oauth2/validate')?Response.json({client_id:'test-client',user_id:'admin-id'}):String(input).endsWith('/helix/users')?Response.json({data:[{id:'admin-id',login:'admin',display_name:'Admin'}]}):Response.error();
  const dashboard=new DashboardServer(store,()=>({twitchConnected:true,channel:'acyjannik',startedAt:Date.now()}),logger,fetchImpl,undefined,undefined,undefined,undefined,arcade);
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    assert.equal(await dashboard.start(),true);
    const rawToken=randomBytes(32).toString('base64url');store.rotateWidgetToken('wheel',createHash('sha256').update(rawToken).digest('hex'),Date.now(),'admin-id');
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:900,height:900}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${base}/widgets/wheel?token=${rawToken}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#root')?.dataset.ready==='true');
    arcade.spinAdmin('admin-id',Date.now());
    await page.waitForFunction(()=>document.querySelector('#root')?.dataset.spinId!==''&&document.querySelector('#root')?.dataset.spinId!==undefined,{timeout:5000});
    await page.waitForFunction(()=>document.querySelector('#rotor')?.getAnimations().length===1,{timeout:3000});
    const timing=await page.locator('#rotor').evaluate(node=>node.getAnimations()[0]?.effect?.getTiming());assert.equal(timing?.duration,6000);assert.match(String(timing?.easing),/cubic-bezier/u);
    assert.ok(await page.locator('#rotor .segment').count()>=2);assert.equal(await page.locator('#winner').innerText(),(await (await fetch(`${base}/widgets/api/wheel?token=${rawToken}`)).json() as {wheel:{title:string}}).wheel.title);
    await page.waitForFunction(()=>document.querySelector('#root')?.classList.contains('result')===true,{timeout:7000});
    const screenshotDir=path.join(process.cwd(),'docs','verification');fs.mkdirSync(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,'chaos-wheel-2.png'),fullPage:true});
    const landing=await page.locator('#wheel').evaluate(node=>{const svg=node as SVGSVGElement,angle=Number(svg.dataset.selectedCenter),transform=getComputedStyle(document.querySelector('#rotor')!).transform,m=new DOMMatrixReadOnly(transform),rotation=((Math.atan2(m.b,m.a)*180/Math.PI)%360+360)%360;return {angle,rotation,error:Math.abs((((angle+rotation+90)%360)+360)%360)}});
    assert.ok(landing.error<0.2,`Gewinnersegment landet am festen Zeiger: ${JSON.stringify(landing)}`);assert.deepEqual(errors,[]);
    const mobile=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});await mobile.goto(`${base}/widgets/wheel?token=${rawToken}`,{waitUntil:'domcontentloaded'});await mobile.waitForSelector('#root:not([hidden])');
    assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Wheel-Widget passt mobil ohne horizontales Scrollen');assert.equal(await mobile.locator('#rotor').evaluate(node=>node.getAnimations().length),0,'später Einstieg und reduzierte Bewegung lösen keine alte Dreh-Animation aus');
  }finally{await browser?.close();await dashboard.stop();store.close();fs.rmSync(directory,{recursive:true,force:true});for(const [key,value] of Object.entries(env))process.env[key]=value;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];}
});

test('Elio-Aktionen geben Browserfeedback, aktualisieren Werte und sperren den Cooldown',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-elio-browser-')),store=new FeatureStore(path.join(directory,'state.sqlite')),port=await freePort();
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI=`http://127.0.0.1:${port}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='admin-id';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  const cfg=testConfig({clientId:'test-client',clientSecret:'test-secret',redirectUri:`http://127.0.0.1:${port}/dashboard/oauth/callback`}),features=new CommunityFeatures(store,cfg);
  features.arcade.updateSettings({...features.arcade.settings(),petEnabled:true,petCooldownMs:1000});
  store.miniGameQuery(db=>db.prepare("UPDATE community_pet SET xp=95,level=1 WHERE id=1").run());
  const fetchImpl:typeof fetch=async input=>String(input).endsWith('/oauth2/token')?Response.json({access_token:'ephemeral-viewer-token'}):String(input).endsWith('/oauth2/validate')?Response.json({client_id:'test-client',user_id:'portal-viewer'}):String(input).endsWith('/helix/users')?Response.json({data:[{id:'portal-viewer',login:'viewer',display_name:'Portal Viewer'}]}):Response.error();
  const portal=new ViewerCommunityPortal(store,features,cfg,fetchImpl),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:Date.now()}),logger,fetchImpl,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,portal);
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    assert.equal(await dashboard.start(),true);const base=`http://127.0.0.1:${port}`;
    const login=await fetch(base+'/community/login/twitch',{redirect:'manual'}),redirect=new URL(login.headers.get('location')||''),state=redirect.searchParams.get('state')||'',stateCookie=login.headers.get('set-cookie')?.split(';')[0]||'';
    const callback=await fetch(`${base}/dashboard/oauth/callback?code=test&state=${state}`,{headers:{cookie:stateCookie},redirect:'manual'}),viewerCookie=callback.headers.getSetCookie().find(value=>value.startsWith('community_viewer='))?.split(';')[0]||'';
    assert.equal(callback.status,303);assert.ok(viewerCookie);
    browser=await chromium.launch({headless:true});const page=await browser.newPage({reducedMotion:'reduce'});
    await page.context().addCookies([{name:'community_viewer',value:viewerCookie.split('=')[1]!,domain:'127.0.0.1',path:'/community',httpOnly:true,secure:false,sameSite:'Lax'}]);
    const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(base+'/community',{waitUntil:'domcontentloaded'});
    const feed=page.getByRole('button',{name:'Füttern'}),play=page.getByRole('button',{name:'Mit Elio spielen'});await feed.waitFor({state:'visible'});
    await play.click();await page.locator('#pet-action-status').getByText(/Level aufgestiegen/u).waitFor({timeout:3000}).catch(async()=>{assert.fail(`pet status=${await page.locator('#pet-action-status').textContent()} pet=${await page.locator('#pet').innerText()} errors=${pageErrors.join('|')}`)});
    assert.match(await page.locator('#pet .item').first().innerText(),/Level 2/u,'Elio-Level wird nach erfolgreichem Spielen aktualisiert');
    assert.equal(await page.locator('#pet-card').evaluate(node=>node.classList.contains('pet-level-up')),true,'Levelaufstieg erhält eine dezente Animation');
    await feed.waitFor({state:'visible'});assert.equal(await feed.isDisabled(),true,'Feed-Schaltfläche bleibt während des Cooldowns gesperrt');
    await page.locator('#pet-cooldown').getByText(/Nächste Pflegeaktion in/u).waitFor({timeout:2000});
    await page.waitForFunction(()=>!(document.querySelector('[data-pet-action="feed"]') as HTMLButtonElement).disabled,undefined,{timeout:3000});
    await page.route('**/community/api/pet',route=>route.abort());await feed.click();await page.locator('#pet-action-status').getByText(/Verbindung ist fehlgeschlagen/u).waitFor({timeout:3000});assert.equal(await feed.isDisabled(),false,'nach einem Netzwerkfehler bleibt die Schaltfläche nicht blockiert');await page.unroute('**/community/api/pet');
    await feed.click();await page.locator('#pet-action-status').getByText(/Elio wurde gefüttert/u).waitFor({timeout:3000});
    await page.waitForFunction(()=>/Hunger\s*78%/u.test(document.querySelector('#pet .item:nth-child(2)')?.textContent||''),undefined,{timeout:3000});
    store.miniGameQuery(db=>db.prepare('UPDATE community_pet SET paused=1 WHERE id=1').run());await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('#pet-action-status').getByText(/Pflegepause/u).waitFor({timeout:3000});assert.equal(await feed.isDisabled(),true,'pausierte Pflege deaktiviert die Aktion');
    assert.deepEqual(pageErrors,[],'Elio-Aktionen dürfen keine JavaScript-Fehler auslösen');
  }finally{await browser?.close();await dashboard.stop();store.close();fs.rmSync(directory,{recursive:true,force:true});for(const [key,value] of Object.entries(env))process.env[key]=value;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];}
});
