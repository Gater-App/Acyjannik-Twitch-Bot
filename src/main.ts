import readline from 'node:readline';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Database } from './database.js';
import { loadConfig } from './config.js';
import { CommandHandler } from './command-handler.js';
import { GameService } from './game.js';
import { FeatureStore } from './feature-store.js';
import { CommunityFeatures } from './community-features.js';
import { DashboardServer } from './dashboard.js';
import { logger } from './logger.js';
import { TwitchOAuth, FileTokenStore, OAuthCallbackServer } from './twitch-oauth.js';
import { TwitchApi, TwitchApiError, type TwitchStream } from './twitch-api.js';
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
import { BotLifecycle, RESTART_GOODBYE_MESSAGES, RESTART_WELCOME_MESSAGES } from './bot-lifecycle.js';
import { TwitchVipService } from './twitch-vip.js';
import { VipExperience } from './vip-experience.js';

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
  const botLifecycle = new BotLifecycle(features);
  const returnMarker = botLifecycle.takeReturnCandidate(Date.now());
  const lifecycleAbort = new AbortController();
  let returnAttemptStarted = false;
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
  const vipOauth = new TwitchOAuth(config.clientId,config.clientSecret,config.vipRedirectUri,['channel:read:vips'],
    new FileTokenStore(config.vipTokenFile));
  const vipService = new TwitchVipService(config.clientId,config.broadcasterUserId,vipOauth);
  const vipExperience = new VipExperience(features);
  const oauthServer = new OAuthCallbackServer(config.oauthHost, config.oauthPort, config.oauthStateTtlMs, oauth, logger,
    [{name:'channel-points',oauth:redemptionOauth,callbackPath:'/oauth/redemptions/callback',stateFilePath:`${config.redemptionTokenFile}.oauth-state`},
      {name:'vip-verification',oauth:vipOauth,startPath:'/oauth/vips/start',callbackPath:'/oauth/vips/callback',stateFilePath:`${config.vipTokenFile}.oauth-state`}],
    `${config.tokenFile}.oauth-state`);
  const game = new GameService(database, config);
  const chatPolicy = new ChatResponsePolicy(features.config('chat_response_settings', DEFAULT_CHAT_RESPONSE_SETTINGS));
  const communityTips = new CommunityTips(features);
  const automaticChatMessages = new AutomaticChatMessages(features);
  const handler = new CommandHandler(database, game, config, undefined, community, chatPolicy, communityTips);
  let lastChatReceiveAt:number|undefined,lastBotChatSendAt:number|undefined,lastBotChatSendErrorAt:number|undefined;
  const queue = new SendQueue(
    async (message, replyParentMessageId) => {
      const result = await sendChatMessageWithRetry(api, config.broadcasterUserId, config.botUserId, message, replyParentMessageId);
      if (!result.isSent) { lastBotChatSendErrorAt=Date.now();logger.warn('Twitch hat die Antwort verworfen.', { reason: result.dropReason || 'unbekannt' }); }
      else { lastBotChatSendAt=Date.now();logger.info('Twitch hat die Chatantwort angenommen.'); }
      if(!result.isSent)throw new Error(result.dropReason||'Twitch hat die Chatnachricht nicht angenommen.');
      return { accepted: true, rateLimitedRetries: result.rateLimitedRetries };
    },
    Math.max(1500, config.sendQueueIntervalMs),
    logger,
    config.maxChatMessageLength,
  );
  let channelPoints:ChannelPointsService|undefined;
  let songRequests:SpotifySongRequests|undefined;
  let lastSpecialAnnouncementAt = botStartedAt;
  let lastKnownStreamLive:boolean|undefined;
  let lastStreamSnapshot:TwitchStream|undefined;
  let broadcasterProfileImageUrl='';
  let streamStatusCheckedAt=0;
  const recordStreamStatus=(stream:TwitchStream|undefined)=>{const live=Boolean(stream),now=Date.now();features.recordDiscordLiveTransition(live,stream?{id:stream.id,...(stream.title?{title:stream.title}:{}),...(stream.game_name?{game_name:stream.game_name}:{}),...(typeof stream.viewer_count==='number'?{viewer_count:stream.viewer_count}:{}),...(stream.started_at?{started_at:stream.started_at}:{}),...(stream.thumbnail_url?{thumbnail_url:stream.thumbnail_url}:{}),...(broadcasterProfileImageUrl?{profile_image_url:broadcasterProfileImageUrl}:{})}:undefined,now);lastKnownStreamLive=live;lastStreamSnapshot=stream;streamStatusCheckedAt=now;community.arcade.setCurrentStreamId(stream?.id);};
  const recordStreamStatusError=()=>{lastKnownStreamLive=undefined;lastStreamSnapshot=undefined;streamStatusCheckedAt=Date.now();community.arcade.setCurrentStreamId(undefined);};
  const eventsub = new EventSubClient(
    async (sessionId) => {
      await api.ensureChatSubscription(sessionId, config.broadcasterUserId, config.botUserId);
      try { await api.ensureLiveSubscriptions(sessionId, config.broadcasterUserId); }
      catch(error) { logger.warn('Twitch-Live-EventSub konnte nicht aktiviert werden; der regelmäßige Helix-Abgleich bleibt aktiv.', { error: error instanceof Error ? error.message : 'unbekannt' }); }
      if(channelPoints)try{await channelPoints.ensureSubscription(sessionId);}
      catch(error){logger.warn('Kanalpunkte-EventSub konnte nicht aktiviert werden; Chatbetrieb läuft weiter.',{error:error instanceof Error?error.message:'unbekannt'});}
      if(songRequests)try{await songRequests.ensureSubscription(sessionId);}
      catch(error){logger.warn('Song-Request-EventSub konnte nicht aktiviert werden; übriger Chatbetrieb läuft weiter.',{error:error instanceof Error?error.message:'unbekannt'});}
      if(returnMarker&&!returnAttemptStarted){
        returnAttemptStarted=true;
        void (async()=>{
          try{await delay(20_000,undefined,{signal:lifecycleAbort.signal});}catch{return;}
          const currentMarker=botLifecycle.marker();
          if(!botLifecycle.settings().enabled||currentMarker?.id!==returnMarker.id||currentMarker.phase!=='returning'){botLifecycle.finishWelcome(returnMarker.id,'skipped');return;}
          if(!eventsub.isConnected){botLifecycle.finishWelcome(returnMarker.id,'skipped');return;}
          let streamLive=false;
          try{streamLive=Boolean(await api.getStreamStatus(config.broadcasterUserId));}catch{botLifecycle.finishWelcome(returnMarker.id,'skipped');return;}
          const finalMarker=botLifecycle.marker();
          if(!streamLive||!eventsub.isConnected||!botLifecycle.settings().enabled||finalMarker?.id!==returnMarker.id||finalMarker.phase!=='returning'){botLifecycle.finishWelcome(returnMarker.id,'skipped');return;}
          const message=RESTART_WELCOME_MESSAGES[randomInt(RESTART_WELCOME_MESSAGES.length)]!;
          try{const accepted=await queue.enqueue(message,undefined,'info');botLifecycle.finishWelcome(returnMarker.id,accepted?'accepted':'failed');if(!accepted)logger.warn('Neustart-Rückkehr wurde nicht von der Chat-Sendewarteschlange bestätigt.',{restartId:returnMarker.id});}
          catch(error){botLifecycle.finishWelcome(returnMarker.id,'failed');logger.warn('Neustart-Rückkehr konnte nicht an Twitch übergeben werden.',{restartId:returnMarker.id,error:error instanceof Error?error.message:'unbekannt'});}
        })();
      }
    },
    async (rawMessage) => {
      const payload=rawMessage.payload as Record<string,unknown>|undefined;
      const subscription=payload?.subscription as Record<string,unknown>|undefined;
      if(['stream.online','stream.offline','channel.update'].includes(String(subscription?.type||''))){
        try {
          const stream=await api.getStreamStatus(config.broadcasterUserId);
          recordStreamStatus(stream);
        } catch(error) {
          logger.warn('Twitch-Live-Ereignis konnte nicht mit dem aktuellen Streamstatus abgeglichen werden.',{subscriptionType:subscription?.type,error:error instanceof Error?error.message:'unbekannt'});
        }
        return;
      }
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
      lastChatReceiveAt=chatMessage.sentAt;
      let replies;
      communityTips.observe(chatMessage);
      community.vault.observeActivity(chatMessage);
      try { replies = await handler.handle(chatMessage); }
      catch(error){logger.error('Twitch-Chatnachricht konnte im Command-Handler nicht verarbeitet werden.',{error:error instanceof Error?error.message:'unbekannt'});return;}
      const command=chatMessage.message.trim().split(/\s+/u)[0]?.toLowerCase()||'';
      if(command.startsWith('!'))logger.info('Twitch-Chatbefehl verarbeitet.',{command:/^![a-z0-9_-]{1,32}$/u.test(command)?command:'!other',replyCount:replies.length});
      for (const [replyIndex, reply] of replies.entries()) {
        if (['drop','wheel','imposter','detective','quest','poll','season','pet','boss','attack','help','communityPortal','vault'].includes(reply.category || '')) lastSpecialAnnouncementAt = Date.now();
        // Reward-bearing seasonal outcomes are written to the durable outbox
        // in the same SQLite transaction as the reward. The ticker is their
        // only sender, so a process restart cannot lose or double-queue them.
        if (reply.durableDeliveryId) continue;
        if (!chatPolicy.shouldSend({ command: command.startsWith('!') ? command : '', message: reply.message, senderUserId: chatMessage.senderUserId })) continue;
        void queue.enqueue(reply.message, reply.replyParentMessageId, reply.category, {
          id: `eventsub:${chatMessage.eventId}:${replyIndex}`, expiresAt: Date.now() + 60_000,
        }).catch(() => { /* Persisted game results remain authoritative when delivery fails. */ });
      }
    },
  );
  let dashboard:DashboardServer|undefined;
  let lastLiveControlPollAt=0,checkingLiveControl=false;
  let lastTipLiveCheckAt = 0;
  let checkingLive = false;
  const communityPortalHealth=new CommunityPortalHealth(new URL('/community',config.redirectUri).toString());
  const runFeatureTick = singleFlight(async () => {
      try {
        const tickNow=Date.now();
        features.activeBoss(tickNow);
        if(!checkingLiveControl&&tickNow-lastLiveControlPollAt>=30_000){
          checkingLiveControl=true;lastLiveControlPollAt=tickNow;
          try{recordStreamStatus(await api.getStreamStatus(config.broadcasterUserId));}
          catch(error){recordStreamStatusError();logger.warn('Live-Control konnte Twitch-Status nicht aktualisieren.',{error:error instanceof Error?error.message:'unbekannt'});}
          finally{checkingLiveControl=false;}
        }
        const announcements = community.tickMessages();
        for (const message of announcements) {
          void queue.enqueue(message.message, undefined, message.category).catch(error =>
            logger.warn('Automatische Spielmeldung konnte nicht gesendet werden; der gespeicherte Spielzustand bleibt erhalten.', { error: error instanceof Error ? error.message : 'unbekannt' }));
        }
        for(const result of features.claimBossResultMessages(tickNow)){
          void queue.enqueue(result.message,undefined,'boss',{id:`boss-result:${result.id}:${result.attempt}`,expiresAt:Date.now()+15*60_000})
            .then(accepted=>features.finishBossResultDelivery(result.id,accepted,Date.now(),accepted?'':'Chatwarteschlange hat die Ergebnisnachricht nicht übernommen.'))
            .catch(()=>features.finishBossResultDelivery(result.id,false,Date.now(),'Twitch hat die Ergebnisnachricht nicht bestätigt.'));
        }
        for(const result of features.claimChatDeliveryMessages(tickNow)){
          void queue.enqueue(result.message,result.replyParentMessageId,result.category,{
            id:`seasonal-result:${result.id}:${result.attempt}`,priority:85,expiresAt:result.expiresAt,
          }).then(accepted=>features.finishChatDelivery(result.id,accepted,Date.now(),accepted?'':'Chatwarteschlange hat die Ergebnisnachricht nicht übernommen.'))
            .catch(()=>features.finishChatDelivery(result.id,false,Date.now(),'Twitch hat die Ergebnisnachricht nicht bestätigt.'));
        }
        if (announcements.length) { lastSpecialAnnouncementAt = Date.now(); return; }
        const now = Date.now();
        const snapshots = community.miniGames.snapshot();
        const arcade = community.arcade.snapshot('drop');
        const wheel = community.arcade.wheelStatus();
        const dropStatus = (arcade.drop as { status?: string } | undefined)?.status;
        const busy = Boolean(snapshots.imposter || snapshots.detective || community.vault.isActive(now) || features.activeQuest() || features.activePoll(now) || features.activeBoss(now)
          || ['announced','claiming','resolving'].includes(dropStatus || '') || wheel.active
          || community.interactive.active().some(event=>event.status==='open') || Boolean(community.chaos.status(now).active) || Boolean(community.activeEventId())
          || queue.busy || now - lastSpecialAnnouncementAt < 60_000);
        if(lastKnownStreamLive!==undefined&&Date.now()-streamStatusCheckedAt<45_000){
          const directorAction=community.runEventDirector(lastKnownStreamLive,busy,now);
          if(directorAction){lastSpecialAnnouncementAt=now;void queue.enqueue(directorAction.message,undefined,directorAction.category).then(sent=>{if(directorAction.chaosEventId){if(sent)community.chaos.markAnnouncementSent(directorAction.chaosEventId);else community.chaos.releaseStartAnnouncement(directorAction.chaosEventId);}}).catch(error=>{if(directorAction.chaosEventId)community.chaos.releaseStartAnnouncement(directorAction.chaosEventId);logger.warn('Event-Director-Ankündigung konnte nicht gesendet werden.',{eventType:directorAction.category,error:error instanceof Error?error.message:'unbekannt'});});return;}
        }
        const chaosStart=community.chaos.claimStartAnnouncement();
        if(chaosStart)void queue.enqueue(chaosStart.prompt,undefined,'community').then(sent=>{if(sent)community.chaos.markAnnouncementSent(chaosStart.id);else community.chaos.releaseStartAnnouncement(chaosStart.id);}).catch(error=>{community.chaos.releaseStartAnnouncement(chaosStart.id);logger.warn('Community-Chaos-Startmeldung konnte nicht gesendet werden.',{error:error instanceof Error?error.message:'unbekannt'});});
        const profile = chatPolicy.snapshot().profile, availability = {...community.helpAvailability(),communityPortal:communityTips.settings().portalEnabled};
        const dueMessage=automaticChatMessages.hasDue(now,communityTips.eligibleActivityMessages,busy);
        const wantsTip=communityTips.shouldEvaluate(profile,availability,busy,now)&&automaticChatMessages.canReserveGlobalSlot(now);
        if (!checkingLive && now - lastTipLiveCheckAt >= 15_000 && (Boolean(dueMessage)||wantsTip)) {
          checkingLive = true;
          try {
            lastTipLiveCheckAt = Date.now();
            const stream = await api.getStreamStatus(config.broadcasterUserId);recordStreamStatus(stream);
            if (!stream) { communityTips.alignStream(null);communityTips.maybeSend({ isLive: false, profile, availability, busy, now: Date.now() }); }
            else {
              communityTips.alignStream(stream.id);
              if(communityTips.settings().portalEnabled)availability.communityPortal=await communityPortalHealth.isAvailable();
              const currentState=community.miniGames.snapshot(),currentDrop=community.arcade.snapshot('drop'),currentWheel=community.arcade.wheelStatus();
              const currentDropStatus=(currentDrop.drop as {status?:string}|undefined)?.status;
              const currentBusy=Boolean(currentState.imposter||currentState.detective||community.vault.isActive(Date.now())||features.activeQuest()||features.activePoll(Date.now())||features.activeBoss(Date.now())
                ||['announced','claiming','resolving'].includes(currentDropStatus||'')||currentWheel.active||queue.busy||Date.now()-lastSpecialAnnouncementAt<60_000);
              const currentDue=automaticChatMessages.nextDue(Date.now(),communityTips.eligibleActivityMessages,currentBusy,true);
              if(currentDue&&chatPolicy.shouldSend({message:currentDue.message,now:Date.now()})&&automaticChatMessages.reserveMessageAttempt(currentDue.id,Date.now())){
                communityTips.consumeActivity();
                try{const sent=await queue.enqueue(currentDue.message,undefined,'info');if(sent)automaticChatMessages.markSent(currentDue.id,Date.now());else automaticChatMessages.markFailed(currentDue.id,Date.now());}
                catch(error){automaticChatMessages.markFailed(currentDue.id,Date.now());logger.warn('Automatische Chatnachricht konnte nicht gesendet werden; nächster Versuch frühestens nach dem Nachrichtenintervall.',{error:error instanceof Error?error.message:'unbekannt'});}
              }else if(!currentBusy&&wantsTip){
                const tip = communityTips.maybeSend({ isLive: true, streamId: stream.id, profile, availability, busy:currentBusy, now: Date.now(),
                  allowSend: candidate => chatPolicy.shouldSend({ message: candidate.text, now: Date.now() })&&automaticChatMessages.reserveGlobalSlot(Date.now()) });
                if(tip){
                  communityTips.consumeActivity();
                  try{const sent=await queue.enqueue(tip.text,undefined,'tip');if(sent)communityTips.markDelivered(tip,Date.now());}catch(error){logger.warn('Community-Tipp konnte nicht in den Chat gestellt werden.',{error:error instanceof Error?error.message:'unbekannt'});}
                }
              }
            }
          }
          catch (error) {
            recordStreamStatusError();
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
    try{await vipOauth.initialize();}
    catch(error){logger.warn('Optionales Twitch-VIP-Token konnte nicht geladen werden; VIP-Aktionen bleiben gesperrt.',{error:error instanceof Error?error.message:'unbekannt'});}
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
    broadcasterProfileImageUrl=broadcaster.profile_image_url||'';
    vipService.setBroadcasterId(broadcaster.id);
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
    const viewerPortal=new ViewerCommunityPortal(features,community,{...config,redirectUri:process.env.DASHBOARD_REDIRECT_URI?.trim()||config.redirectUri},fetch,vipService,vipExperience,()=>lastStreamSnapshot?{id:lastStreamSnapshot.id,live:lastKnownStreamLive===true}:undefined);
    dashboard = new DashboardServer(features, () => {const chatDispatch=queue.snapshot(),durable=features.chatDeliverySnapshot();return ({twitchConnected:eventsub.isConnected,channel:config.channelLogin,channelProfileImageUrl:broadcasterProfileImageUrl,startedAt:botStartedAt,...chatDispatch,chatDispatch:{...chatDispatch,durablePending:durable.pending,durableFailed:durable.failed,durableExpired:durable.expired},chatResponse:chatPolicy.snapshot(),streamLive:lastKnownStreamLive,streamStatusCheckedAt,...(lastStreamSnapshot?{streamSnapshot:{id:lastStreamSnapshot.id,...(lastStreamSnapshot.title?{title:lastStreamSnapshot.title}:{}),...(lastStreamSnapshot.game_name?{gameName:lastStreamSnapshot.game_name}:{}),...(typeof lastStreamSnapshot.viewer_count==='number'?{viewerCount:lastStreamSnapshot.viewer_count}:{}),...(lastStreamSnapshot.started_at?{startedAt:lastStreamSnapshot.started_at}:{}),...(lastStreamSnapshot.thumbnail_url?{thumbnailUrl:lastStreamSnapshot.thumbnail_url}:{})}}:{}),...(lastChatReceiveAt?{lastChatReceiveAt}:{}),...(lastBotChatSendAt?{lastBotChatSendAt}:{}),...(lastBotChatSendErrorAt?{lastBotChatSendErrorAt}:{})});},
      logger,fetch,()=>community.conversationSpark.snapshot(),channelPoints,()=>oauthServer.startUrlFor('channel-points'),community.miniGames,community.arcade,
      async(message,category)=>{if(!chatPolicy.shouldSend({message,now:Date.now()}))return;await queue.enqueue(message,undefined,category);},chatPolicy,communityTips,automaticChatMessages,songRequests,viewerPortal,community.vault,
      async()=>{const now=Date.now(),settings=community.vault.settings();if(!settings.enabled)return 'Der Community-Tresor ist ausgeschaltet. Aktiviere ihn zuerst in den Einstellungen.';const remaining=community.vault.cooldownRemainingMs(now);if(remaining>0)return `⏳ Der globale Tresor-Cooldown läuft noch ${Math.ceil(remaining/60_000)} Min.`;if(community.vault.isActive(now))return '⏳ Der Tresor läuft bereits.';const stream=await api.getStreamStatus(config.broadcasterUserId);recordStreamStatus(stream);if(!stream)return '📴 Der Twitch-Stream ist derzeit offline.';const active=community.vault.activeViewerCount(now),minimum=settings.minActiveViewers;if(active<minimum)return `⏳ Der Start braucht ${minimum} aktive Zuschauer; aktuell sind ${active} bestätigt.`;const wait=5*60_000-(now-lastSpecialAnnouncementAt);if(wait>0)return `⏳ Nach einer wichtigen Chat-Aktion bitte noch ${Math.ceil(wait/60_000)} Min. warten.`;const game=community.miniGames.snapshot(),drop=community.arcade.snapshot('drop'),wheel=community.arcade.wheelStatus(),dropStatus=(drop.drop as {status?:string}|undefined)?.status;if(game.imposter||game.detective||features.activeQuest()||features.activePoll(now)||features.activeBoss(now)||['announced','claiming','resolving'].includes(dropStatus||'')||wheel.active)return '⏳ Ein anderes Community-Spiel läuft gerade.';if(queue.busy)return '⏳ Der Chat verarbeitet gerade eine wichtige Meldung.';return true;},
      community.moderatorPranks,async(login)=>{const user=(await api.getUsers([login]))[0];return user?{id:user.id,login:user.login,displayName:user.display_name}:undefined;},
      {weights:config.eventWeights,source:process.env.EVENT_WEIGHTS_JSON?.trim()?'EVENT_WEIGHTS_JSON (beim Bot-Start geladen)':'Standardwerte aus src/config.ts'},
      ()=>communityPortalHealth.isAvailable(),botLifecycle,vipService,vipExperience,()=>oauthServer.startUrlFor('vip-verification'),community.eventDirector);
    dashboard.setDiscordGameHandler((message,game,args,now)=>community.discordGameReply(message,game,args,now));
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

  let shutdownPromise:Promise<void>|undefined;
  const shutdown = ():Promise<void> => {
    if(shutdownPromise)return shutdownPromise;
    shutdownPromise=(async()=>{
      clearInterval(featureTicker);lifecycleAbort.abort();
      const currentMarker=botLifecycle.marker();let confirmedLive=false;
      if(botLifecycle.settings().enabled&&currentMarker?.phase==='armed'&&eventsub.isConnected){
        let timeout:NodeJS.Timeout|undefined;
        try{confirmedLive=Boolean(await Promise.race([api.getStreamStatus(config.broadcasterUserId),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Streamstatus nicht rechtzeitig bestätigt.')),3500);})]));}
        catch{confirmedLive=false;}finally{if(timeout)clearTimeout(timeout);}
      }
      const marker=botLifecycle.beginShutdown(Date.now(),confirmedLive&&eventsub.isConnected);
      if(marker?.returnAllowed){
        let timeout:NodeJS.Timeout|undefined;
        try{
          const message=RESTART_GOODBYE_MESSAGES[randomInt(RESTART_GOODBYE_MESSAGES.length)]!;
          const accepted=await Promise.race([queue.enqueue(message,undefined,'info'),new Promise<boolean>(resolve=>{timeout=setTimeout(()=>resolve(false),4000);})]);
          botLifecycle.finishFarewell(marker.id,accepted?'accepted':'failed');
          if(!accepted)logger.warn('Neustart-Abschied wurde nicht von der Chat-Sendewarteschlange bestätigt.',{restartId:marker.id});
        }catch(error){botLifecycle.finishFarewell(marker.id,'failed');logger.warn('Neustart-Abschied konnte nicht an Twitch übergeben werden.',{restartId:marker.id,error:error instanceof Error?error.message:'unbekannt'});}finally{if(timeout)clearTimeout(timeout);}
      }
      await eventsub.stop();
      await dashboard?.stop();
      await oauthServer.stop();
      if(marker)botLifecycle.completeShutdown(marker.id);
      features.close();
      database.close();
    })();
    return shutdownPromise;
  };
  const terminate=()=>{void shutdown().then(()=>process.exit(0)).catch(error=>{logger.error('Geordnetes Herunterfahren fehlgeschlagen.',{error:error instanceof Error?error.message:'unbekannt'});process.exit(1);});};
  process.once('SIGINT',terminate);
  process.once('SIGTERM',terminate);
}

async function sendChatMessageWithRetry(
  api: TwitchApi,
  broadcasterId: string,
  senderId: string,
  message: string,
  replyParentMessageId?: string,
) {
  let rateLimitedRetries = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await api.sendChatMessage(broadcasterId, senderId, message, replyParentMessageId);
      return { ...result, rateLimitedRetries };
    } catch (error) {
      if (!(error instanceof TwitchApiError) || error.status !== 429) throw error;
      rateLimitedRetries++;
      if(attempt===2){Object.assign(error,{rateLimitedRetries});throw error;}
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
