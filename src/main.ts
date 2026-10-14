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
import { ChatResponsePolicy, DEFAULT_CHAT_RESPONSE_SETTINGS } from './chat-response-policy.js';
import { parseEventSubChatMessage } from './chat.js';
import type { ChatMessage } from './types.js';
import { ChannelPointsService } from './channel-points.js';
import type { QuestPolicy } from './feature-store.js';
import { CommunityTips } from './community-tips.js';
import { AutomaticChatMessages } from './automatic-chat-messages.js';
import { singleFlight } from './single-flight.js';
import { SpotifySongRequests } from './song-requests.js';
import { ViewerCommunityPortal } from './community-portal.js';
import { CommunityPortalHealth } from './portal-health.js';

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
    [{name:'channel-points',oauth:redemptionOauth,callbackPath:'/oauth/redemptions/callback',stateFilePath:`${config.redemptionTokenFile}.oauth-state`}],
    `${config.tokenFile}.oauth-state`);
  const game = new GameService(database, config);
  const chatPolicy = new ChatResponsePolicy(features.config('chat_response_settings', DEFAULT_CHAT_RESPONSE_SETTINGS));
  const communityTips = new CommunityTips(features);
  const automaticChatMessages = new AutomaticChatMessages(features);
  const handler = new CommandHandler(database, game, config, undefined, community, chatPolicy, communityTips);
  const queue = new SendQueue(
    async (message, replyParentMessageId) => {
      const result = await sendChatMessageWithRetry(api, config.broadcasterUserId, config.botUserId, message, replyParentMessageId);
      if (!result.isSent) logger.warn('Twitch hat die Antwort verworfen.', { reason: result.dropReason || 'unbekannt' });
      else logger.info('Twitch hat die Chatantwort angenommen.');
    },
    Math.max(1500, config.sendQueueIntervalMs),
    logger,
    config.maxChatMessageLength,
  );
  let channelPoints:ChannelPointsService|undefined;
  let songRequests:SpotifySongRequests|undefined;
  let lastSpecialAnnouncementAt = botStartedAt;
  const eventsub = new EventSubClient(
    async (sessionId) => {
      await api.ensureChatSubscription(sessionId, config.broadcasterUserId, config.botUserId);
      if(channelPoints)try{await channelPoints.ensureSubscription(sessionId);}
      catch(error){logger.warn('Kanalpunkte-EventSub konnte nicht aktiviert werden; Chatbetrieb läuft weiter.',{error:error instanceof Error?error.message:'unbekannt'});}
      if(songRequests)try{await songRequests.ensureSubscription(sessionId);}
      catch(error){logger.warn('Song-Request-EventSub konnte nicht aktiviert werden; übriger Chatbetrieb läuft weiter.',{error:error instanceof Error?error.message:'unbekannt'});}
    },
    async (rawMessage) => {
      const payload=rawMessage.payload as Record<string,unknown>|undefined;
      const subscription=payload?.subscription as Record<string,unknown>|undefined;
      if(subscription?.type==='channel.channel_points_custom_reward_redemption.add'){
        const payload=rawMessage.payload as Record<string,unknown>|undefined,event=payload?.event as Record<string,unknown>|undefined,reward=event?.reward as Record<string,unknown>|undefined;
        const rewardId=String(reward?.id||'');
        try{
          if(songRequests?.settings().rewardId===rewardId)await songRequests.acceptEventSub(rawMessage);
          else if(channelPoints?.settings().rewardId===rewardId)await channelPoints.acceptEventSub(rawMessage);
        }
        catch(error){logger.error('Kanalpunkte-Einlösung konnte nicht verarbeitet werden.',{error:error instanceof Error?error.message:'unbekannt'});}
        return;
      }
      if(subscription?.type!=='channel.chat.message'){
        logger.warn('Nicht unterstützter EventSub-Benachrichtigungstyp ignoriert.',{subscriptionType:typeof subscription?.type==='string'?subscription.type:'unbekannt'});
        return;
      }
      let chatMessage;
      try { chatMessage = parseEventSubChatMessage(rawMessage); }
      catch {
        const payload=rawMessage.payload&&typeof rawMessage.payload==='object'?rawMessage.payload as Record<string,unknown>:{};
        const event=payload.event&&typeof payload.event==='object'?payload.event as Record<string,unknown>:{};
        logger.warn('EventSub-Chat-Event hat ein unerwartetes Format; Verbindung bleibt bestehen.',{
          payloadKeys:Object.keys(payload),eventKeys:Object.keys(event),
          hasBroadcasterId:typeof event.broadcaster_user_id==='string',
          hasChatterId:typeof event.chatter_user_id==='string',hasMessageId:typeof event.message_id==='string',
        });
        return;
      }
      let replies;
      communityTips.observe(chatMessage);
      community.vault.observeActivity(chatMessage);
      try { replies = await handler.handle(chatMessage); }
      catch(error){logger.error('Twitch-Chatnachricht konnte im Command-Handler nicht verarbeitet werden.',{error:error instanceof Error?error.message:'unbekannt'});return;}
      const command=chatMessage.message.trim().split(/\s+/u)[0]?.toLowerCase()||'';
      if(command.startsWith('!'))logger.info('Twitch-Chatbefehl verarbeitet.',{command:/^![a-z0-9_-]{1,32}$/u.test(command)?command:'!other',replyCount:replies.length});
      for (const reply of replies) {
        if (['drop','wheel','imposter','detective','quest','poll','season','pet','boss','attack','help','communityPortal','vault'].includes(reply.category || '')) lastSpecialAnnouncementAt = Date.now();
        if (!chatPolicy.shouldSend({ command: command.startsWith('!') ? command : '', message: reply.message })) continue;
        try { await queue.enqueue(reply.message, reply.replyParentMessageId, reply.category); }
        catch { /* SendQueue logs the safe transport failure; EventSub stays connected. */ }
      }
    },
  );
  let dashboard:DashboardServer|undefined;
  let lastTipLiveCheckAt = 0;
  let checkingLive = false;
  const communityPortalHealth=new CommunityPortalHealth(new URL('/community',config.redirectUri).toString());
  let lastWheelLiveCheckAt = 0;
  let checkingWheelLive = false;
  let lastVaultLiveCheckAt = 0;
  let checkingVaultLive = false;
  const runFeatureTick = singleFlight(async () => {
      try {
        const announcements = community.tickMessages();
        for (const message of announcements) {
          void queue.enqueue(message.message, undefined, message.category).catch(error =>
            logger.warn('Automatische Spielmeldung konnte nicht gesendet werden; der gespeicherte Spielzustand bleibt erhalten.', { error: error instanceof Error ? error.message : 'unbekannt' }));
        }
        if (announcements.length) { lastSpecialAnnouncementAt = Date.now(); return; }
        const now = Date.now();
        const snapshots = community.miniGames.snapshot();
        const arcade = community.arcade.snapshot('drop');
        const wheel = community.arcade.wheelStatus();
        const dropStatus = (arcade.drop as { status?: string } | undefined)?.status;
        const busy = Boolean(snapshots.imposter || snapshots.detective || features.activeQuest() || features.activePoll(now) || features.activeBoss(now)
          || ['announced','claiming','resolving'].includes(dropStatus || '') || wheel.active
          || queue.busy || now - lastSpecialAnnouncementAt < 60_000);
        const vaultReady=community.vault.autoStartReady(now,community.vault.activeViewerCount(now),busy,lastSpecialAnnouncementAt);
        if(vaultReady&&!checkingVaultLive&&now-lastVaultLiveCheckAt>=15_000){
          checkingVaultLive=true;lastVaultLiveCheckAt=now;
          try{
            const stream=await api.getStreamStatus(config.broadcasterUserId);
            if(stream&&community.vault.autoStartReady(Date.now(),community.vault.activeViewerCount(),busy,lastSpecialAnnouncementAt)){
              const started=community.vault.startAutomatic(Date.now());
              if(started.ok){lastSpecialAnnouncementAt=Date.now();try{await queue.enqueue(started.message,undefined,'vault');}
                catch(error){logger.warn('Tresor-Startmeldung konnte nicht gesendet werden; die Runde bleibt im Dashboard sichtbar.',{error:error instanceof Error?error.message:'unbekannt'});}
                return;
              }
            }
          }catch(error){logger.warn('Automatischer Tresor-Start wegen unbekanntem Live-Status zurückgestellt.',{error:error instanceof Error?error.message:'unbekannt'});}
          finally{checkingVaultLive=false;}
        }
        const profile = chatPolicy.snapshot().profile, availability = {...community.helpAvailability(),communityPortal:communityTips.settings().portalEnabled};
        const dueMessage=automaticChatMessages.hasDue(now,communityTips.eligibleActivityMessages,busy);
        const wantsTip=communityTips.shouldEvaluate(profile,availability,busy,now)&&automaticChatMessages.canReserveGlobalSlot(now);
        const wheelReady=community.arcade.wheelStatus(now) as {enabled:boolean;autoPilotEnabled:boolean;canSpin:boolean;autoSpinDue:boolean};
        if(wheelReady.enabled&&wheelReady.autoPilotEnabled&&wheelReady.canSpin&&wheelReady.autoSpinDue
          &&!checkingWheelLive&&now-lastWheelLiveCheckAt>=15_000){
          checkingWheelLive=true;lastWheelLiveCheckAt=now;
          try{
            const stream=await api.getStreamStatus(config.broadcasterUserId);
            if(stream){
              const result=community.arcade.autoSpinIfDue(Date.now());
              if(result){
                lastSpecialAnnouncementAt=Date.now();
                try{await queue.enqueue(result,undefined,'wheel');}
                catch(error){logger.warn('Automatisches Glücksrad-Ergebnis konnte nicht in den Chat gestellt werden; die Aktion bleibt gespeichert und wird nicht erneut ausgeführt.',{error:error instanceof Error?error.message:'unbekannt'});}
                return;
              }
            }
          }catch(error){logger.warn('Automatischer Glücksrad-Dreh wegen unbekanntem Live-Status oder Twitch-Fehler zurückgestellt.',{error:error instanceof Error?error.message:'unbekannt'});}
          finally{checkingWheelLive=false;}
        }
        if (!checkingLive && now - lastTipLiveCheckAt >= 15_000 && (Boolean(dueMessage)||wantsTip)) {
          checkingLive = true;
          try {
            lastTipLiveCheckAt = Date.now();
            const stream = await api.getStreamStatus(config.broadcasterUserId);
            if (!stream) { communityTips.alignStream(null);communityTips.maybeSend({ isLive: false, profile, availability, busy, now: Date.now() }); }
            else {
              communityTips.alignStream(stream.id);
              if(communityTips.settings().portalEnabled)availability.communityPortal=await communityPortalHealth.isAvailable();
              const currentState=community.miniGames.snapshot(),currentDrop=community.arcade.snapshot('drop'),currentWheel=community.arcade.wheelStatus();
              const currentDropStatus=(currentDrop.drop as {status?:string}|undefined)?.status;
              const currentBusy=Boolean(currentState.imposter||currentState.detective||features.activeQuest()||features.activePoll(Date.now())||features.activeBoss(Date.now())
                ||['announced','claiming','resolving'].includes(currentDropStatus||'')||currentWheel.active||queue.busy||Date.now()-lastSpecialAnnouncementAt<60_000);
              const currentDue=automaticChatMessages.nextDue(Date.now(),communityTips.eligibleActivityMessages,currentBusy,true);
              if(currentDue&&chatPolicy.shouldSend({message:currentDue.message,now:Date.now()})&&automaticChatMessages.reserveMessageAttempt(currentDue.id,Date.now())){
                communityTips.consumeActivity();
                try{await queue.enqueue(currentDue.message,undefined,'info');automaticChatMessages.markSent(currentDue.id,Date.now());}
                catch(error){automaticChatMessages.markFailed(currentDue.id,Date.now());logger.warn('Automatische Chatnachricht konnte nicht gesendet werden; nächster Versuch frühestens nach dem Nachrichtenintervall.',{error:error instanceof Error?error.message:'unbekannt'});}
              }else if(!currentBusy&&wantsTip){
                const tip = communityTips.maybeSend({ isLive: true, streamId: stream.id, profile, availability, busy:currentBusy, now: Date.now(),
                  allowSend: candidate => chatPolicy.shouldSend({ message: candidate.text, now: Date.now() }) });
                if(tip&&automaticChatMessages.reserveGlobalSlot(Date.now())){
                  communityTips.consumeActivity();
                  try{await queue.enqueue(tip.text,undefined,'tip');}catch(error){logger.warn('Community-Tipp konnte nicht in den Chat gestellt werden.',{error:error instanceof Error?error.message:'unbekannt'});}
                }
              }
            }
          }
          catch (error) {
            logger.warn('Community-Tipp wegen unbekanntem Twitch-Live-Status unterdrückt.', { error: error instanceof Error ? error.message : 'unbekannt' });
          } finally { checkingLive = false; }
        }
      } catch (error) { logger.error('Community-Tipp- oder Spiel-Timer konnte nicht aktualisiert werden.', { error: error instanceof Error ? error.message : 'unbekannt' }); }
  }, error => logger.error('Feature-Ticker konnte nicht ausgeführt werden.', { error: error instanceof Error ? error.message : 'unbekannt' }));
  const featureTicker = setInterval(runFeatureTick, 1000);
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
    const redemptionApi=new TwitchApi(config.clientId,redemptionOauth);
    songRequests=new SpotifySongRequests(features,redemptionApi,redemptionOauth,config.broadcasterUserId,logger);
    await songRequests.initialize();
    const viewerPortal=new ViewerCommunityPortal(features,community,{...config,redirectUri:process.env.DASHBOARD_REDIRECT_URI?.trim()||config.redirectUri},fetch);
    dashboard = new DashboardServer(features, () => ({twitchConnected:eventsub.isConnected,channel:config.channelLogin,startedAt:botStartedAt,...queue.snapshot(),chatResponse:chatPolicy.snapshot()}),
      logger,fetch,()=>community.conversationSpark.snapshot(),channelPoints,()=>oauthServer.startUrlFor('channel-points'),community.miniGames,community.arcade,
      async(message,category)=>{if(!chatPolicy.shouldSend({message,now:Date.now()}))return;await queue.enqueue(message,undefined,category);},chatPolicy,communityTips,automaticChatMessages,songRequests,viewerPortal,community.vault,
      async()=>{const now=Date.now(),stream=await api.getStreamStatus(config.broadcasterUserId);if(!stream||community.vault.activeViewerCount(now)<community.vault.settings().minActiveViewers||now-lastSpecialAnnouncementAt<5*60_000)return false;const game=community.miniGames.snapshot(),drop=community.arcade.snapshot('drop'),wheel=community.arcade.wheelStatus(),dropStatus=(drop.drop as {status?:string}|undefined)?.status;return !Boolean(game.imposter||game.detective||features.activeQuest()||features.activePoll(now)||features.activeBoss(now)||['announced','claiming','resolving'].includes(dropStatus||'')||wheel.active||queue.busy);},
      community.moderatorPranks,async(login)=>{const user=(await api.getUsers([login]))[0];return user?{id:user.id,login:user.login,displayName:user.display_name}:undefined;},
      {weights:config.eventWeights,source:process.env.EVENT_WEIGHTS_JSON?.trim()?'EVENT_WEIGHTS_JSON (beim Bot-Start geladen)':'Standardwerte aus src/config.ts'});
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
