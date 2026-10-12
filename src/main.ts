import readline from 'node:readline';
import { Database } from './database.js';
import { loadConfig } from './config.js';
import { CommandHandler } from './command-handler.js';
import { GameService } from './game.js';
import { FeatureStore } from './feature-store.js';
import { CommunityFeatures } from './community-features.js';
import { DashboardServer } from './dashboard.js';
import { logger } from './logger.js';
import { TwitchOAuth, FileTokenStore, OAuthCallbackServer } from './twitch-oauth.js';
import { TwitchApi, TwitchApiError } from './twitch-api.js';
import { EventSubClient } from './eventsub.js';
import { SendQueue } from './send-queue.js';
import { parseEventSubChatMessage } from './chat.js';
import type { ChatMessage } from './types.js';
import { ChannelPointsService } from './channel-points.js';
import type { QuestPolicy } from './feature-store.js';

const isTestMode = process.argv.includes('--test') || process.env.TEST_MODE === 'true';

async function runTestMode(): Promise<void> {
  const config = loadConfig({ testMode: true });
  const database = new Database(config.databasePath, config.activeOnStart);
  const features = new FeatureStore(config.databasePath);
  const game = new GameService(database, config);
  const community = new CommunityFeatures(features, config);
  community.syncLegacyHalloween();
  const handler = new CommandHandler(database, game, config, undefined, community);
  let eventNumber = 0;
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  logger.info('Testmodus aktiv. Eingabe: userId|Anzeigename|!befehl (ohne Präfix = Jannik).');
  logger.info('Beispiel: !startHalloween oder alice|Alice|!trickortreat');
  try {
    for await (const line of input) {
      const fields = line.split('|');
      const [senderUserId, senderDisplayName, message] = fields.length >= 3
        ? [fields[0] || 'test-user', fields[1] || fields[0] || 'TestUser', fields.slice(2).join('|')]
        : [config.broadcasterUserId, 'Jannik', line];
      const chatMessage: ChatMessage = {
        eventId: `test-${++eventNumber}`,
        messageId: `test-message-${eventNumber}`,
        broadcasterUserId: config.broadcasterUserId,
        senderUserId,
        senderLogin: senderUserId,
        senderDisplayName,
        message,
        sentAt: Date.now(),
        isModerator: senderUserId === config.broadcasterUserId || config.authorizedModeratorIds.includes(senderUserId),
      };
      const replies = await handler.handle(chatMessage);
      for (const reply of replies) process.stdout.write(`BOT> ${reply.message}\n`);
    }
  } finally {
    input.close();
    features.close();
    database.close();
  }
}

async function runLiveMode(): Promise<void> {
  const botStartedAt = Date.now();
  const config = loadConfig();
  const database = new Database(config.databasePath, config.activeOnStart);
  const features = new FeatureStore(config.databasePath);
  const community = new CommunityFeatures(features, config, async (login) => {
    const user = (await api.getUsers([login]))[0];
    return user ? { id: user.id, login: user.login, displayName: user.display_name } : undefined;
  });
  community.syncLegacyHalloween();
  const oauth = new TwitchOAuth(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
    config.oauthScopes,
    new FileTokenStore(config.tokenFile),
  );
  const api = new TwitchApi(config.clientId, oauth);
  const redemptionOauth = new TwitchOAuth(config.clientId,config.clientSecret,config.redemptionRedirectUri,['channel:manage:redemptions'],
    new FileTokenStore(config.redemptionTokenFile));
  const oauthServer = new OAuthCallbackServer(config.oauthHost, config.oauthPort, config.oauthStateTtlMs, oauth, logger,
    [{name:'channel-points',oauth:redemptionOauth,callbackPath:'/oauth/redemptions/callback'}]);
  const game = new GameService(database, config);
  const handler = new CommandHandler(database, game, config, undefined, community);
  const queue = new SendQueue(
    async (message, replyParentMessageId) => {
      const result = await sendChatMessageWithRetry(api, config.broadcasterUserId, config.botUserId, message, replyParentMessageId);
      if (!result.isSent) logger.warn('Twitch hat die Antwort verworfen.', { reason: result.dropReason || 'unbekannt' });
    },
    Math.max(1500, config.sendQueueIntervalMs),
    logger,
    config.maxChatMessageLength,
  );
  let channelPoints:ChannelPointsService|undefined;
  const eventsub = new EventSubClient(
    async (sessionId) => {
      await api.ensureChatSubscription(sessionId, config.broadcasterUserId, config.botUserId);
      if(channelPoints)try{await channelPoints.ensureSubscription(sessionId);}
      catch(error){logger.warn('Kanalpunkte-EventSub konnte nicht aktiviert werden; Chatbetrieb läuft weiter.',{error:error instanceof Error?error.message:'unbekannt'});}
    },
    async (rawMessage) => {
      const payload=rawMessage.payload as Record<string,unknown>|undefined;
      const subscription=payload?.subscription as Record<string,unknown>|undefined;
      if(subscription?.type==='channel.channel_points_custom_reward_redemption.add'){
        try{await channelPoints?.acceptEventSub(rawMessage);}
        catch(error){logger.error('Kanalpunkte-Einlösung konnte nicht verarbeitet werden.',{error:error instanceof Error?error.message:'unbekannt'});}
        return;
      }
      const chatMessage = parseEventSubChatMessage(rawMessage);
      const replies = await handler.handle(chatMessage);
      for (const reply of replies) {
        await queue.enqueue(reply.message, reply.replyParentMessageId);
      }
    },
  );
  let dashboard:DashboardServer|undefined;
  const featureTicker = setInterval(() => {
    try { for(const message of community.tick())void queue.enqueue(message); }
    catch (error) { logger.error('Community-Spiel-Timer konnte nicht aktualisiert werden.', { error: error instanceof Error ? error.message : 'unbekannt' }); }
  }, 1000);
  featureTicker.unref();

  try {
    await oauth.initialize(config.accessToken, config.refreshToken);
    try{await redemptionOauth.initialize();}
    catch(error){logger.warn('Optionales Broadcaster-Kanalpunkte-Token konnte nicht geladen werden; Dashboard-Reauthorisierung ist erforderlich.',{error:error instanceof Error?error.message:'unbekannt'});}
    await oauthServer.start();
    if (!oauth.hasAccessToken) {
      logger.warn('Noch kein Twitch-OAuth vorhanden. Öffne die folgende URL im Browser:', { url: oauthServer.startUrl });
      await oauth.waitForAuthorization();
    }
    const users = await api.getUsers([config.channelLogin, config.botLogin]);
    const broadcaster = users.find((user) => user.login.toLowerCase() === config.channelLogin.toLowerCase());
    const bot = users.find((user) => user.login.toLowerCase() === config.botLogin.toLowerCase());
    if (!broadcaster || !bot) throw new Error('Kanal- oder Bot-Konto wurde von Twitch nicht gefunden.');
    if (config.broadcasterUserId && config.broadcasterUserId !== broadcaster.id) throw new Error('TWITCH_BROADCASTER_USER_ID passt nicht zum Kanal.');
    if (config.botUserId && config.botUserId !== bot.id) throw new Error('TWITCH_BOT_USER_ID passt nicht zum Bot-Konto.');
    config.broadcasterUserId = broadcaster.id;
    config.botUserId = bot.id;
    logger.info('Twitch-Konten erkannt.', { channel: broadcaster.login, bot: bot.login });
    channelPoints=new ChannelPointsService(features,new TwitchApi(config.clientId,redemptionOauth),redemptionOauth,config.broadcasterUserId,()=>{
      const settings=features.config<Partial<QuestPolicy>>('quest_settings',{});
      return {maxLength:settings.maxLength??180,queueLimit:settings.queueLimit??100,maxOpenPerUser:settings.maxOpenPerUser??2,
        cooldownMs:settings.cooldownMs??300_000,activeDurationMs:settings.activeDurationMs??0,completionXp:settings.completionXp??25};
    },logger);
    dashboard = new DashboardServer(features, () => ({twitchConnected:eventsub.isConnected,channel:config.channelLogin,startedAt:botStartedAt}),
      logger,fetch,()=>community.conversationSpark.snapshot(),channelPoints,()=>oauthServer.startUrlFor('channel-points'),community.miniGames);
    logger.info('OAuth-Server erreichbar unter http://127.0.0.1:3000/oauth/start');
    await dashboard.start();
    eventsub.start();
  } catch (error) {
    clearInterval(featureTicker);
    await eventsub.stop();
    await dashboard?.stop();
    await oauthServer.stop();
    features.close();
    database.close();
    throw error;
  }

  const shutdown = async () => {
    clearInterval(featureTicker);
    await eventsub.stop();
    await dashboard?.stop();
    await oauthServer.stop();
    features.close();
    database.close();
  };
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
}

async function sendChatMessageWithRetry(
  api: TwitchApi,
  broadcasterId: string,
  senderId: string,
  message: string,
  replyParentMessageId?: string,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api.sendChatMessage(broadcasterId, senderId, message, replyParentMessageId);
    } catch (error) {
      if (!(error instanceof TwitchApiError) || error.status !== 429 || attempt === 2) throw error;
      const delay = Math.min(30_000, Math.max(1000, error.retryAfterMs || 5000));
      logger.warn('Twitch-Ratelimit erreicht; Senden wird verzögert.', { delayMs: delay });
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unerwarteter Sendefehler.');
}

try {
  await (isTestMode ? runTestMode() : runLiveMode());
} catch (error) {
  if (error instanceof TwitchApiError && error.status === 401) {
    logger.error('Twitch-OAuth ist abgelaufen oder nicht berechtigt. OAuth erneut ausführen.');
  } else {
    logger.error('Bot konnte nicht gestartet werden.', { error: error instanceof Error ? error.message : 'unbekannt' });
  }
  process.exitCode = 1;
}
