import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { AppConfig, ChatMessage, CommandReply } from './types.js';
import { clampChatMessage } from './chat.js';
import { FeatureStore, type CustomCommand } from './feature-store.js';
import { QuestPollFeatures } from './quest-poll.js';
import { ConversationSpark } from './conversation-spark.js';
import { MiniGames } from './mini-games.js';
import { CommunityArcade } from './community-arcade.js';
import { CommunityInteractive } from './community-interactive.js';
import { CommunityChaos, CHAOS_GAMES, type ChaosGame } from './community-chaos.js';
import { ElioChronicles } from './elio-chronicles.js';
import { CommunityVault } from './community-vault.js';
import { CommunityHauntedHouse } from './community-haunted-house.js';
import { EventDirector, adaptiveBossHp, type EventCandidate } from './event-director.js';
import { findActiveCommunityEventConflict } from './community-event-conflicts.js';
import { ModeratorPranks } from './moderator-pranks.js';
import { categoryForCommand, type ChatCategory } from './chat-message-format.js';
import type { OutboundChatMessage } from './chat-message-format.js';
import type { HelpAvailability } from './help.js';
import { chooseEightBallAnswer, DEFAULT_EIGHT_BALL_SETTINGS, EIGHT_BALL_ANSWERS } from './eight-ball-answers.js';
import { formatPollAnnouncement } from './poll-announcement.js';

type UserLookup = (login: string) => Promise<{ id: string; login: string; displayName: string } | undefined>;
type RandomInclusive = (min: number, max: number) => number;

const LEVEL_TITLES: Record<number, string> = { 1: 'Neueinsteiger', 5: 'Stammgast', 10: 'Community-Mitglied', 20: 'Veteran', 50: 'Legende' };
export class CommunityFeatures {
  private readonly questPoll: QuestPollFeatures;
  readonly conversationSpark: ConversationSpark;
  readonly miniGames: MiniGames;
  readonly arcade: CommunityArcade;
  readonly interactive:CommunityInteractive;
  readonly chaos:CommunityChaos;
  readonly chronicles:ElioChronicles;
  readonly vault: CommunityVault;
  readonly moderatorPranks: ModeratorPranks;
  readonly hauntedHouse: CommunityHauntedHouse;
  readonly eventDirector: EventDirector;

  constructor(
    private readonly store: FeatureStore,
    private readonly config: AppConfig,
    private readonly lookupUser: UserLookup = async () => undefined,
    private readonly random: RandomInclusive = secureRandomInclusive,
  ) { this.questPoll = new QuestPollFeatures(store, config); this.conversationSpark = new ConversationSpark(store, config.broadcasterUserId); this.miniGames = new MiniGames(store, config); this.arcade = new CommunityArcade(store,config.broadcasterUserId); this.interactive=new CommunityInteractive(store); this.chaos=new CommunityChaos(store); this.chronicles=new ElioChronicles(store,this.chaos); this.vault = new CommunityVault(store,config.botUserId); this.hauntedHouse=new CommunityHauntedHouse(store); this.eventDirector=new EventDirector(store); this.moderatorPranks = new ModeratorPranks(store,()=>((this.vault.publicSnapshot().vault as {status?:string}|undefined)?.status==='active'),ignoreVault=>this.isMajorGameBusy(ignoreVault)); }

  private isMajorGameBusy(ignoreVault = false):boolean {
    const now=Date.now(),mini=this.miniGames.snapshot(),drop=this.arcade.snapshot('drop'),wheel=this.arcade.wheelStatus();
    const status=(drop.drop as {status?:string}|undefined)?.status;
    return Boolean(mini.imposter||mini.detective||this.store.activeQuest()||this.store.activePoll(now)||this.store.activeBoss(now)
      ||['announced','claiming','resolving'].includes(status||'')||wheel.active||(!ignoreVault&&this.vault.isActive(now))
      ||this.chaos.status(now).active||this.interactive.active().some(event=>event.status==='open'&&event.kind!=='game_night'));
  }

  observeActivity(message: ChatMessage, now = Date.now()): string | undefined {
    this.eventDirector.observe(message,now,[this.config.botUserId,this.config.broadcasterUserId]);
    if (message.senderUserId === this.config.botUserId || message.senderLogin.toLowerCase() === this.config.botLogin.toLowerCase()) return undefined;
    const text = message.message.trim().replace(/\s+/gu, ' ');
    if (text.startsWith('!') || Array.from(text).length < 3) return undefined;
    this.conversationSpark.observe(message, now);
    const settings = this.store.config('xp_settings', { activityXp: 5, activityCooldownMs: 60_000, dailyGameCap: 100, levelBase: 100 });
    const fingerprint = createHash('sha256').update(text.toLocaleLowerCase()).digest('hex');
    this.store.awardActivity(message.senderUserId, message.senderDisplayName, fingerprint, message.eventId, now,
      settings.activityXp, settings.activityCooldownMs);
    return undefined;
  }

  eventDirectorStatus(now=Date.now(),reason='') { return {...this.eventDirector.snapshot(now,reason),active:this.currentInteractiveStatus(now)}; }
  updateEventDirectorSettings(input:Record<string,unknown>) {
    const chaos=this.chaos.settings(),story=this.chronicles.settings(),interactive=this.interactive.settings(),arcade=this.arcade.settings();
    if(input.autoChaos===true&&!chaos.enabled)throw new Error('Community-Chaos muss zuerst im vorhandenen Modul aktiviert werden.');
    if(input.autoStories===true&&!story.enabled)throw new Error('Elio Chronicles muss zuerst im vorhandenen Modul freigegeben werden.');
    if(input.autoSecretEvents===true&&!interactive.secretEventsEnabled)throw new Error('Geheime Community-Events müssen zuerst im vorhandenen Modul aktiviert werden.');
    if(input.autoDrops===true&&!arcade.dropsEnabled)throw new Error('Mystery Drops müssen zuerst im vorhandenen Modul aktiviert werden.');
    if(input.autoWheel===true&&!arcade.wheelEnabled)throw new Error('Das bestehende Chaos Wheel muss zuerst aktiviert werden.');
    const next=this.eventDirector.updateSettings(input);
    // Before timer separation, enabling Chronicles also enabled its intervening
    // Chaos minigames. Keep that shipped behavior while making the story timer independent.
    this.chaos.updateSettings({...chaos,autoEnabled:chaos.enabled&&(next.autoChaos||next.autoStories)});
    this.chronicles.updateSettings({...story,autoEnabled:next.autoStories});
    this.interactive.updateSettings({...interactive,autoSecretEventsEnabled:next.autoSecretEvents});
    this.chaos.updateSettings({...this.chaos.settings(),discordAnnouncements:next.discordAnnouncements});
    if(next.autoDrops&&!arcade.autoDrops)this.arcade.updateSettings({...arcade,autoDrops:true});
    return next;
  }
  runEventDirector(live:boolean,busy:boolean,now=Date.now()):{message:string;category:'boss'|'drop'|'wheel'|'community';chaosEventId?:string}|undefined {
    return this.store.miniGameImmediateTransaction(()=>{
    // Candidate readiness methods can advance persistent timers. Read the pause
    // before evaluating any candidate, under the same SQLite write lock used
    // for starts, so startup/reconnect ticks cannot mutate or resume work first.
    if(this.eventDirector.settings().paused){this.eventDirector.run({live,busy,now,candidates:[]});return undefined;}
    const cfg=this.eventDirector.settings(),activity=this.eventDirector.activity(now),modules=this.store.config<Record<string,boolean>>('modules',{});
    const candidates:EventCandidate[]=[];
    const chaosCfg=this.chaos.settings(),storyCfg=this.chronicles.settings();
    candidates.push({type:'community-chaos',priority:4,enabled:(cfg.autoChaos||cfg.autoStories)&&chaosCfg.enabled&&chaosCfg.autoEnabled,ready:this.chaos.automaticReady(now),minimumActivity:'low',start:()=>this.chaos.startAutomatic(now,false)?.message,manualStart:(actor,payload)=>{const game=payload.game;if(typeof game!=='string'||!CHAOS_GAMES.includes(game as ChaosGame))throw new Error('Wähle ein verfügbares Community-Chaos-Minispiel aus.');return this.chaos.start(game as ChaosGame,actor,now,false).prompt;},interval:{min:chaosCfg.minIntervalMs,max:chaosCfg.minIntervalMs+chaosCfg.randomDelayMs},intervalKey:'community-chaos'});
    candidates.push({type:'elio-chronicles',priority:1,enabled:cfg.autoStories&&storyCfg.enabled&&storyCfg.autoEnabled,ready:this.chronicles.automaticReady(now,live),minimumActivity:'low',start:()=>this.chronicles.startAutomatic(now).prompt,manualStart:(actor,payload)=>this.chronicles.startNext(actor,typeof payload.missionId==='string'?payload.missionId:undefined,now,false).prompt,interval:{min:storyCfg.automaticIntervalMs,max:storyCfg.automaticIntervalMs},intervalKey:'elio-chronicles'});
    const secretSettings=this.interactive.settings();
    candidates.push({type:'secret-event',priority:5,enabled:cfg.autoSecretEvents&&secretSettings.secretEventsEnabled&&secretSettings.autoSecretEventsEnabled,
      ready:!this.interactive.active(undefined,now).some(event=>event.status==='open'),minimumActivity:'normal',start:()=>this.interactive.startAutomaticSecretEvent(now,activity.uniqueChatters15m)?'🎁 Ein geheimes Community-Event beginnt! Schaut auf die Community-Seite.':undefined,manualStart:(actor,payload)=>{const kind=payload.kind==='elio_rescue'||payload.kind==='secret_portal'?payload.kind:'mystery_case';const result=this.interactive.createSecretEvent(kind,actor,{title:typeof payload.title==='string'?payload.title:'Ein mysteriöser Koffer ist aufgetaucht',description:typeof payload.description==='string'?payload.description:''},now);return result.ok?result.message:undefined;}});
    const bossSettings=this.store.config('game_settings',{bossHp:1000,bossDurationMs:900_000}),activeBoss=this.store.activeBoss(now);
    const bossFinishedAt=this.store.miniGameQuery(db=>(db.prepare("SELECT MAX(finished_at) at FROM boss_fights WHERE status IN ('defeated','timeout','canceled')").get() as {at:number|null}).at||undefined);
    const bossDue=this.eventDirector.intervalDue('boss',now,cfg.bossMinIntervalMs,cfg.bossMaxIntervalMs,cfg.autoBosses&&modules.boss!==false,live,Boolean(activeBoss),bossFinishedAt);
    const startBoss=()=>{
      const active=activity.uniqueChatters5m;
      const recent=this.store.miniGameQuery(db=>db.prepare(`SELECT fight.status,COUNT(DISTINCT participant.user_id) participants,
        COALESCE(AVG(participant.damage),0) averageDamage,MAX(0,fight.finished_at-fight.started_at) durationMs FROM (
        SELECT id,status,started_at,finished_at FROM boss_fights WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 10
      ) fight LEFT JOIN boss_participants participant ON participant.boss_id=fight.id GROUP BY fight.id ORDER BY MAX(fight.finished_at) DESC`).all() as Array<{status:string;participants:number;averageDamage:number;durationMs:number}>);
      const hp=adaptiveBossHp(active,recent,cfg.bossAdaptiveHp),names=active<=3?['Kleiner Schattenpfoten-Späher']:active<=8?['Schattenwächter']:active<=15?['Portalwächter']:['Schattenkönig'];
      const name=names[this.random(0,names.length-1)]!;
      if(!this.store.startBoss(randomUUID(),name,hp,bossSettings.bossDurationMs,now))return undefined;
      return `👹 ${name} erscheint mit ${hp} HP! Besiegt ihn gemeinsam mit !attack!`;
    };
    candidates.push({type:'boss',priority:3,enabled:cfg.autoBosses&&modules.boss!==false,ready:bossDue&&!activeBoss,minimumActivity:'normal',interval:{min:cfg.bossMinIntervalMs,max:cfg.bossMaxIntervalMs,afterCompletion:true},start:startBoss,manualStart:()=>{if(modules.boss===false)throw new Error('Community-Bosse sind im vorhandenen Funktionsmodul ausgeschaltet.');return startBoss();}});
    const arcadeSettings=this.arcade.settings(),drop=this.arcade.snapshot('drop'),dropStatus=(drop.drop as {status?:string}|undefined)?.status;
    const dropDue=this.eventDirector.intervalDue('drop',now,60*60_000,90*60_000,cfg.autoDrops&&arcadeSettings.dropsEnabled&&arcadeSettings.autoDrops,live,false,undefined,'mystery-drop');
    candidates.push({type:'mystery-drop',priority:6,enabled:cfg.autoDrops&&arcadeSettings.dropsEnabled&&arcadeSettings.autoDrops,ready:dropDue&&!['announced','claiming','resolving'].includes(dropStatus||''),minimumActivity:'normal',interval:{min:60*60_000,max:90*60_000},intervalKey:'drop',manualStart:actor=>this.arcade.startDropAdmin(actor,'common',now),start:()=>{
      const before=(this.arcade.snapshot('drop').drop as {id?:string}|undefined)?.id;
      const message=this.arcade.startDropAdmin('event-director','common',now);
      const after=this.arcade.snapshot('drop').drop as {id?:string}|undefined;return after?.id&&after.id!==before?message:undefined;
    }});
    const wheelStatus=this.arcade.wheelStatus(now) as {enabled:boolean;autoPilotEnabled:boolean;canSpin:boolean;autoSpinDue:boolean};
    candidates.push({type:'chaos-wheel',priority:7,enabled:cfg.autoWheel&&wheelStatus.enabled&&wheelStatus.autoPilotEnabled,ready:wheelStatus.canSpin&&wheelStatus.autoSpinDue,minimumActivity:'high',start:()=>this.arcade.autoSpinIfDue(now),manualStart:actor=>this.arcade.spinAdmin(actor,now)});
    candidates.push({type:'chat-imposter',priority:10,enabled:false,ready:false,start:()=>undefined,manualStart:actor=>this.miniGames.startImposter(actor,now)});
    candidates.push({type:'chat-detective',priority:11,enabled:false,ready:false,start:()=>undefined,manualStart:()=>this.miniGames.startDetective(now)});
    candidates.push({type:'community-quest',priority:9,enabled:false,ready:false,start:()=>undefined,manualStart:actor=>this.questPoll.startNextApproved(actor,now).message});
    const vaultReady=this.vault.autoStartReady(now,this.vault.activeViewerCount(now),busy,0);
    candidates.push({type:'community-vault',priority:8,enabled:cfg.enabled&&this.vault.settings().enabled&&this.vault.settings().autoStart,ready:vaultReady,minimumActivity:'normal',start:()=>{const result=this.vault.startAutomatic(now);return result.ok?result.message:undefined;},manualStart:()=>{const result=this.vault.startManual(now);return result.ok?result.message:undefined;}});
    const result=this.eventDirector.run({live,busy,now,candidates});
    if(!live){this.chaos.pauseAutomatic(now);}
    if(result){const category=result.type==='boss'?'boss':result.type==='mystery-drop'?'drop':result.type==='chaos-wheel'?'wheel':'community';if(result.type==='community-chaos'||result.type==='elio-chronicles'){const announcement=this.chaos.claimStartAnnouncement(now);return {message:announcement?.prompt||result.message,category,...(announcement?{chaosEventId:announcement.id}:{})};}return {message:result.message,category};}
    return undefined;
    });
  }
  private currentInteractiveStatus(now:number){return {chaos:this.chaos.status(now).active,secretEvents:this.interactive.active().filter(event=>event.kind==='mystery_case'||event.kind==='elio_rescue'||event.kind==='secret_portal'),boss:this.store.activeBoss(now)||null,wheel:this.arcade.wheelStatus(now).active,drop:(this.arcade.snapshot('drop').drop as {status?:string}|undefined)?.status||null};}

  firstChatWelcome(message:ChatMessage,now=Date.now(),excludedLogins: string[] = []):string|undefined {
    if(message.senderUserId===this.config.botUserId||message.senderUserId===message.broadcasterUserId)return undefined;
    if(excludedLogins.some(login=>login.toLowerCase()===message.senderLogin.toLowerCase()))return undefined;
    const settings=this.store.config<{enabled:boolean;message:string}>('first_chat_welcome',{enabled:false,message:'Willkommen im Chat, {user}! 🎮 Schreib !help, wenn du die Community-Befehle sehen möchtest.'});
    if(!settings.enabled||!this.store.markFirstChat(message.senderUserId,now))return undefined;
    const text=settings.message.replace(/\{user\}/gu,cleanName(message.senderDisplayName));
    return clampChatMessage(text,this.config.appChatMessageLength);
  }

  syncLegacyHalloween(now = Date.now()): void { this.store.syncLegacyHalloween(now); }

  recordHauntedHouseContribution(eventId:string,userId:string,now=Date.now()):void { this.hauntedHouse.recordAcceptedPlay(eventId,userId,now); }

  activeEventId(): string | undefined { return this.store.activeEvent()?.id; }

  activeGameConflict(){return this.store.miniGameQuery(db=>findActiveCommunityEventConflict(db));}

  claimChatDeliveryMessages(now=Date.now()){return this.store.claimChatDeliveryMessages(now);}
  finishChatDelivery(id:string,accepted:boolean,now=Date.now(),error=''){this.store.finishChatDelivery(id,accepted,now,error);}
  chatDeliverySnapshot(){return this.store.chatDeliverySnapshot();}

  helpAvailability(): HelpAvailability {
    const modules=this.store.config<Record<string,boolean>>('modules',{}),active=this.store.activeEvent();
    const eventSettings=this.store.config<{enabled?:boolean}>('quest_settings',{});
    const ideaSettings=this.store.config<{enabled?:boolean;chatEnabled?:boolean}>('community_idea_settings',{});
    const mini=this.miniGames.settings(),arcade=this.arcade.settings(),spark=this.conversationSpark.config();
    const events=this.store.events().map(event=>({id:event.id,name:event.name,command:event.command,active:event.active&&(event.id==='halloween'||modules.events!==false)}));
    const activeEnabled=Boolean(active&&(active.id==='halloween'||modules.events!==false));
    return {xp:modules.xp!==false,events:activeEnabled,...(activeEnabled&&active?{activeEventId:active.id,activeEventName:active.name,activeEventCommand:active.command}:{}),seasonalEvents:events,
      pet:arcade.petEnabled,petCare:arcade.petEnabled&&!Boolean((this.arcade.snapshot('pet').pet as {paused?:boolean}|undefined)?.paused),
      drops:arcade.dropsEnabled,wheel:arcade.wheelEnabled,imposter:mini.enabled,detective:mini.enabled,vault:this.vault.settings().enabled,
      quests:modules.quests!==false&&eventSettings.enabled!==false,ideas:modules.ideas!==false&&ideaSettings.enabled!==false&&ideaSettings.chatEnabled!==false,spark:spark.enabled,
      eightBall:modules.eightBall!==false,rps:modules.rps!==false,guess:modules.guess!==false,duels:modules.duels!==false,chaos:this.chaos.settings().enabled,chronicles:this.chronicles.settings().enabled};
  }

  tick(now = Date.now(), advanceMiniGames = true): string[] { return this.tickMessages(now, advanceMiniGames).map(item => item.message); }
  tickMessages(now = Date.now(), advanceMiniGames = true): OutboundChatMessage[] {
    this.refreshScheduledEvents(now); this.questPoll.tick(now); this.conversationSpark.tick(now); this.moderatorPranks.tick(now);
    this.interactive.tick(now);
    const chaosMessages=this.chaos.finishDue(now);this.chronicles.reconcile(now);
    return [...chaosMessages.map(message=>({message,category:'community' as const})),...(advanceMiniGames ? this.miniGames.tickMessages(now) : []), ...this.arcade.tickMessages(now), ...this.vault.tickMessages(now)];
  }

  async handle(message: ChatMessage, command: string, args: string[], now = Date.now()): Promise<CommandReply[]> {
    const modules = this.store.config<Record<string, boolean>>('modules', {});
    const name = cleanName(message.senderDisplayName);
    const say = (value: string, category: ChatCategory = categoryForCommand(command)): CommandReply[] => [{ message: clampChatMessage(value, this.config.appChatMessageLength), category,
      ...(message.messageId ? { replyParentMessageId: message.messageId } : {}) }];
    const sayMany = (values: string[], category: ChatCategory): CommandReply[] => values.map(value => ({
      message: clampChatMessage(value, this.config.appChatMessageLength), category,
      bypassResponsePolicy: category === 'poll',
      ...(message.messageId ? { replyParentMessageId: message.messageId } : {}),
    }));

    if(command==='idee'||command==='ideen')return this.handleIdeaCommand(message,command,args,now,say);

    if(message.senderUserId!==this.config.botUserId&&message.senderLogin.toLowerCase()!==this.config.botLogin.toLowerCase()){
      if(this.chronicles.castVote(message,command,now))return [];
      const chaosReply=this.chaos.participate(message,command,now);
      if(chaosReply!==undefined)return say(chaosReply,'community');
    }

    const interactiveReply=this.interactiveCommand(message,command,args,now);
    if(interactiveReply!==undefined)return say(interactiveReply,'community');

    if(command==='code') { const result=this.vault.guess(message,args,now);return result.privateHint?say(result.privateHint,'vault'):[]; }

    const prankReply=this.moderatorPranks.handle(message,command,args,now);
    if(prankReply!==undefined)return say(prankReply,command==='orakel'?'oracle':'pet');

    const sparkResponse = await this.conversationSpark.handleCommand(message, command, args, now);
    if (sparkResponse !== undefined) return say(sparkResponse);
    const miniGameResponse = this.miniGames.handle(message, command, args, now);
    if (miniGameResponse !== undefined) return say(miniGameResponse);
    const pollBeforeArcade = command === 'spin' || command === 'startwheel' ? this.store.activePoll(now)?.id : undefined;
    const arcadeResponse = this.arcade.handle(message,command,args,now);
    if (arcadeResponse !== undefined) {
      const pollStartedByWheel = pollBeforeArcade === undefined && (command === 'spin' || command === 'startwheel')
        ? this.store.activePoll(now) : undefined;
      if (pollStartedByWheel?.type === 'quest') return sayMany(formatPollAnnouncement(pollStartedByWheel, Math.min(430, this.config.appChatMessageLength)), 'poll');
      return say(arcadeResponse,
        (command==='spin'||command==='startwheel')&&this.arcade.spinActionTypeAt(now)==='boost_pet'?'pet':undefined);
    }
    const questPollResponse = this.questPoll.handle(message, command, args, now);
    if (questPollResponse !== undefined) return questPollResponse ? say(questPollResponse) : [];

    if (modules.events !== false && (['gift', 'egghunt'].includes(command) || ['eventscore', 'eventtop', 'startevent', 'endevent'].includes(command))) {
      const result = this.handleEvents(message, command, args, name, now);
      if (typeof result==='string') return say(result, 'season');
      if (result) return [{message:result.message,category:'season',durableDeliveryId:result.deliveryId,...(message.messageId?{replyParentMessageId:message.messageId}:{})}];
    }

    if (modules.xp !== false) {
      if (command === 'level') return say(await this.levelMessage(message, args));
      if (command === 'xptop') return say(this.xpTopMessage());
      if (command === 'rank') return say(`⭐ ${name}: Rang ${this.store.xpRank(message.senderUserId) || 'noch nicht gelistet'}.`);
    }

    if (modules.eightBall !== false && command === '8ball') { const reply=this.eightBall(message,args,now);return reply?say(reply):[]; }
    if (modules.rps !== false && command === 'rps') return say(this.rps(message, args, now));
    if (modules.guess !== false && command === 'startguess') return say(this.startGuess(message, now));
    if (modules.guess !== false && command === 'guess') return say(this.guess(message, args, now));
    if (modules.duels !== false && command === 'duel') return say(await this.duel(message, args, now));
    if (modules.duels !== false && command === 'accept') return say(this.acceptDuel(message, now));
    if (modules.duels !== false && command === 'cancelduel') return say(this.store.cancelDuel(message.senderUserId, now) ? '⚔️ Herausforderung zurückgezogen.' : '⚔️ Keine offene eigene Herausforderung.');

    if (modules.boss !== false && command === 'startboss') return say(this.startBoss(message, args, now));
    if (modules.boss !== false && command === 'boss') return say(this.bossStatus(now));
    if (modules.boss !== false && command === 'bosstop') return say(this.bossTop());
    if (modules.boss !== false && command === 'attack') {const result=this.attackBoss(message,now);return result?say(result):[];}
    if (modules.boss !== false && command === 'endboss') return say(this.endBoss(message, now));

    if (modules.customCommands !== false) {
      if (command === 'addcommand') return say(this.addCommand(message, args, now));
      if (command === 'setcommand') return say(this.setCommand(message, args, now));
      if (command === 'delcommand') return say(this.deleteCommand(message, args, now));
      const custom = this.store.customCommand(command, now);
      if (custom && this.hasPermission(message, custom.permission)) {
        const remaining = this.store.useCooldown(`custom:${custom.name}`, message.senderUserId, now, custom.cooldownMs);
        if (remaining > 0) return [];
        return say(renderTemplate(custom.response, { user: name, channel: this.config.channelLogin, game: 'unbekannt', uptime: 'unbekannt' }), 'custom');
      }
    }
    return [];
  }

  discordGameReply(message:ChatMessage,game:'8ball'|'rps'|'guess',args:string[],now=Date.now()):string {
    const modules=this.store.config<Record<string,boolean>>('modules',{});
    if(game==='8ball'){
      if(modules.eightBall===false)return '🎱 Das 8-Ball-Spiel ist derzeit deaktiviert.';
      return this.eightBall(message,args,now)||'🎱 Bitte versuche es gleich noch einmal.';
    }
    if(game==='rps'){
      if(modules.rps===false)return '✂️ Schere, Stein, Papier ist derzeit deaktiviert.';
      return this.rps(message,args,now);
    }
    if(modules.guess===false)return '🔢 Das Zahlenraten ist derzeit deaktiviert.';
    return this.guess(message,args,now);
  }

  private handleIdeaCommand(message:ChatMessage,command:string,args:string[],now:number,say:(text:string,category?:ChatCategory)=>CommandReply[]):CommandReply[] {
    const settings=this.store.config<{enabled?:boolean;chatEnabled?:boolean;cooldownMs?:number;maxLength?:number}>('community_idea_settings',{enabled:true,chatEnabled:true,cooldownMs:600_000,maxLength:240});
    if(settings.enabled===false||settings.chatEnabled===false)return say('💡 Der Community-Ideenkasten ist gerade pausiert.','ideas');
    if(command==='ideen')return say('💡 Alle Vorschläge ansehen und abstimmen: https://twitch.gater-app.de/community/ideen','ideas');
    const sub=(args[0]||'').toLowerCase();
    if(sub==='status'){
      const idPrefix=(args[1]||'').toLowerCase(),idea=idPrefix?['approved','voting','accepted','planned','implemented'].flatMap(status=>this.store.communityIdeas({status,limit:200})).find(item=>item.id.toLowerCase().startsWith(idPrefix)):undefined;
      if(!idea)return say('💡 Diese freigegebene Ideen-ID wurde nicht gefunden.','ideas');
      const labels:Record<string,string>={pending:'eingereicht und wartet auf Prüfung',reviewing:'wird gerade geprüft',approved:'freigegeben',voting:'steht zur Abstimmung',accepted:'angenommen',planned:'in Planung',implemented:'umgesetzt',rejected:'nicht freigegeben',archived:'archiviert'};
      return say(`💡 Idee #${idea.id.slice(0,8)} ist ${labels[idea.status]||'aktualisiert'}.`,'ideas');
    }
    if(sub==='top'){
      const idea=this.store.communityIdeas({status:'approved',sort:'popular',limit:1})[0];
      return say(idea?`💡 Community-Favorit: „${idea.text}“ – schau im Portal vorbei: https://twitch.gater-app.de/community/ideen`:'💡 Noch gibt es keine freigegebenen Ideen.','ideas');
    }
    const text=args.join(' ').normalize('NFC').trim();
    if(!text)return say('💡 Du hast eine Idee für Jannik? Schreib einfach: !idee DEIN VORSCHLAG 💜','ideas');
    const length=Array.from(text).length,max=Math.min(240,Math.max(40,Number(settings.maxLength)||240));
    if(length<8||length>max||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))return say(`💡 Bitte beschreibe deine Idee mit 8 bis ${max} Zeichen.`,'ideas');
    const result=this.store.submitCommunityIdea({id:randomUUID(),userId:message.senderUserId,displayName:cleanName(message.senderDisplayName),text,now,cooldownMs:Math.max(60_000,Math.min(86_400_000,Number(settings.cooldownMs)||600_000))});
    if(!result.ok)return say(result.reason==='duplicate'?'💡 Diese Idee hast du vor Kurzem schon eingereicht.':result.reason==='cooldown'?'⏳ Bitte warte noch kurz, bevor du eine weitere Idee einreichst.':'💡 Du hast bereits mehrere offene Ideen. Warte bitte erst die Prüfung ab.','ideas');
    return say(`💡💜 Deine Idee ist gespeichert, @${cleanName(message.senderDisplayName)}! Danke für deinen Vorschlag! Jannik und die Mods schauen sie sich an. 🐾 ID: #${result.idea.id.slice(0,8)}`,'ideas');
  }

  private handleEvents(message: ChatMessage, command: string, args: string[], name: string, now: number): string | {message:string;deliveryId:string} | undefined {
    if (command === 'startevent' || command === 'endevent') {
      if (!this.isModerator(message)) return '⛔ Nur Jannik oder autorisierte Mods dürfen Events steuern.';
      const eventId = (args[0] || '').toLowerCase();
      if (command === 'startevent') {
        const started = this.store.setEventActive(eventId, true, now);
        if (!started) return this.store.event(eventId) ? '⛔ Erst das laufende Event beenden.' : '⛔ Event nicht gefunden.';
        return `✨ ${this.store.event(eventId)?.emoji || '🎉'} ${this.store.event(eventId)?.name || eventId} ist gestartet!`;
      }
      return this.store.setEventActive(eventId, false, now) ? `✨ ${this.store.event(eventId)?.name || eventId} ist beendet und archiviert.` : '✨ Dieses Event läuft nicht.';
    }
    if (command === 'eventscore' || command === 'eventtop') {
      const event = (args[0] ? this.store.event(args[0].toLowerCase()) : this.store.activeEvent());
      if (!event) return '✨ Gerade ist kein Sammel-Event aktiv.';
      if (command === 'eventscore') return `${event.emoji} ${name}: ${this.store.score(event.id, message.senderUserId)} ${event.currency}.`;
      const top = this.store.eventTop(event.id, 5);
      return top.length ? `${event.emoji} ${event.name}: ${top.map((p, i) => `${i + 1}. ${cleanName(p.displayName)} ${p.pumpkins}`).join(' · ')}` : `${event.emoji} Noch keine Punkte gesammelt.`;
    }
    const event = this.store.activeEvent();
    if (!event || event.command !== command) return command === 'gift' || command === 'egghunt' ? `✨ Das passende Event läuft gerade nicht.` : undefined;
    const cooldown = this.store.useCooldown(`event:${event.id}`, message.senderUserId, now, event.cooldownMs);
    if (cooldown > 0) return `⏳ ${name}: Warte noch ${Math.ceil(cooldown / 60_000)} Min.`;
    const outcomeKey = weightedChoice(event.weights, this.random) || (event.id === 'easter' ? 'GOLDEN_PUMPKIN' : 'TREAT');
    const delta = outcomePoints(outcomeKey, this.random);
    const defaultText = outcomeKey === 'EMPTY_HOUSE' ? `${event.emoji} {user} findet nichts.`
      : `${event.emoji} {user} sammelt {points} {currency}.`;
    const template = event.texts[outcomeKey] || event.texts.default || defaultText;
    const format=(points:number)=>template.replace(/\{(user|points|currency|total|event)\}/gu, (_all, key: string) => ({
      user: name, points: String(delta), currency: event.currency, total: String(points), event: event.name,
    })[key] || '');
    const outcome = this.store.playEvent(event.id, message.senderUserId, name, delta, now,
      {eventId:message.eventId,...(message.messageId?{replyParentMessageId:message.messageId}:{}),format});
    if (!outcome.ok&&outcome.reason==='duplicate')return undefined;
    if (!outcome.ok) return outcome.reason === 'inactive' ? '✨ Das Event ist gerade nicht aktiv.' : `⏳ Bitte noch ${Math.ceil((outcome.remainingMs || 0) / 60_000)} Min. warten.`;
    return {message:format(outcome.points),deliveryId:outcome.deliveryId||message.eventId};
  }

  private refreshScheduledEvents(now: number): void {
    const active = this.store.activeEvent();
    if (active?.endAt && active.endAt <= now) this.store.setEventActive(active.id, false, now);
    const scheduled = this.store.events().find((event) => !event.active && event.startAt !== null && event.startAt <= now && (!event.endAt || event.endAt > now));
    const current = this.store.activeEvent();
    if (scheduled && !current) this.store.setEventActive(scheduled.id, true, now);
  }

  private async levelMessage(message: ChatMessage, args: string[]): Promise<string> {
    let target = args[0] ? this.store.findUser(args[0]) : undefined;
    if (args[0] && !target) {
      const login = args[0].replace(/^@/u, '').toLowerCase();
      if (!/^[a-z0-9_]{1,25}$/u.test(login)) return '⭐ Bitte nenne einen gültigen Twitch-Login.';
      let user: Awaited<ReturnType<UserLookup>>;
      try { user = await this.lookupUser(login); } catch { return '⭐ Twitch-Profil gerade nicht erreichbar; bitte später erneut versuchen.'; }
      if (!user) return `⭐ Twitch-Konto @${login} wurde nicht gefunden.`;
      target = { userId: user.id, displayName: user.displayName, xp: this.store.xp(user.id).xp };
    }
    const userId = target?.userId || message.senderUserId;
    const details = this.store.xp(userId);
    const xpSettings = this.store.config<Record<string, number>>('xp_settings', { levelBase: 100 });
    const base = Math.max(1, xpSettings.levelBase || 100);
    const level = levelForXp(details.xp, base);
    const currentFloor = xpAtLevel(level, base);
    const nextFloor = xpAtLevel(level + 1, base);
    const title = this.titleForLevel(level);
    return `⭐ ${cleanName(target?.displayName || (userId === message.senderUserId ? message.senderDisplayName : details.displayName))}: Level ${level} ${title}, ${details.xp} XP (${details.xp - currentFloor}/${nextFloor - currentFloor} bis Level ${level + 1}).`;
  }

  private xpTopMessage(): string {
    const top = this.store.xpTop(5);
    return top.length ? `⭐ XP-Top: ${top.map((p, i) => `${i + 1}. ${cleanName(p.displayName)} ${p.xp}`).join(' · ')}` : '⭐ Noch keine XP gesammelt.';
  }

  private eightBall(message: ChatMessage, args: string[], now: number): string {
    if (!args.length) return '🎱 Benutzung: !8ball Wird Jannik heute gewinnen?';
    const saved=this.store.config<Partial<typeof DEFAULT_EIGHT_BALL_SETTINGS>>('eight_ball_settings',{});
    const settings={...DEFAULT_EIGHT_BALL_SETTINGS,...saved};
    const cooldown=this.store.useCooldownPair('8ball',message.senderUserId,now,settings.personalCooldownMs,settings.globalCooldownMs);
    if(cooldown?.blocked==='global')return '';
    if(cooldown?.blocked==='personal'){
      if(!settings.cooldownNotices||this.store.useCooldown('8ball_notice',message.senderUserId,now,30_000)>0)return '';
      return `🎱 @${cleanName(message.senderDisplayName)}, deine Kugel lädt noch auf. Versuch's in ${Math.ceil(cooldown.remainingMs/1000)} Sekunden erneut.`;
    }
    const question=args.join(' '),previous=this.store.state<{answer:string;at:number}|null>('eight_ball_last_reply',null);
    const result=chooseEightBallAnswer(question,this.random(1,100),this.random(0,11),previous?.answer);
    this.store.setState('eight_ball_last_reply',{answer:result.answer,at:now},now);
    return result.answer;
  }

  private rps(message: ChatMessage, args: string[], now: number): string {
    const choice = (args[0] || '').toLowerCase();
    const options = ['schere', 'stein', 'papier'];
    if (!options.includes(choice)) return '✂️ Nutze !rps schere, !rps stein oder !rps papier.';
    if (this.store.useCooldown('rps', message.senderUserId, now, 5000)) return '✂️ Einen Moment bis zur nächsten Runde.';
    const bot = options[this.random(0, 2)]!;
    if (choice === bot) return `✂️ Gleichstand! Du: ${choice}, Bot: ${bot}.`;
    const wins = (choice === 'schere' && bot === 'papier') || (choice === 'stein' && bot === 'schere') || (choice === 'papier' && bot === 'stein');
    if (!wins) return `✂️ Bot gewinnt: ${choice} gegen ${bot}.`;
    const xp = this.store.config('xp_settings', { dailyGameCap: 100, rpsWinXp: 10 });
    const awarded = this.store.awardXp(`bonus:rps:${message.eventId}`, message.senderUserId, message.senderDisplayName,
      xp.rpsWinXp, 'bonus:rps', now, xp.dailyGameCap);
    return `✂️ Du gewinnst gegen ${bot}!${awarded ? ` +${awarded} XP.` : ' Das Tageslimit für Spiel-XP ist erreicht.'}`;
  }

  private startGuess(message: ChatMessage, now: number): string {
    if (!this.isGuessStarter(message)) return '⛔ !startguess dürfen nur Jannik, Moderatoren und Twitch-VIPs starten.';
    const settings = this.store.config('game_settings', { guessMin: 1, guessMax: 100, guessTimeoutMs: 120_000, guessAttempts: 5 });
    if (this.store.state('guess', null)) return '🔢 Eine Zahlenrunde läuft bereits.';
    const target = this.random(settings.guessMin, settings.guessMax);
    this.store.setState('guess', { target, min: settings.guessMin, max: settings.guessMax, attempts: {}, expiresAt: now + settings.guessTimeoutMs }, now);
    return `🔢 Zahlenrunde gestartet! Rate ${settings.guessMin} bis ${settings.guessMax} mit !guess ZAHL.`;
  }

  private guess(message: ChatMessage, args: string[], now: number): string {
    const game = this.store.state<{ target: number; min: number; max: number; attempts: Record<string, number>; expiresAt: number } | null>('guess', null);
    if (!game) return '🔢 Gerade läuft keine Zahlenrunde.';
    if (game.expiresAt <= now) { this.store.clearState('guess', now); return '🔢 Die Zahlenrunde ist abgelaufen.'; }
    const value = Number(args[0]);
    if (!Number.isInteger(value) || value < game.min || value > game.max) return `🔢 Rate eine ganze Zahl von ${game.min} bis ${game.max}.`;
    const settings = this.store.config<{ guessAttempts: number; guessTimeoutMs: number }>('game_settings', { guessAttempts: 5, guessTimeoutMs: 120_000 });
    if (attemptsBefore(game.attempts[message.senderUserId], settings.guessAttempts)) return '🔢 Deine Versuche für diese Runde sind aufgebraucht.';
    const attempts = (game.attempts[message.senderUserId] || 0) + 1;
    game.attempts[message.senderUserId] = attempts;
    if (value === game.target) {
      this.store.clearState('guess', now);
      const xp = this.store.config('xp_settings', { dailyGameCap: 100, guessWinXp: 20 });
      const awarded = this.store.awardXp(`bonus:guess:${message.eventId}`, message.senderUserId, message.senderDisplayName,
        xp.guessWinXp, 'bonus:guess', now, xp.dailyGameCap);
      return `🎉 ${cleanName(message.senderDisplayName)} hat die Zahl ${game.target} erraten!${awarded ? ` +${awarded} XP.` : ''}`;
    }
    if (attempts >= settings.guessAttempts) {
      game.expiresAt = now + settings.guessTimeoutMs;
      this.store.setState('guess', game, now);
      return `🔢 ${value < game.target ? 'Höher' : 'Niedriger'} — deine Versuche sind aufgebraucht.`;
    }
    game.expiresAt = now + settings.guessTimeoutMs;
    this.store.setState('guess', game, now);
    return `🔢 ${value < game.target ? 'Höher' : 'Niedriger'}! Versuch ${attempts}/${settings.guessAttempts}.`;
  }

  private async duel(message: ChatMessage, args: string[], now: number): Promise<string> {
    const login = (args[0] || '').replace(/^@/u, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/u.test(login)) return '⚔️ Nutze !duel @user.';
    let target: Awaited<ReturnType<UserLookup>>;
    try { target = await this.lookupUser(login); } catch { return '⚔️ Twitch-Profile sind gerade nicht erreichbar; versuch es später erneut.'; }
    if (!target) return `⚔️ Twitch-Konto @${login} konnte nicht gefunden werden.`;
    const created = this.store.createDuel(message.senderUserId, cleanName(message.senderDisplayName), target.id, cleanName(target.displayName), now,
      this.store.config('game_settings', { duelTtlMs: 60_000 }).duelTtlMs);
    if (!created.ok) return created.reason === 'self' ? '⚔️ Du kannst dich nicht selbst herausfordern.' : '⚔️ Einer der beiden hat bereits ein offenes Duell.';
    return `⚔️ ${cleanName(target.displayName)}, du wurdest von ${cleanName(message.senderDisplayName)} herausgefordert! Mit !accept annehmen (60 Sek.). Kein Einsatz, nur Spaß.`;
  }

  private acceptDuel(message: ChatMessage, now: number): string {
    const xp = this.store.config('xp_settings', { dailyGameCap: 100, duelWinXp: 15 });
    const result = this.store.acceptDuel(message.senderUserId, now, xp.dailyGameCap, xp.duelWinXp);
    if (result.status !== 'accepted') return result.status === 'missing' ? '⚔️ Für dich gibt es kein offenes Duell.' : '⚔️ Die Herausforderung ist abgelaufen.';
    return `⚔️ ${result.winnerName} gewinnt das faire Duell gegen ${result.loserName}!`;
  }

  private startBoss(message: ChatMessage, args: string[], now: number): string {
    if (!this.isModerator(message)) return '⛔ Nur Jannik oder Mods dürfen einen Bosskampf starten.';
    if(this.isMajorGameBusy())return '⏳ Ein anderes Community-Event läuft bereits. Der Boss wartet, bis der Chat wieder frei ist.';
    const settings = this.store.config('game_settings', { bossHp: 1000, bossDurationMs: 900_000 });
    const bossName = cleanName(args.join(' ') || 'Schattenkönig');
    if (!this.store.startBoss(randomUUID(), bossName, settings.bossHp, settings.bossDurationMs, now)) return '👾 Es läuft bereits ein Bosskampf.';
    return `👾 ${bossName} erscheint! ${settings.bossHp} HP. Besiegt ihn gemeinsam mit !attack!`;
  }

  private bossStatus(now: number): string {
    const boss = this.store.activeBoss(now);
    return boss ? `👾 ${boss.name}: ${boss.hp}/${boss.maxHp} HP übrig.` : '👾 Gerade läuft kein Bosskampf.';
  }

  private bossTop(): string {
    const top = this.store.bossTop(5);
    return top.length ? `👾 Größter Schaden: ${top.map((p, i) => `${i + 1}. ${cleanName(p.displayName)} ${p.damage}`).join(' · ')}` : '👾 Noch keine Angriffe im aktuellen Kampf.';
  }

  private attackBoss(message: ChatMessage, now: number): string|undefined {
    const settings = this.store.config('game_settings', { attackMin: 20, attackMax: 60, attackCooldownMs: 10_000, bossWinXp: 30, bossTopBonusXp: 10 });
    const critical = this.random(1, 100) <= 10;
    const rawDamage = this.random(settings.attackMin, settings.attackMax) * (critical ? 2 : 1);
    const xp = this.store.config<Record<string, number>>('xp_settings', { dailyGameCap: 100 });
    const result = this.store.attackBoss(message.senderUserId, cleanName(message.senderDisplayName), rawDamage, now,
      message.eventId, 2, settings.bossWinXp, settings.bossTopBonusXp, xp.dailyGameCap, settings.attackCooldownMs);
    if(result.status==='duplicate')return undefined;
    if(result.status==='cooldown'){
      if(this.store.useCooldown('boss-attack-rejection-log',message.senderUserId,now,10_000)===0)this.store.recordCommunityEvent('boss.attack.rejected',{reason:'personal-cooldown'},now);
      return `⏳ ${cleanName(message.senderDisplayName)}, dein nächster Angriff ist in ${Math.ceil((result.remainingMs||0)/1000)} Sek. bereit.`;
    }
    if (result.status === 'missing') return '👾 Kein aktiver Boss. Frag Jannik nach !startboss.';
    if (result.status === 'defeated') return `💥 ${critical ? 'Kritischer Treffer! ' : ''}${cleanName(message.senderDisplayName)} verursacht ${result.damage} Schaden — ${result.name} ist besiegt! Ergebnis und tatsächlich gebuchte XP folgen gleich.`;
    return `⚔️ ${critical ? 'Kritischer Treffer! ' : ''}${cleanName(message.senderDisplayName)} verursacht ${result.damage} Schaden. ${result.name}: ${result.hp} HP übrig.`;
  }

  private endBoss(message: ChatMessage, now: number): string {
    if (!this.isModerator(message)) return '⛔ Nur Jannik oder autorisierte Mods dürfen den Bosskampf beenden.';
    return this.store.endBoss(now) ? '👾 Der Bosskampf wurde beendet.' : '👾 Gerade läuft kein Bosskampf.';
  }

  private addCommand(message: ChatMessage, args: string[], now: number): string {
    if (message.senderUserId !== this.config.broadcasterUserId) return '⛔ Nur Jannik darf neue Chatbefehle anlegen.';
    const [head, ...body] = args.join(' ').split('|');
    const name = (head || '').trim().replace(/^!/u, '');
    const response = body.join('|').trim();
    if (!name || !response) return '💬 Format: !addcommand name | Antworttext';
    try {
      this.store.addCustomCommand({ name, response, enabled: true, permission: 'everyone', cooldownMs: 10_000, alias: null, expiresAt: null, modsMayManage: false });
      this.store.adminAudit(message.senderUserId, 'custom-command-create', name, {}, now);
      return `✅ !${name} ist angelegt.`;
    } catch { return '⛔ Der Name ist reserviert oder die Antwort enthält ungültige Platzhalter.'; }
  }

  private setCommand(message: ChatMessage, args: string[], now: number): string {
    const [head, ...body] = args.join(' ').split('|');
    const name = (head || '').trim().replace(/^!/u, '');
    const existing = this.store.customCommand(name, now);
    const allowed = message.senderUserId === this.config.broadcasterUserId || (this.isModerator(message) && existing?.modsMayManage === true);
    const response = body.join('|').trim();
    if (!allowed) return '⛔ Für diesen Befehl ist die Verwaltung nicht freigegeben.';
    if (!existing || !response) return '💬 Format: !setcommand name | neuer Antworttext';
    try {
      this.store.addCustomCommand({ ...existing, response });
      this.store.adminAudit(message.senderUserId, 'custom-command-update', name, {}, now);
      return `✅ !${name} wurde aktualisiert.`;
    } catch { return '⛔ Antwort enthält ungültige Platzhalter.'; }
  }

  private deleteCommand(message: ChatMessage, args: string[], now: number): string {
    if (message.senderUserId !== this.config.broadcasterUserId) return '⛔ Nur Jannik darf Chatbefehle löschen.';
    const name = (args[0] || '').replace(/^!/u, '').toLowerCase();
    if (!name || !this.store.deleteCustomCommand(name)) return '💬 Befehl nicht gefunden. Format: !delcommand name';
    this.store.adminAudit(message.senderUserId, 'custom-command-delete', name, {}, now);
    return `✅ !${name} wurde entfernt.`;
  }

  private interactiveCommand(message:ChatMessage,command:string,args:string[],now:number):string|undefined{
    const action=(args[0]||'').toLowerCase();
    if(command==='battle'){
      const event=this.interactive.active('battle',now)[0];
      if(action==='start')return message.senderUserId===this.config.broadcasterUserId?this.interactive.startBattle(message.senderUserId,now).message:'⛔ Nur Jannik kann einen Battle starten.';
      if(!event)return '⚔️ Gerade läuft kein Twitch-vs-Discord-Battle.';
      if(action==='join')return this.interactive.join(event.id,'twitch',message.senderUserId,message.senderDisplayName,undefined,now).message;
      if(action==='punkt')return this.interactive.contribute(event.id,`twitch:${message.eventId}`,'twitch',message.senderUserId,now).message;
      const score=event.points||{twitch:0,discord:0};return `⚔️ ACY BATTLE · Twitch ${score.twitch} : ${score.discord} Discord · !battle join zum Mitmachen · !battle punkt für einen begrenzten Punkt.`;
    }
    if(command==='gamenight'){
      const event=this.interactive.active('game_night',now).find(item=>item.status==='scheduled'||item.status==='open');
      if(!event)return '🎮 Es ist gerade kein Community-Spieleabend geplant.';
      if(action==='join')return this.interactive.join(event.id,'twitch',message.senderUserId,message.senderDisplayName,undefined,now).message;
      const when=new Intl.DateTimeFormat('de-DE',{timeZone:this.interactive.settings().gameNightTimezone,dateStyle:'medium',timeStyle:'short'}).format(event.startsAt);
      const game=String(event.settings.game||'Spiel offen');return `🎮 ${event.title} · ${game} · ${when} Uhr · ${event.participants} angemeldet${event.waitlist?` · ${event.waitlist} Warteliste`:''} · !gamenight join`;
    }
    if(command==='geheim'){
      const event=(['mystery_case','elio_rescue','secret_portal'] as const).flatMap(kind=>this.interactive.active(kind,now)).find(item=>item.status==='open');
      if(!event)return '🎁 Gerade läuft kein geheimes Community-Event.';
      if(action==='join')return this.interactive.join(event.id,'twitch',message.senderUserId,message.senderDisplayName,undefined,now).message;
      return `🎁 ${event.title} · ${event.participants} dabei · !geheim join zum Mitmachen.`;
    }
    return undefined;
  }

  private isModerator(message: ChatMessage): boolean {
    return message.senderUserId === this.config.broadcasterUserId || message.isModerator === true
      || this.config.authorizedModeratorIds.includes(message.senderUserId);
  }

  private isGuessStarter(message: ChatMessage): boolean {
    return this.isModerator(message) || message.isVip === true;
  }

  private hasPermission(message: ChatMessage, permission: CustomCommand['permission']): boolean {
    if (permission === 'everyone') return true;
    if (permission === 'broadcaster') return message.senderUserId === this.config.broadcasterUserId;
    return this.isModerator(message);
  }

  private titleForLevel(level: number): string {
    const titles = this.store.config<Record<string, string>>('level_titles', {});
    const eligible = Object.keys({ ...LEVEL_TITLES, ...titles }).map(Number).filter((entry) => entry <= level).sort((a, b) => b - a)[0] || 1;
    return (titles[String(eligible)] || LEVEL_TITLES[eligible] || '').trim();
  }
}

export function levelForXp(xp: number, base = 100): number {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / Math.max(1, base))) + 1);
}

export function xpAtLevel(level: number, base = 100): number {
  return Math.max(0, level - 1) ** 2 * base;
}

function cleanName(value: string): string {
  return Array.from(value.replace(/[\r\n\t]/gu, ' ').trim()).slice(0, 32).join('') || 'Unbekannt';
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(user|channel|game|uptime)\}/gu, (_all, key: string) => values[key] || '');
}

function weightedChoice(weights: Record<string, number>, random: (min: number, max: number) => number): string | undefined {
  const entries = Object.entries(weights).filter(([, weight]) => Number.isSafeInteger(weight) && weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!total) return undefined;
  let roll = random(1, Math.ceil(total));
  for (const [name, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return entries.at(-1)?.[0];
}

function outcomePoints(outcome: string, random: (min: number, max: number) => number): number {
  const ranges: Record<string, [number, number]> = {
    TREAT: [3, 15], GIFT: [3, 15], EGG: [3, 15], TRICK: [0, 0], GHOST: [0, 0],
    JACKPOT: [20, 40], WITCH: [8, 20], GOLDEN_PUMPKIN: [25, 50], GOLDEN_EGG: [25, 50], EMPTY_HOUSE: [0, 0],
  };
  const [min, max] = ranges[outcome] || [3, 10];
  return random(min, max);
}

function attemptsBefore(current: number | undefined, max: number): boolean { return current !== undefined && current >= max; }

function secureRandomInclusive(min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new Error('Ungültiger Zufallsbereich.');
  return randomInt(min, max + 1);
}
