import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { CommunityArcade } from './community-arcade.js';
import { CommunityInteractive } from './community-interactive.js';
import { logger } from './logger.js';
import { CommunityTips } from './community-tips.js';
import { AutomaticChatMessages } from './automatic-chat-messages.js';
import { ModeratorPranks } from './moderator-pranks.js';
import { BotLifecycle } from './bot-lifecycle.js';
import { VipExperience } from './vip-experience.js';
import type { TwitchVipService } from './twitch-vip.js';

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
  const arcade = new CommunityArcade(store,'admin-id',()=>0);
  arcade.updateSettings({...arcade.settings(),wheelEnabled:true,petEnabled:true,dropsEnabled:true});
  const sentChat:string[]=[];
  const communityTips=new CommunityTips(store);
  const automaticMessages=new AutomaticChatMessages(store);
  const botLifecycle=new BotLifecycle(store);
  const dashboard = new DashboardServer(store, () => ({ twitchConnected: true, channel: 'acyjannik', startedAt: 1 }), logger, fetchImpl,undefined,undefined,undefined,undefined,arcade,async message=>{sentChat.push(message)},undefined,communityTips,automaticMessages,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,botLifecycle);
  try {
    assert.equal(await dashboard.start(), true);
    const base = `http://127.0.0.1:${port}`;
    const health=await fetch(`${base}/health`);
    assert.equal(health.status,200,'Liveness-Endpunkt ist ohne Anmeldung erreichbar');
    assert.deepEqual(await health.json(),{status:'alive'});
    assert.equal(health.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(`${base}/health`,{method:'POST'})).status,405,'Health-Endpunkt erlaubt keine Schreibzugriffe');
    const publicHelp=await fetch(`${base}/hilfe`);
    assert.equal(publicHelp.status,200,'Hilfeseite ist ohne Twitch-Anmeldung lesbar');
    const publicHtml=await publicHelp.text();
    assert.match(publicHtml,/Mitspielen im Chat/u);
    assert.match(publicHtml,/name="viewport"/u);
    assert.match(publicHtml,/@media\(max-width:520px\)/u);
    assert.match(publicHelp.headers.get('content-security-policy')||'',/style-src 'nonce-/u);
    const searchHelp=await fetch(`${base}/hilfe?q=%21claim`);
    const searchHtml=await searchHelp.text();
    assert.match(searchHtml,/Mystery Drops/u);
    assert.doesNotMatch(searchHtml,/XP &amp; Level/u,'Suchergebnis filtert nicht passende Karten');
    const publicWrite=await fetch(`${base}/hilfe`,{method:'POST'});
    assert.equal(publicWrite.status,405,'öffentliche Hilferoute ist ausschließlich lesend');
    const privateDashboard=await fetch(`${base}/dashboard`,{redirect:'manual'});
    assert.equal(privateDashboard.status,302,'Admin-Dashboard bleibt geschützt');
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

    const protectedStreamer=await fetch(`${base}/streamer`,{redirect:'manual'});
    assert.equal(protectedStreamer.status,302,'Streamer-Modus ist ohne Admin-Sitzung nicht öffentlich');
    const streamer=await fetch(`${base}/streamer`,{headers:{Cookie:sessionCookie}});
    assert.equal(streamer.status,200);
    const streamerHtml=await streamer.text();
    assert.match(streamerHtml,/dashboardPoll\('#stream-status',update,10000\)/u,'Streamerstatus aktualisiert sichtbar und mit Single-Flight statt alle drei Sekunden');
    assert.match(streamerHtml,/Streamer-Steuerung/u);
    assert.match(streamerHtml,/start-drop/u);
    assert.match(streamerHtml,/start-imposter/u);
    assert.match(streamerHtml,/start-detective/u);
    assert.match(streamerHtml,/Jetzt drehen/u);
    assert.match(streamerHtml,/!startguess/u,'Zahlenraten wird als bestehender Chatstart dargestellt, nicht als erfundener API-Start');
    assert.match(streamer.headers.get('cache-control')||'',/no-store/u);
    assert.match(streamer.headers.get('content-security-policy')||'',/frame-ancestors 'none'/u);
    const streamerWrite=await fetch(`${base}/streamer`,{method:'POST',headers:{Cookie:sessionCookie},redirect:'manual'});
    assert.equal(streamerWrite.status,405);

    const page = await fetch(`${base}/dashboard`, { headers: { Cookie: sessionCookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assertInlineScriptsParse(html);
    assert.match(html,/data-dashboard-view="overview" data-active="true"/u,'Übersicht bleibt bei einem Frontend-Startfehler sichtbar');
    assert.match(html,/dashboardPollVisible/u);assert.match(html,/Retry-After/u);assert.doesNotMatch(html,/setInterval\(refreshMini,3000\)|setInterval\(update,3000\)/u,'veraltete aggressive Minispiel-/Streamer-Polls sind nicht mehr aktiv');
    const csrf = html.match(/name="csrf" content="([a-f0-9]+)"/u)?.[1] || '';
    assert.ok(csrf);
    const discordPage=await fetch(`${base}/dashboard/discord`,{headers:{Cookie:sessionCookie}});assert.equal(discordPage.status,200);
    const discordHtml=await discordPage.text();assert.match(discordHtml,/name="mentionLevels"/u);assert.match(discordHtml,/Betroffene verknüpfte Person erwähnen/u);assert.match(discordHtml,/@everyone benachrichtigen/u);assert.match(discordHtml,/name="dailyRewardXp"/u);assert.match(discordHtml,/name="liveUpdateIntervalSeconds"/u);assert.match(discordHtml,/Twitch-Live-Hub/u);
    const discordSettingsResponse=await fetch(`${base}/dashboard/api/discord`,{headers:{Cookie:sessionCookie}});assert.equal(discordSettingsResponse.status,200);
    const discordPayload=await discordSettingsResponse.json() as {settings:Record<string,unknown>;dailyRewardXp:number},discordSettings=discordPayload.settings;assert.equal(discordPayload.dailyRewardXp,25);
    assert.equal(discordSettings.mentionLevels,'none');assert.equal(discordSettings.mentionLive,'none','bestehende Konfiguration erhält keine Erwähnung als impliziten Standard');
    const saveDiscordMentions=await fetch(`${base}/dashboard/api/discord/settings`,{method:'POST',headers:{Cookie:sessionCookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({...discordSettings,mentionLevels:'user',mentionLive:'everyone',liveUpdateIntervalSeconds:120,dailyRewardXp:40})});
    assert.equal(saveDiscordMentions.status,200,await saveDiscordMentions.clone().text());
    assert.equal(store.config<Record<string,number>>('discord_integration',{}).liveUpdateIntervalSeconds,120,'Live-Hub-Intervall wird begrenzt zentral gespeichert');
    const invalidLiveInterval=await fetch(`${base}/dashboard/api/discord/settings`,{method:'POST',headers:{Cookie:sessionCookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({...discordSettings,liveUpdateIntervalSeconds:30})});
    assert.equal(invalidLiveInterval.status,400,'zu häufige Aktualisierungen werden serverseitig abgewiesen');
    assert.equal(store.config<{dailyRewardXp?:number}>('xp_settings',{}).dailyRewardXp,40,'Tages-XP werden über das geschützte Dashboard zentral gespeichert');
    const invalidDiscordMentions=await fetch(`${base}/dashboard/api/discord/settings`,{method:'POST',headers:{Cookie:sessionCookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({...discordSettings,mentionSeasonal:'user'})});
    assert.equal(invalidDiscordMentions.status,400,'nur Levelmeldungen dürfen eine einzelne Person auswählen; @everyone muss ausdrücklich gesetzt werden');
    assert.match(html,/Magic 8-Ball/u);assert.match(html,/Sichere Antwort-Vorschau/u);
    const eightBallState=await fetch(`${base}/dashboard/api/eight-ball`,{headers:{Cookie:sessionCookie}});
    assert.equal(eightBallState.status,200);assert.deepEqual((await eightBallState.json() as any).distribution,{yes:40,no:40,maybe:20});
    const eightBallPreview=await fetch(`${base}/dashboard/api/eight-ball/preview`,{headers:{Cookie:sessionCookie}});
    assert.equal(eightBallPreview.status,200);assert.match((await eightBallPreview.json() as any).answer,/^(JA!|NEIN!|VIELLEICHT!) 🎱/u);
    assert.equal(sentChat.length,0,'8-Ball-Vorschau darf keine Twitch-Nachricht senden');
    const eightBallSave=await fetch(`${base}/dashboard/api/eight-ball`,{method:'POST',headers:{Cookie:sessionCookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({enabled:false,personalCooldownSeconds:45,globalCooldownSeconds:7,cooldownNotices:false})});
    assert.equal(eightBallSave.status,200);const savedEightBall=await fetch(`${base}/dashboard/api/eight-ball`,{headers:{Cookie:sessionCookie}});
    assert.deepEqual((await savedEightBall.json() as any),{enabled:false,settings:{personalCooldownMs:45_000,globalCooldownMs:7_000,cooldownNotices:false},distribution:{yes:40,no:40,maybe:20},lastUsedAt:null});
    assert.match(html,/Bot-Lebenszeichen/u);assert.match(html,/Bei geplanten Neustarts verabschieden und zurückmelden/u);assert.match(html,/Zustellung nicht unabhängig bestätigt/u);
    assert.match(html,/Eigene geplante Nachrichten/u);assert.match(html,/Community-Tipps/u);assert.match(html,/automatic-chat-form/u);assert.match(html,/communityTipCategories/u);
    assert.match(html,/@media\(max-width:520px\)/u);
    assert.match(page.headers.get('content-security-policy') || '', /nonce-/u);
    assert.doesNotMatch(page.headers.get('content-security-policy') || '', /unsafe-inline/u);
    assert.match(html,/Begrüßung neuer Chatter/u);
    assert.match(html,/Community-Aktionen/u);
    assert.match(html,/OBS: Widgets für den Stream/u);
    assert.match(html,/streamerEntry\.href='\/streamer'/u,'Normales Dashboard bietet einen sichtbaren Einstieg in den Streamer-Modus');
    assert.match(html,/3\. Anzeige in OBS einfügen/u);
    assert.match(html,/Link technisch testen/u);
    assert.match(html,/OBS-Sichtbarkeit ist damit noch nicht bestätigt/u);
    assert.match(html,/Teilnehmer-Link:/u);
    assert.match(html,/Twitch-Anmeldung für Mitspieler öffnen/u);
    assert.match(html,/Chat-Stil: COMMUNITY/u);
    assert.match(html,/【🎁 DROP】 Mystery Drop gestartet/u);
    assert.match(html,/!joinimposter/u);
    assert.match(html,/!sus @Name/u);
    assert.match(html,/!savequote Mein Zitat/u);
    assert.match(html,/Automatik pausieren/u);assert.match(html,/Auto-Pilot dreht alle 30 Minuten/u);assert.match(html,/Abstand speichern/u);
    assert.doesNotMatch(html,/Jannik spielt selbst|Erfolg wird nicht automatisch geprüft/u);assert.doesNotMatch(html,/Jannik entscheidet/u,'nach dem Dreh gibt es keine zusätzliche Genehmigung');
    assert.match(html,/So funktioniert’s/u);assert.doesNotMatch(html,/Einfach erklärt/u,'lange Hilfetexte sind nicht mehr standardmäßig eingeblendet');
    assert.match(html,/mini-overlay-status/u);assert.match(html,/arcade-widget-status/u);assert.match(html,/mini-participant-link/u);assert.match(html,/data-drop-status/u);
    assert.match(html,/b\.hidden=!visible/u,'Spielaktionen werden nach der aktuellen Phase ein- und ausgeblendet');
    assert.match(html,/Mindestteilnehmer für Imposter/u);
    assert.match(html,/Diskussion \(Minuten\)/u);
    assert.match(html,/Geheime Regeln für Mitspieler/u);
    assert.doesNotMatch(html,/id="mini-config"/u,'normale Minispiel-Einstellungen dürfen kein JSON-Textfeld zeigen');
    assert.match(html,/Nächster Phasenwechsel in/u,'geführter Imposter-Status zeigt den Countdown');
    assert.match(html,/Mindestzahl von/u,'Rollenverteilung bleibt gesperrt bis genug Mitspielende angemeldet sind');
    assert.match(html,/Chat-Nachrichten/u,'das Antwortverhalten ist im Dashboard auffindbar');
    for (const label of ['Übersicht','Spiele &amp; Aktionen','Community','Stream-Einrichtung','Chatbefehle','Einstellungen']) assert.match(html,new RegExp(label,'u'));
    assert.match(html,/<nav class="main-nav" aria-label="Hauptnavigation">[\s\S]*data-view-target="overview"[\s\S]*data-view-target="games"[\s\S]*data-view-target="community"[\s\S]*data-view-target="obs"[\s\S]*data-view-target="settings"/u,'die Navigation wechselt zwischen fünf echten Ansichten');
    assert.match(html,/id="dashboard-legacy-source" class="legacy-source"/u,'alte Funktionsquellen werden beim Laden verborgen und danach den Ansichten zugeordnet');
    assert.match(html,/data-game-page="imposter"[\s\S]*data-game-page="detective"[\s\S]*data-game-page="drop"[\s\S]*data-game-page="wheel"/u,'Spiele haben getrennte Ansichten');
    assert.match(html,/id="home-status"[\s\S]*id="home-current"[\s\S]*id="setup-checklist"[\s\S]*id="home-warnings"/u,'Startseite zeigt Status, aktives Spiel, Einrichtungsstatus und Warnungen');
    assert.match(html,/id="dashboard-app"/u,'Dashboard ist als getrennte App-Ansicht gerendert');
    assert.match(html,/Community-Boss[\s\S]*hideCard\('Community-Boss'\)/u,'Boss-Feature wird in der normalen Oberfläche nur ausgeblendet');
    assert.match(html,/Chat-Umfrage[\s\S]*hideCard\('Chat-Umfrage'\)/u,'allgemeine Umfrage wird in der normalen Oberfläche nur ausgeblendet');
    assert.match(html,/Weitere Chatspiele[\s\S]*Experimentell[\s\S]*!8ball Frage[\s\S]*!duel @Name[\s\S]*!startguess[\s\S]*!rps schere/u,'experimentelle Chatspiele bleiben mit konkreten Befehlen auffindbar');
    assert.match(html,/1\. Neue Vorschläge prüfen/u,'Aufgabenprüfung ist der erste Schritt des Community-Aufgabenablaufs');
    assert.match(html,/Chat-Ideen-Vorschläge prüfen[\s\S]*getrennt und benötigen weiterhin deine Freigabe/u,'Chat-Ideen bleiben als eigene Vorschlagsquelle im gemeinsamen Prüfablauf gekennzeichnet');
    assert.match(html,/data-game-target="pranks">Chaos &amp; Pranks/u,'Pranks sind bei Spiele und Aktionen eingeordnet');
    assert.match(html,/data-game-page="pranks"/u,'Pranks haben eine eigene Steuerungsansicht');
    assert.match(html,/Saisonpunkte für Halloween, Weihnachten und Ostern sind davon getrennt/u,'Saisonpunkte werden klar von XP getrennt');
    assert.match(html,/Privater OBS-Widget-Link/u);
    assert.match(html,/Erweiterte Einstellungen/u);
    assert.match(html,/<h2>Chat-Ideen<\/h2>[\s\S]*Wie früh soll der Bot ein Thema erkennen\?/u,'Chat-Ideen bieten eine verständliche Empfindlichkeitsauswahl');
    assert.match(html,/Nach Freigabe im Chat veröffentlichen/u,'öffentliche Fragen erfordern ausdrücklich Freigabe');
    assert.doesNotMatch(html,/data-setting-target="general"/u,'leere Allgemein-Seite ist nicht in der Navigation');
    assert.match(html,/data-community-target="music"[^>]*>Song-Wünsche/u,'Song-Wünsche sind unter Community erreichbar');
    assert.match(html,/Song wünschen“ für genau 1\.000 Kanalpunkte/u,'das feste Request-Entgelt wird verständlich angezeigt');
    assert.match(html,/sr-connect[\s\S]*sr-playlists-load[\s\S]*sr-reward-create/u,'Spotify, Playlist und Reward lassen sich aus der Community-Ansicht einrichten');
    assert.doesNotMatch(html,/sr-skip|sr-playback/u,'es gibt keine Wiedergabesteuerung');
    const runtimeStatus=await fetch(`${base}/dashboard/api/status`,{headers:{Cookie:sessionCookie}});
    const runtimeData=await runtimeStatus.json() as {dashboardResponding:boolean;chatReceive:string;botChatSend:string};
    assert.equal(runtimeData.dashboardResponding,true);
    assert.equal(runtimeData.chatReceive,'unknown','eine offene Verbindung darf nicht als Chat-Empfangsnachweis erscheinen');
    assert.equal(runtimeData.botChatSend,'unknown','Senden muss separat gemessen sein');
    const unknownLive=await(await fetch(`${base}/dashboard/api/streamer-state`,{headers:{Cookie:sessionCookie}})).json() as {stream:{status:string;details:unknown}};
    assert.equal(unknownLive.stream.status,'unknown','ohne echte Twitch-Abfrage wird kein Offline- oder Live-Zustand erfunden');
    assert.equal(unknownLive.stream.details,null);
    const optionalChannelPoints=await fetch(`${base}/dashboard/api/channel-points`,{headers:{Cookie:sessionCookie}});
    assert.equal(optionalChannelPoints.status,200,'fehlende optionale Kanalpunkte-Integration soll keinen 405-Fehler erzeugen');
    const optionalChannelPointsData=await optionalChannelPoints.json() as {available:boolean;connected:boolean;message:string};
    assert.equal(optionalChannelPointsData.available,false);
    assert.equal(optionalChannelPointsData.connected,false);
    assert.match(optionalChannelPointsData.message,/nicht eingerichtet/u);
    const songRequests=await fetch(`${base}/dashboard/api/song-requests`,{headers:{Cookie:sessionCookie}});
    assert.equal(songRequests.status,200);const songRequestStatus=await songRequests.json() as {available:boolean;broadcasterConnected:boolean};assert.equal(songRequestStatus.available,false);assert.equal(songRequestStatus.broadcasterConnected,false);
    const privateSongRequests=await fetch(`${base}/dashboard/api/song-requests`);assert.equal(privateSongRequests.status,401,'Song-Request-Daten bleiben dashboardgeschützt');
    const emptyWidgetStatus=await fetch(`${base}/dashboard/api/widgets/status`,{headers:{Cookie:sessionCookie}});
    assert.equal((await emptyWidgetStatus.json() as {widgets:Record<string,boolean>}).widgets.quest,false);
    const welcomeBefore=await fetch(`${base}/dashboard/api/welcome`,{headers:{Cookie:sessionCookie}});
    assert.equal((await welcomeBefore.json() as {enabled:boolean}).enabled,false);
    const welcomeSave=await fetch(`${base}/dashboard/api/welcome`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,message:'Willkommen, {user}!'})});
    assert.equal(welcomeSave.status,200);
    assert.equal((await (await fetch(`${base}/dashboard/api/welcome`,{headers:{Cookie:sessionCookie}})).json() as {enabled:boolean}).enabled,true);
    const chatSettingsBefore=await fetch(`${base}/dashboard/api/chat-messages`,{headers:{Cookie:sessionCookie}});
    const initialChatSettings=await chatSettingsBefore.json() as {profile:string;communityTips:{enabled:boolean;portalEnabled:boolean;halloweenEnabled:boolean;halloweenFrequency:string;halloweenActive:boolean;halloweenPreviews:string[]}};
    assert.equal(initialChatSettings.profile,'normal');
    assert.equal(initialChatSettings.communityTips.enabled,false,'old installations remain opted out');
    assert.equal(initialChatSettings.communityTips.portalEnabled,false,'Portal-Tipp bleibt auf bestehenden Installationen aus');
    assert.equal(initialChatSettings.communityTips.halloweenEnabled,true,'Häufigere Erinnerung ist Standard, sofern Community-Tipps und Event aktiv sind');
    assert.equal(initialChatSettings.communityTips.halloweenFrequency,'frequent');
    assert.equal(initialChatSettings.communityTips.halloweenActive,false,'inaktives Event wird nicht beworben');
    assert.equal(initialChatSettings.communityTips.halloweenPreviews.length,5);
    const automaticSummary=await (await fetch(`${base}/dashboard/api/chat-messages`,{headers:{Cookie:sessionCookie}})).json() as {categories:Array<{id:string;name:string;enabled:boolean;available:boolean}>;automaticChat:{reason:string}};
    assert.ok(automaticSummary.categories.some(category=>category.id==='vault'&&category.name==='Community-Tresor'));
    assert.match(automaticSummary.automaticChat.reason,/Automatische Hinweise sind ausgeschaltet/u);
    const chatSettingsSave=await fetch(`${base}/dashboard/api/chat-messages`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({profile:'calm',welcomeBots:['StreamElements','nightbot'],communityTipsEnabled:true,communityPortalTipsEnabled:true,communityHalloweenEnabled:false,communityHalloweenFrequency:'normal'})});
    assert.equal(chatSettingsSave.status,200,await chatSettingsSave.clone().text());
    assert.deepEqual(store.config('chat_response_settings',{}),{profile:'calm',welcomeBots:['streamelements','nightbot']});
    assert.equal(communityTips.settings().enabled,true,'dashboard can opt in community tips');
    const categorySave=await fetch(`${base}/dashboard/api/chat-messages`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({profile:'calm',welcomeBots:['streamelements','nightbot'],communityTipCategories:{pet:false,quest:true,halloween:false}})});
    assert.equal(categorySave.status,200);assert.equal(communityTips.settings().enabledCategories?.pet,false);
    const categorySettings=await (await fetch(`${base}/dashboard/api/chat-messages`,{headers:{Cookie:sessionCookie}})).json() as {categories:Array<{id:string;enabled:boolean}>;tipPreviews:Array<{id:string}>};
    assert.equal(categorySettings.categories.find(category=>category.id==='pet')?.enabled,false);
    assert.equal(categorySettings.tipPreviews.some(tip=>tip.id==='pet'),false,'abgewählte Kategorie wird nicht in den tatsächlichen Versandkandidaten geführt');
    const invalidCategories=await fetch(`${base}/dashboard/api/chat-messages`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({profile:'normal',welcomeBots:[],communityTipCategories:{unsupported:true}})});
    assert.equal(invalidCategories.status,400,'unbekannte Kategorien werden nicht persistiert');
    assert.equal(communityTips.settings().portalEnabled,true,'Dashboard kann Portal-Hinweise getrennt aktivieren');
    assert.equal(communityTips.settings().halloweenEnabled,false,'Halloween-Erinnerungsschalter wird gespeichert');
    assert.equal(communityTips.settings().halloweenFrequency,'normal','Häufigkeit wird gespeichert');
    const invalidChatSettings=await fetch(`${base}/dashboard/api/chat-messages`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({profile:'quiet',welcomeBots:[]})});
    assert.equal(invalidChatSettings.status,400,'unbekanntes Profil wird abgewiesen');
    const lifecycleUrl=`${base}/dashboard/api/bot-lifecycle`,lifecycleHeaders={Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'};
    assert.equal((await(await fetch(lifecycleUrl,{headers:{Cookie:sessionCookie}})).json() as {enabled:boolean}).enabled,false,'Lebenszeichen bleiben standardmäßig aus');
    const enableLifecycle=await fetch(lifecycleUrl,{method:'POST',headers:lifecycleHeaders,body:JSON.stringify({action:'settings',enabled:true})});assert.equal(enableLifecycle.status,200);assert.equal((await enableLifecycle.json() as {enabled:boolean}).enabled,true);
    const prepareLifecycle=await fetch(lifecycleUrl,{method:'POST',headers:lifecycleHeaders,body:JSON.stringify({action:'prepare'})});assert.equal(prepareLifecycle.status,200);
    assert.equal((await prepareLifecycle.json() as {marker:{phase:string}}).marker.phase,'armed');
    const duplicatePrepare=await fetch(lifecycleUrl,{method:'POST',headers:lifecycleHeaders,body:JSON.stringify({action:'prepare'})});assert.equal(duplicatePrepare.status,409);

    const automaticUnauthorized=await fetch(`${base}/dashboard/api/automatic-messages`,{redirect:'manual'});
    assert.equal(automaticUnauthorized.status,401,'automatische Nachrichten bleiben hinter Dashboard-Login');
    const autoHeaders={Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'};
    const automaticNoCsrf=await fetch(`${base}/dashboard/api/automatic-messages`,{method:'POST',headers:{Cookie:sessionCookie,'Content-Type':'application/json'},body:JSON.stringify({action:'save',title:'Test',message:'Testmeldung',intervalMinutes:30})});
    assert.equal(automaticNoCsrf.status,403,'Änderungen benötigen CSRF-Schutz');
    const automaticSave=await fetch(`${base}/dashboard/api/automatic-messages`,{method:'POST',headers:autoHeaders,body:JSON.stringify({action:'save',title:'Discord-Hinweis',message:'Kommt zu uns auf Discord!',intervalMinutes:45,enabled:true,activeChatOnly:true})});
    assert.equal(automaticSave.status,200,await automaticSave.clone().text());
    const savedAutomatic=await automaticSave.json() as {message:{id:string;preview:string;intervalMinutes:number}};
    assert.equal(savedAutomatic.message.intervalMinutes,45);assert.match(savedAutomatic.message.preview,/【📢 INFO】/u);
    assert.equal(((await (await fetch(`${base}/dashboard/api/automatic-messages`,{headers:{Cookie:sessionCookie}})).json()) as {messages:Array<unknown>}).messages.length,1);
    const automaticPaused=await fetch(`${base}/dashboard/api/automatic-messages`,{method:'POST',headers:autoHeaders,body:JSON.stringify({action:'toggle',id:savedAutomatic.message.id,enabled:false})});
    assert.equal(automaticPaused.status,200);assert.equal(automaticMessages.list()[0]?.enabled,false);
    const automaticEdited=await fetch(`${base}/dashboard/api/automatic-messages`,{method:'POST',headers:autoHeaders,body:JSON.stringify({action:'save',id:savedAutomatic.message.id,title:'Discord',message:'Willkommen!',intervalMinutes:60,enabled:true})});
    assert.equal(automaticEdited.status,200);assert.equal(automaticMessages.list()[0]?.activeChatOnly,true,'nicht übermittelte Optionen bleiben erhalten');
    const automaticDeleted=await fetch(`${base}/dashboard/api/automatic-messages`,{method:'POST',headers:autoHeaders,body:JSON.stringify({action:'delete',id:savedAutomatic.message.id})});
    assert.equal(automaticDeleted.status,200);assert.equal(automaticMessages.list().length,0);
    const invalidInterval=await fetch(`${base}/dashboard/api/automatic-messages`,{method:'POST',headers:autoHeaders,body:JSON.stringify({action:'save',title:'Zu oft',message:'Nein',intervalMinutes:1})});
    assert.equal(invalidInterval.status,400,'Mindestabstand kann nicht unterschritten werden');

    const dashboardPage=await fetch(`${base}/dashboard`,{headers:{Cookie:sessionCookie}}).then(response=>response.text());
    assert.match(dashboardPage,/Auto-Pilot dreht alle 30 Minuten/u);
    assert.doesNotMatch(dashboardPage,/<form id="arcade-challenge"/u,'normale Bedienung enthält keinen manuellen Challenge-Editor');
    assert.doesNotMatch(dashboardPage,/Jannik spielt sie selbst/u);

    const wheelState=await fetch(`${base}/dashboard/api/arcade`,{headers:{Cookie:sessionCookie}});
    const wheelData=await wheelState.json() as {wheel:{canSpin:boolean;entries:Array<{id:string;probability:number}>;wheelFields:Array<{title:string;description:string;probability:number;kind:string;active:boolean}>}};
    assert.equal(wheelData.wheel.canSpin,true);assert.ok(wheelData.wheel.entries.length>=2);
    assert.ok(Math.abs(wheelData.wheel.entries.reduce((sum,x)=>sum+x.probability,0)-100)<1,'Rad-Wahrscheinlichkeiten ergeben 100 Prozent');
    assert.ok(wheelData.wheel.wheelFields.some(x=>x.title==='Eine Runde ohne Springen'&&x.kind==='streamer-task'&&x.active));
    assert.ok(wheelData.wheel.wheelFields.some(x=>x.title==='Elio bekommt einen Energieschub!'&&x.kind==='automatic'&&x.probability>0));
    const wheelSpin=await fetch(`${base}/dashboard/api/arcade`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({action:'spin'})});
    assert.equal(wheelSpin.status,200);assert.match((await wheelSpin.json() as {message:string}).message,/Ergebnis:/u);assert.equal(sentChat.length,1,'Dreh-Ergebnis wird automatisch im Chat angekündigt');
    const wheelAfter=await fetch(`${base}/dashboard/api/arcade`,{headers:{Cookie:sessionCookie}});
    const afterWheel=(await wheelAfter.json() as {wheel:{canSpin:boolean;activeAction:unknown;entries:Array<{actionType:string}>}}).wheel;
    assert.equal(afterWheel.canSpin,false,'Cooldown blockiert einen unmittelbaren weiteren Spin');
    assert.equal(afterWheel.activeAction,null,'automatische Aktion wartet nicht auf eine manuelle Auflösung');
    assert.ok(afterWheel.entries.every(entry=>entry.actionType!=='manual_challenge'));
    const wheelTokenResponse=await fetch(`${base}/dashboard/api/widgets/token`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({type:'wheel',action:'rotate'})});
    assert.equal(wheelTokenResponse.status,201);
    const wheelToken=new URL((await wheelTokenResponse.json() as {url:string}).url).searchParams.get('token')||'';
    const wheelPage=await fetch(`${base}/widgets/wheel?token=${wheelToken}`),wheelHtml=await wheelPage.text();
    assert.equal(wheelPage.status,200);assert.match(wheelHtml,/<svg id="wheel"/u,'OBS zeigt ein echtes SVG-Rad');assert.match(wheelHtml,/cubic-bezier\(\.10,\.02,\.12,1\)/u,'Drehung bremst weich ab');assert.match(wheelHtml,/prefers-reduced-motion/u,'reduzierte Bewegung wird beachtet');assertInlineScriptsParse(wheelHtml);
    const wheelSnapshot=await fetch(`${base}/widgets/api/wheel?token=${wheelToken}`),wheelWidget=await wheelSnapshot.json() as {visible:boolean;wheel:{id:string;title:string;selectedKey:string;fields:Array<{id:string;title:string;weight:number}>}};
    assert.equal(wheelWidget.visible,true);assert.ok(wheelWidget.wheel.fields.length>=2);
    const selectedField=wheelWidget.wheel.fields.find(field=>field.id===wheelWidget.wheel.selectedKey);
    assert.ok(selectedField,'ausgewähltes Backend-Feld ist im gewichteten Rad enthalten');assert.equal(selectedField.title,wheelWidget.wheel.title,'Titel stimmt mit dem tatsächlich gespeicherten Gewinner überein');
    assert.equal('createdBy' in wheelWidget.wheel,false,'keine internen oder persönlichen Spin-Daten werden veröffentlicht');
    const manualWheelAction=await fetch(`${base}/dashboard/api/arcade`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({action:'challenge',title:'Manuell',weight:1,actionType:'manual_challenge'})});
    assert.equal(manualWheelAction.status,400,'Dashboard-API lehnt manuelle Radfelder ab');

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

    store.setConfig('spark_settings',{enabled:true,publishMode:'approved-chat'});
    const questionNow=Date.now()+180_000;
    const questionProposal=store.createSparkProposal({id:'dashboard-question-test',channelId:'channel-id',topicId:'films',topicLabel:'Filme und Serien',
      score:18,participants:4,messages:7,actionType:'question',suggestionText:'Welchen Film könntet ihr immer wieder schauen?',createdAt:questionNow,expiresAt:questionNow+60_000},5,60_000,120_000);
    assert.ok(questionProposal);
    const questionApprove=await fetch(`${base}/dashboard/api/spark/action`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({id:questionProposal.id,action:'approve'})});
    assert.equal(questionApprove.status,200);assert.equal(sentChat.at(-1),'Welchen Film könntet ihr immer wieder schauen?');assert.equal(store.sparkProposal(questionProposal.id)?.status,'executed');
    const repeatQuestion=await fetch(`${base}/dashboard/api/spark/action`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({id:questionProposal.id,action:'approve'})});
    assert.equal(repeatQuestion.status,409,'bereits veröffentlichte Fragen können nicht doppelt gesendet werden');

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
    assert.match(widgetHtml,/widgets\/api\//u,'OBS-Widget nutzt die vorhandene Snapshot-API');assert.match(widgetHtml,/now-hit\.at<10000/u,'Widget-Snapshot-Abfragen werden mit SSE-Fallback zusammengefasst');
    assert.match(widgetHtml, /LIVE-QUEST/u);
    assertInlineScriptsParse(widgetHtml);
    const widgetSnapshotResponse = await fetch(`${widgetBase}/api/quest?token=${widgetToken}`);
    assert.equal(widgetSnapshotResponse.status, 200);
    const widgetSnapshot = await widgetSnapshotResponse.json() as { visible: boolean; quest: Record<string, unknown> };
    assert.equal(widgetSnapshot.visible, true);
    assert.equal(widgetSnapshot.quest.title, 'Nächste Runde nur Pistolen');
    assert.equal('submitterUserId' in widgetSnapshot.quest, false);
    assert.equal((await fetch(`${widgetBase}/api/poll?token=${widgetToken}`)).status, 404, 'Quest-Token darf kein Poll-Widget lesen');
    const streamControllers=Array.from({length:4},()=>new AbortController());
    const widgetStreams=await Promise.all(streamControllers.map(controller=>fetch(`${widgetBase}/stream/quest?token=${widgetToken}`,{signal:controller.signal})));
    assert.ok(widgetStreams.every(stream=>stream.headers.get('content-type')?.startsWith('text/event-stream')));
    const widgetChunk=await widgetStreams[0]!.body?.getReader().read();assert.match(new TextDecoder().decode(widgetChunk?.value),/snapshot/u,'Widget-Neuverbindung bekommt sofort einen Snapshot');
    const excessWidget=await fetch(`${widgetBase}/stream/quest?token=${widgetToken}`);assert.equal(excessWidget.status,429,'parallele OBS-Quellen pro privatem Token sind begrenzt');assert.ok(Number(excessWidget.headers.get('Retry-After'))>=1);
    await Promise.all(streamControllers.map(controller=>controller.abort()));
    const tokenRevoke = await fetch(`${base}/dashboard/api/widgets/token`, {
      method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://localhost:${port}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'quest', action: 'revoke' }),
    });
    assert.equal(tokenRevoke.status, 200);
    assert.equal((await fetch(`${widgetBase}/api/quest?token=${widgetToken}`)).status, 404, 'widerrufene Widget-URL ist sofort ungültig');

    const earlierPoll=store.activePoll();if(earlierPoll)store.endPoll(earlierPoll.id,Date.now());
    const liveDecision=await fetch(`${base}/dashboard/api/polls`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({question:'Welche Strategie?',options:['Vorsichtig','Mutig'],durationSeconds:30})});assert.equal(liveDecision.status,201,await liveDecision.clone().text());const liveDecisionBody=await liveDecision.json() as {poll:{id:string;allowVoteChange:boolean;endsAt:number}};assert.equal(liveDecisionBody.poll.allowVoteChange,false);assert.ok(liveDecisionBody.poll.endsAt-Date.now()<=30_000);assert.match(sentChat.at(-1)||'',/!vote 1–2/u);
    const tooShortDecision=await fetch(`${base}/dashboard/api/polls`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({question:'Zu kurz?',options:['A','B'],durationSeconds:10})});assert.equal(tooShortDecision.status,400);
    await fetch(`${base}/dashboard/api/polls/action`,{method:'POST',headers:{Cookie:sessionCookie,Origin:`http://localhost:${port}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({id:liveDecisionBody.poll.id,action:'end'})});

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

    const tabBursts=await Promise.all(Array.from({length:4},()=>Array.from({length:40},()=>fetch(`${base}/dashboard/api/status`,{headers:{Cookie:sessionCookie}}))).flat());
    assert.equal(tabBursts.length,160);assert.ok(tabBursts.every((r)=>r.status===200),'vier gleichzeitig geöffnete Admin-Tabs bleiben innerhalb des sitzungsbasierten Leselimits');

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

test('Discord-Tagesbelohnung nutzt zentrale XP, ist parallel cooldown-geschützt und idempotent',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-discord-daily-')),store=new FeatureStore(path.join(directory,'features.sqlite')),port=await freePort();
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin-id';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET='test-discord-integration-secret-that-is-long-enough';
  store.setConfig('discord_integration',{enabled:true,accountLinkEnabled:true});store.setConfig('xp_settings',{dailyRewardXp:25,dailyGameCap:100});
  store.miniGameTransaction(db=>db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run('twitch-user-1','1206225751544832053',Date.now()));
  const dashboard=new DashboardServer(store,()=>({twitchConnected:true,channel:'acyjannik',startedAt:1}),logger,async()=>Response.json({}));
  try{assert.equal(await dashboard.start(),true);const url=`http://127.0.0.1:${port}/api/discord/v1/community/daily`,headers={authorization:'Bearer test-discord-integration-secret-that-is-long-enough','content-type':'application/json'};
    const post=(eventId:string)=>fetch(url,{method:'POST',headers,body:JSON.stringify({eventId,discordUserId:'1206225751544832053',displayName:'Community-Mitglied'})});
    const responses=await Promise.all([post('1206225751544832054'),post('1206225751544832055')]),results=await Promise.all(responses.map(r=>r.json() as Promise<{status:string;awarded:number}>));
    assert.deepEqual(results.map(x=>x.status).sort(),['claimed','cooldown']);assert.equal(store.xp('twitch-user-1').xp,25);
    const retry=await post('1206225751544832054'),replayed=await retry.json() as {status:string;awarded:number;duplicateEvent:boolean};assert.equal(replayed.status,'claimed');assert.equal(replayed.awarded,25);assert.equal(replayed.duplicateEvent,true);assert.equal(store.xp('twitch-user-1').xp,25);
    const unlinked=await fetch(url,{method:'POST',headers,body:JSON.stringify({eventId:'1206225751544832056',discordUserId:'1206225751544832060',displayName:'unlinked'})});assert.equal(unlinked.status,403);
  }finally{await dashboard.stop();store.close();fs.rmSync(directory,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];for(const [key,value] of Object.entries(env))process.env[key]=value;}
});

test('Discord-Community-Events sind nur authentifiziert erreichbar und teilen Battle-Identität sowie Limits',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-discord-community-events-')),store=new FeatureStore(path.join(directory,'features.sqlite')),port=await freePort();
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin-id';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET='test-discord-integration-secret-that-is-long-enough';
  store.setConfig('discord_integration',{enabled:true});const interactive=new CommunityInteractive(store);interactive.updateSettings({battleEnabled:true,battleActionCooldownMs:5_000,battleMaxPointsPerUser:1});const battle=interactive.startBattle('admin',Date.now());assert.equal(battle.ok,true);
  store.miniGameTransaction(db=>db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run('linked-twitch-id','1206225751544832053',Date.now()));
  assert.equal(interactive.join(battle.event!.id,'twitch','linked-twitch-id','Linked Viewer').status,'joined');
  const dashboard=new DashboardServer(store,()=>({twitchConnected:true,channel:'acyjannik',startedAt:1}),logger,async()=>Response.json({}));
  try{assert.equal(await dashboard.start(),true);const base=`http://127.0.0.1:${port}/api/discord/v1/community/events`,headers={authorization:'Bearer test-discord-integration-secret-that-is-long-enough','content-type':'application/json'};
    assert.equal((await fetch(base)).status,401);
    const list=await fetch(base,{headers}),snapshot=await list.json() as {events:Array<{id:string;points:{twitch:number;discord:number}}>,enabled:boolean};assert.equal(list.status,200);assert.equal(snapshot.enabled,true);assert.equal(snapshot.events[0]?.id,battle.event?.id);
    const join=await fetch(`${base}/join`,{method:'POST',headers,body:JSON.stringify({eventId:battle.event?.id,discordUserId:'1206225751544832053',displayName:'Viewer'})});assert.equal(join.status,409,'linked Twitch account cannot double-join across platform teams');
    const teammate=await fetch(`${base}/join`,{method:'POST',headers,body:JSON.stringify({eventId:battle.event?.id,discordUserId:'1206225751544832054',displayName:'Discord Viewer'})});assert.equal(teammate.status,200);
    const score=await fetch(`${base}/contribute`,{method:'POST',headers,body:JSON.stringify({eventId:battle.event?.id,discordUserId:'1206225751544832054',eventIdempotencyKey:'1206225751544832055'})});assert.equal(score.status,200);assert.deepEqual((await score.json() as {event:{points:{twitch:number;discord:number}}}).event.points,{twitch:0,discord:1});
    const duplicate=await fetch(`${base}/contribute`,{method:'POST',headers,body:JSON.stringify({eventId:battle.event?.id,discordUserId:'1206225751544832054',eventIdempotencyKey:'1206225751544832055'})});assert.equal((await duplicate.json() as {duplicate:boolean}).duplicate,true);
  }finally{await dashboard.stop();store.close();fs.rmSync(directory,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];for(const [key,value] of Object.entries(env))process.env[key]=value;}
});

test('Moderator-OAuth öffnet nur die Prank-Oberfläche und serverseitig nur deren API',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-prank-dashboard-')),store=new FeatureStore(path.join(directory,'features.sqlite')),port=await freePort();
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin-id';process.env.AUTHORIZED_MODERATOR_IDS='mod-id';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  let verifiedUserId='mod-id';const fetchImpl:typeof fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'temporary'});if(url.endsWith('/oauth2/validate'))return Response.json({client_id:'test-client',user_id:verifiedUserId,login:verifiedUserId==='mod-id'?'mod':'admin'});if(url.endsWith('/helix/users'))return Response.json({data:[{id:verifiedUserId,login:verifiedUserId==='mod-id'?'mod':'admin',display_name:'Test User'}]});throw Error(`Unexpected URL ${url}`)};
  const pranks=new ModeratorPranks(store,()=>false,()=>false);pranks.configure({enabled:{chief:true}});
  const vipExperience=new VipExperience(store);vipExperience.updateSettings({enabled:true,loungeEnabled:true,chaosEnabled:true});const request=vipExperience.requestChaos('123456','VIP Fan','stream-1','elio-crown',Date.now());assert.equal(request.ok,true);
  const vipService={isVip:async(userId:string)=>userId==='123456',status:async()=>({state:'ready',authorized:true,scopeGranted:true,checkedAt:Date.now()})} as unknown as TwitchVipService;
  const dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,pranks,async(login)=>login==='target'?{id:'123456',login:'target',displayName:'Target'}:undefined,undefined,undefined,undefined,vipService,vipExperience);
  try{
    assert.equal(await dashboard.start(),true);const base=`http://127.0.0.1:${port}`;
    const login=await fetch(`${base}/dashboard/login`,{redirect:'manual'}),state=new URL(login.headers.get('location')||'').searchParams.get('state')||'',stateCookie=login.headers.get('set-cookie')?.split(';')[0]||'';
    const callback=await fetch(`${base}/dashboard/oauth/callback?code=x&state=${state}`,{headers:{Cookie:stateCookie},redirect:'manual'});assert.equal(callback.status,303);
    const session=callback.headers.getSetCookie().find(x=>x.startsWith('community_admin='))?.split(';')[0]||'';
    const page=await fetch(`${base}/dashboard`,{headers:{Cookie:session}});assert.equal(page.status,200);const html=await page.text();assert.match(html,/Chaos &amp; Pranks/u);assert.match(html,/VIP-Chaos-Anfragen/u);assert.doesNotMatch(html,/data-dashboard-view="overview"|DASHBOARD_ADMIN/u);
    const csrf=html.match(/<meta name="csrf" content="([^"]+)/u)?.[1]||'';assert.ok(csrf);
    assert.equal((await fetch(`${base}/dashboard/api/overview`,{headers:{Cookie:session}})).status,403);
    assert.equal((await fetch(`${base}/streamer`,{headers:{Cookie:session}})).status,403);
    assert.equal((await fetch(`${base}/dashboard/api/fairness`,{headers:{Cookie:session}})).status,403);
    assert.equal((await fetch(`${base}/dashboard/api/discord`,{headers:{Cookie:session}})).status,403,'Discord-Verbindungsdetails bleiben Administratoren vorbehalten');
    assert.equal((await fetch(`${base}/dashboard/api/pranks`,{headers:{Cookie:session}})).status,200);
    assert.equal((await fetch(`${base}/dashboard/api/vip/status`,{headers:{Cookie:session}})).status,200,'Moderatoren können offene VIP-Anfragen in ihrer eingeschränkten Ansicht lesen');
    const vipApproval=await fetch(`${base}/dashboard/api/vip/chaos`,{method:'POST',headers:{Cookie:session,Origin:'https://bot.example.test','X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({id:request.id,action:'approve'})});assert.equal(vipApproval.status,200,await vipApproval.clone().text());assert.equal((pranks.snapshot().active as {kind?:string}|null)?.kind,'chief');
    assert.equal((await fetch(`${base}/dashboard/api/vip/settings`,{method:'POST',headers:{Cookie:session,Origin:'https://bot.example.test','X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}'})).status,403,'Moderatoren können VIP-Einstellungen nicht ändern');
    assert.equal((pranks.snapshot().active as {kind?:string}|null)?.kind,'chief','Freigabe startet genau einmal den vorhandenen Prank');
    assert.equal((await fetch(`${base}/dashboard/api/minigames`,{headers:{Cookie:session}})).status,403);
    assert.equal((await fetch(`${base}/dashboard/api/pranks`)).status,401);
  }finally{await dashboard.stop();store.close();fs.rmSync(directory,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];for(const [key,value] of Object.entries(env))process.env[key]=value}
});
