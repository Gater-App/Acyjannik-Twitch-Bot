import { randomUUID, createHash } from 'node:crypto';
import type { ChatMessage } from './types.js';
import { FeatureStore, type SparkProposal } from './feature-store.js';

export type SparkActionType = 'question' | 'poll' | 'quest' | 'challenge';
export type SparkCategory = 'gaming' | 'films' | 'music' | 'food' | 'pets' | 'travel' | 'everyday' | 'technology' | 'sports' | 'pop-culture' | 'community';
export type SparkSensitivity = 'reserved' | 'normal' | 'active';
export type SparkPublishMode = 'internal' | 'approved-chat';
export interface SparkTopic { id: string; label: string; terms: string[]; actionType: SparkActionType; category?: SparkCategory; }
export interface SparkConfig {
  enabled: boolean; paused: boolean; windowMs: number; minParticipants: number; minMessages: number; minScore: number;
  globalCooldownMs: number; topicCooldownMs: number; proposalTtlMs: number; maxPending: number;
  chatSuggestionsEnabled: boolean; pauseDuringPolls: boolean; metadataRetentionMs: number; allowedActionTypes: SparkActionType[];
  enabledCategories: SparkCategory[]; sensitivity: SparkSensitivity; publishMode: SparkPublishMode;
}
export const DEFAULT_SPARK_CONFIG: SparkConfig = {
  enabled:false, paused:false, windowMs:600_000, minParticipants:3, minMessages:5, minScore:12,
  globalCooldownMs:1_200_000, topicCooldownMs:3_600_000, proposalTtlMs:1_800_000, maxPending:5,
  chatSuggestionsEnabled:false, pauseDuringPolls:true, metadataRetentionMs:7*86_400_000,
  allowedActionTypes:['poll','quest','challenge'], enabledCategories:['gaming','films','music','food','pets','travel','everyday','technology','sports','pop-culture','community'],
  sensitivity:'normal', publishMode:'internal',
};

export const SPARK_QUESTION_POOLS: Record<SparkCategory, string[]> = {
  gaming:['Welches Spiel würdet ihr gern noch einmal zum ersten Mal erleben?','Welches Spiel hat euch zuletzt positiv überrascht?','Was macht für euch einen richtig guten Spieleabend aus?','Welchen Bosskampf habt ihr noch lange in Erinnerung?','Welcher Spielmodus macht euch zusammen am meisten Spaß?'],
  films:['Welchen Film könntet ihr immer wieder schauen?','Welche Serie hat euch zuletzt richtig gepackt?','Bei welchem Film stimmt für euch einfach alles?','Welche Filmwelt würdet ihr gern einmal besuchen?','Welche Serie könnt ihr anderen immer empfehlen?'],
  music:['Welcher Song hebt sofort eure Stimmung?','Welche Musik läuft bei euch beim Zocken?','Welches Konzert ist euch besonders in Erinnerung geblieben?','Welchen Song könnt ihr komplett mitsingen?','Welche Musik passt perfekt zu einem Roadtrip?'],
  food:['Welches Essen könntet ihr jeden Tag essen?','Was ist euer liebstes Wohlfühlgericht?','Welche Kombination klingt seltsam, schmeckt aber richtig gut?','Was darf bei einem gemütlichen Filmabend nicht fehlen?','Süß oder salzig: Was gewinnt bei euch?'],
  pets:['Was ist das Lustigste, das euer Haustier macht?','Welchen Namen würdet ihr einem neuen Haustier geben?','Was ist die liebste Angewohnheit eures Haustiers?','Welches Tier wärt ihr für einen Tag gern?','Was bringt euer Haustier zuverlässig zum Spielen?'],
  travel:['Welchen Ort würdet ihr gern einmal besuchen?','Was gehört für euch zu einem gelungenen Urlaub?','Lieber Meer, Berge oder eine spannende Stadt?','Welcher Ausflug ist euch besonders in Erinnerung geblieben?','Was darf bei einem Roadtrip auf keinen Fall fehlen?'],
  everyday:['Was war heute ein kleiner schöner Moment?','Womit entspannt ihr nach einem langen Tag am besten?','Was macht einen freien Tag für euch perfekt?','Welche kleine Sache versüßt euch den Alltag?','Was probiert ihr in eurer Freizeit gerade gern aus?'],
  technology:['Welches technische Gerät nutzt ihr täglich am liebsten?','Welche kleine Erfindung macht euren Alltag leichter?','Was sollte Technik in Zukunft einfacher machen?','Welche App oder Funktion spart euch am meisten Zeit?','Was war euer erstes Gerät, auf das ihr richtig stolz wart?'],
  sports:['Welchen Sport schaut oder macht ihr am liebsten?','Was macht für euch ein spannendes Match aus?','Welche Sportart würdet ihr gern einmal ausprobieren?','Lieber selbst spielen oder gemütlich zuschauen?','Welcher Sportmoment ist euch besonders im Kopf geblieben?'],
  'pop-culture':['Welche fiktive Figur würdet ihr gern zum Kaffee treffen?','Welcher Trend hat euch zuletzt zum Lachen gebracht?','In welches bekannte Universum würdet ihr gern eintauchen?','Welche Figur verdient eurer Meinung nach ein eigenes Spin-off?','Was ist euer liebster Popkultur-Insider?'],
  community:['Welche Fähigkeit würdet ihr gern sofort lernen?','Was ist euer perfekter gemütlicher Abend?','Welche Kleinigkeit macht euch immer gute Laune?','Was würdet ihr gern einmal gemeinsam im Stream ausprobieren?','Welche harmlose Frage sollte der Chat öfter diskutieren?'],
};

export function normalizeSparkConfig(value: unknown): SparkConfig {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<SparkConfig> : {};
  const bounded = (candidate: unknown, fallback: number, min: number, max: number): number =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= min && candidate <= max ? candidate : fallback;
  const boolean = (candidate: unknown, fallback: boolean): boolean => typeof candidate === 'boolean' ? candidate : fallback;
  const knownActions: SparkActionType[] = ['poll','quest','challenge'];
  const actions = Array.isArray(saved.allowedActionTypes)
    ? [...new Set(saved.allowedActionTypes.filter((item): item is SparkActionType => knownActions.includes(item as SparkActionType)))]
    : [];
  const categories=Array.isArray(saved.enabledCategories)?[...new Set(saved.enabledCategories.filter((item):item is SparkCategory=>Object.hasOwn(SPARK_QUESTION_POOLS,item)))]:[...DEFAULT_SPARK_CONFIG.enabledCategories];
  const sensitivity:SparkSensitivity=saved.sensitivity==='reserved'||saved.sensitivity==='active'?saved.sensitivity:'normal';
  const publishMode:SparkPublishMode=saved.publishMode==='approved-chat'?'approved-chat':'internal';
  return {
    enabled: boolean(saved.enabled, DEFAULT_SPARK_CONFIG.enabled), paused: boolean(saved.paused, DEFAULT_SPARK_CONFIG.paused),
    windowMs: bounded(saved.windowMs, DEFAULT_SPARK_CONFIG.windowMs, 60_000, 3_600_000),
    minParticipants: bounded(saved.minParticipants, DEFAULT_SPARK_CONFIG.minParticipants, 2, 50),
    minMessages: bounded(saved.minMessages, DEFAULT_SPARK_CONFIG.minMessages, 3, 200),
    minScore: bounded(saved.minScore, DEFAULT_SPARK_CONFIG.minScore, 1, 1000),
    globalCooldownMs: bounded(saved.globalCooldownMs, DEFAULT_SPARK_CONFIG.globalCooldownMs, 60_000, 86_400_000),
    topicCooldownMs: bounded(saved.topicCooldownMs, DEFAULT_SPARK_CONFIG.topicCooldownMs, 60_000, 604_800_000),
    proposalTtlMs: bounded(saved.proposalTtlMs, DEFAULT_SPARK_CONFIG.proposalTtlMs, 60_000, 86_400_000),
    maxPending: bounded(saved.maxPending, DEFAULT_SPARK_CONFIG.maxPending, 1, 50),
    chatSuggestionsEnabled: boolean(saved.chatSuggestionsEnabled, DEFAULT_SPARK_CONFIG.chatSuggestionsEnabled),
    pauseDuringPolls: boolean(saved.pauseDuringPolls, DEFAULT_SPARK_CONFIG.pauseDuringPolls),
    metadataRetentionMs: bounded(saved.metadataRetentionMs, DEFAULT_SPARK_CONFIG.metadataRetentionMs, 60_000, 31_536_000_000),
    allowedActionTypes: actions.length ? actions : [...DEFAULT_SPARK_CONFIG.allowedActionTypes], enabledCategories:categories.length?categories:[...DEFAULT_SPARK_CONFIG.enabledCategories],sensitivity,publishMode,
  };
}

export const DEFAULT_SPARK_TOPICS: SparkTopic[] = [
  { id:'fortnite',label:'Fortnite / Spielmodus',category:'gaming',actionType:'poll',terms:['fortnite','zero build','zero-build','battle royale','ranked','reload','build mode'] },
  { id:'minecraft',label:'Minecraft',category:'gaming',actionType:'quest',terms:['minecraft','nether','enderdrache','ender dragon','redstone','creeper'] },
  { id:'elden-ring',label:'Elden Ring / Boss-Strategie',category:'gaming',actionType:'poll',terms:['elden ring','malenia','radahn','bosskampf','boss strategie','boss-strategie','ausweichen','dodge','build'] },
  { id:'gaming-challenge',label:'Gaming-Challenge',category:'gaming',actionType:'challenge',terms:['challenge','hardcore','no hit','ohne schaden','speedrun','schwierigkeitsgrad'] },
  {id:'films',label:'Filme und Serien',category:'films',actionType:'question',terms:['film','filme','kino','serie','serien','netflix','streaming']},
  {id:'music',label:'Musik',category:'music',actionType:'question',terms:['musik','song','songs','sänger','sängerin','band','playlist','konzert','album']},
  {id:'food',label:'Essen und Getränke',category:'food',actionType:'question',terms:['essen','gericht','gerichte','rezept','kochen','pizza','nudeln','kaffee','tee','getränk']},
  {id:'pets',label:'Haustiere',category:'pets',actionType:'question',terms:['haustier','haustiere','hund','hunde','katze','katzen','welpe','kätzchen']},
  {id:'travel',label:'Urlaub und Reisen',category:'travel',actionType:'question',terms:['urlaub','reisen','reise','roadtrip','ferien','strand','berge','ausflug']},
  {id:'everyday',label:'Alltag und Freizeit',category:'everyday',actionType:'question',terms:['freizeit','feierabend','wochenende','alltag','entspannen','hobby','spaziergang']},
  {id:'technology',label:'Technik',category:'technology',actionType:'question',terms:['technik','computer','pc','hardware','smartphone','handy','tastatur','app','kopfhörer']},
  {id:'sports',label:'Sport',category:'sports',actionType:'question',terms:['sport','fußball','fussball','basketball','tennis','formel 1','f1','laufen','training']},
  {id:'pop-culture',label:'Popkultur',category:'pop-culture',actionType:'question',terms:['popkultur','meme','memes','cosplay','anime','comic','comics','superheld','superhelden']},
  {id:'community',label:'Community-Fragen',category:'community',actionType:'question',terms:['lieblings','gemeinsam','chatfrage','communityfrage','eure meinung','was würdet ihr']},
];

export interface TopicDetection { topic: SparkTopic; matchedTerms: string[]; }
export interface TopicDetector { detect(text: string, customTopics?: SparkTopic[]): TopicDetection[]; }

export class RuleBasedTopicDetector implements TopicDetector {
  detect(text: string, customTopics: SparkTopic[] = []): TopicDetection[] {
    const normalized = normalize(text);
    if (!normalized || containsSensitiveTopic(normalized)) return [];
    return [...DEFAULT_SPARK_TOPICS,...customTopics].map((topic) => {
      const matchedTerms=[...new Set(topic.terms.map(normalize).filter((term) => term.length >= 3 && includesPhrase(normalized,term)
        && (term !== 'build' || topic.id !== 'elden-ring' || /\b(elden ring|malenia|radahn|bosskampf|boss strategie)\b/u.test(normalized))))];
      return {topic,matchedTerms};
    }).filter((hit) => hit.matchedTerms.length > 0);
  }
}

interface Activity { eventId:string; speakerId:string; at:number; fingerprint:string; terms:string[]; }
export interface SparkTopicSnapshot { topicId:string; label:string; score:number; participants:number; messages:number; }

export class ConversationSpark {
  private readonly windows = new Map<string, Activity[]>();
  private readonly seenEventIds = new Set<string>();
  private readonly detector: TopicDetector;

  constructor(private readonly store:FeatureStore,private readonly channelId:string,
    detector:TopicDetector = new RuleBasedTopicDetector()) { this.detector=detector; }

  config(): SparkConfig {
    return normalizeSparkConfig(this.store.config<unknown>('spark_settings',{}));
  }

  observe(message:ChatMessage,now=Date.now()): SparkProposal[] {
    const config=this.config();
    this.prune(now,config.windowMs);
    if (!config.enabled || config.paused || message.broadcasterUserId!==this.channelId
      || message.senderUserId===message.broadcasterUserId || !message.messageId
      || message.message.trim().startsWith('!') || Array.from(message.message.trim()).length<4) return [];
    if (this.seenEventIds.has(message.eventId)) return [];
    this.seenEventIds.add(message.eventId);
    if (this.seenEventIds.size>10_000) this.seenEventIds.clear();
    const custom=this.store.config<SparkTopic[]>('spark_topics',[]);
    const created:SparkProposal[]=[];
    for (const {topic,matchedTerms} of this.detector.detect(message.message,custom)) {
      const category=topic.category||'gaming';
      if(!config.enabledCategories.includes(category))continue;
      const key=`${this.channelId}:${topic.id}`;
      const activity=this.windows.get(key) || [];
      const fingerprint=createHash('sha256').update(normalize(message.message)).digest('hex');
      const sameUserCount=activity.filter((item)=>item.speakerId===message.senderUserId).length;
      if (sameUserCount>=3 || activity.some((item)=>item.fingerprint===fingerprint && now-item.at<config.windowMs)) continue;
      activity.push({eventId:message.eventId,speakerId:message.senderUserId,at:now,fingerprint,terms:matchedTerms});
      this.windows.set(key,activity);
      if (config.pauseDuringPolls && (this.store.activePoll(now) || this.store.activeBoss(now))) continue;
      const participants=new Set(activity.map((item)=>item.speakerId)).size;
      const terms=new Set(activity.flatMap((item)=>item.terms)).size;
      const buckets=new Set(activity.map((item)=>Math.floor(item.at/60_000))).size;
      const score=participants*2+activity.length+terms*2+(buckets>=2?1:0);
      const threshold=config.sensitivity==='reserved'?{participants:4,messages:7}:config.sensitivity==='active'?{participants:2,messages:4}:{participants:config.minParticipants,messages:config.minMessages};
      const scoreThreshold=config.sensitivity==='active'?Math.min(8,config.minScore):config.sensitivity==='reserved'?Math.max(14,config.minScore):config.minScore;
      if (participants<threshold.participants || activity.length<threshold.messages || score<scoreThreshold) continue;
      const actionType=topic.actionType==='question'?'question':config.allowedActionTypes.includes(topic.actionType)?topic.actionType:config.allowedActionTypes[0];
      if (!actionType) continue;
      const question=actionType==='question'?nextQuestion(this.store,topic):undefined;
      const proposal=this.store.createSparkProposal({id:randomUUID(),channelId:this.channelId,topicId:topic.id,topicLabel:topic.label,
        score,participants,messages:activity.length,actionType,suggestionText:question?.text??null,createdAt:now,expiresAt:now+config.proposalTtlMs},
        config.maxPending,config.globalCooldownMs,config.topicCooldownMs);
      if (proposal) {created.push(proposal);if(question)this.store.setConfig('spark_question_cursors',{...this.store.config<Record<string,number>>('spark_question_cursors',{}),[topic.id]:question.index});}
    }
    return created;
  }

  tick(now=Date.now()):void {
    const config=this.config(); this.prune(now,config.windowMs);
    this.store.expireSparkProposals(now); this.store.pruneSparkMetadata(now,config.metadataRetentionMs);
  }

  snapshot(now=Date.now()):SparkTopicSnapshot[] {
    this.prune(now,this.config().windowMs);
    return [...this.windows.entries()].map(([key,events])=>{
      const topicId=key.slice(key.indexOf(':')+1); const topic=[...DEFAULT_SPARK_TOPICS,...this.store.config<SparkTopic[]>('spark_topics',[])].find((item)=>item.id===topicId);
      const participants=new Set(events.map((event)=>event.speakerId)).size;
      const terms=new Set(events.flatMap((event)=>event.terms)).size;
      const buckets=new Set(events.map((event)=>Math.floor(event.at/60_000))).size;
      return {topicId,label:topic?.label||topicId,score:participants*2+events.length+terms*2+(buckets>=2?1:0),participants,messages:events.length};
    }).filter((item)=>item.messages>0).sort((a,b)=>b.score-a.score).slice(0,20);
  }

  async handleCommand(message:ChatMessage,command:string,args:string[],now=Date.now()):Promise<string|undefined> {
    const config=this.config();
    if (command==='spark') return config.enabled&&!config.paused?'✨ Gesprächs-Funken ist aktiv; Aktionen starten nie automatisch.':'✨ Gesprächs-Funken ist pausiert oder im Dashboard deaktiviert.';
    if (command==='sparks') {
      const pending=this.store.sparkProposals('pending_approval',10);
      return pending.length ? `✨ Freigabe im Dashboard: ${pending.slice(0,5).map((item)=>`${item.id.slice(0,8)} ${item.topicLabel}`).join(' · ')}` : '✨ Keine Vorschläge offen.';
    }
    if (command==='sparkhelp') return '✨ Chat-Ideen erkennt harmlose Gesprächsthemen aus mehreren Nachrichten und Personen. Chattexte werden nicht gespeichert; Fragen und Aktionen brauchen Freigabe im Dashboard.';
    if (command==='sparktopics') { const topics=this.snapshot(now); return topics.length?`🎮 Aktive Themen: ${topics.slice(0,4).map((t)=>`${t.label} (${t.participants} Personen, Score ${t.score})`).join(' · ')}`:'🎮 Noch keine aktiven Gesprächsthemen.'; }
    const broadcaster=message.senderUserId===message.broadcasterUserId;
    const moderator=broadcaster||message.isModerator===true;
    if (command==='sparkpause'||command==='sparkresume') {
      if (!broadcaster) return '⛔ Nur Jannik darf Conversation Spark pausieren oder fortsetzen.';
      this.store.setConfig('spark_settings',{...config,paused:command==='sparkpause'});
      return command==='sparkpause'?'✨ Erkennung pausiert.':'✨ Erkennung fortgesetzt (sofern im Dashboard aktiviert).';
    }
    if (command==='sparkapprove'||command==='sparkreject') {
      if (!moderator) return '⛔ Nur Jannik oder Moderatoren dürfen Spark-Vorschläge verwalten.';
      const id=(args[0]||'').trim(); if (!id) return `✨ Nutze !${command} ID.`;
      const proposal=this.store.sparkProposals('pending_approval',100).find((item)=>item.id===id||item.id.startsWith(id));
      if (!proposal) return '✨ Offener Vorschlag nicht gefunden oder bereits abgelaufen.';
      const status=command==='sparkapprove'?'approved':'rejected';
      if (!this.store.decideSparkProposal(proposal.id,status,message.senderUserId,now)) return '✨ Dieser Vorschlag kann nicht mehr geändert werden.';
      return status==='approved'?'✨ Vorschlag freigegeben. Die Aktion muss separat im Dashboard gestartet werden.':'✨ Vorschlag abgelehnt.';
    }
    return undefined;
  }

  private prune(now:number,windowMs:number):void {
    for (const [key,events] of this.windows) {
      const current=events.filter((event)=>now-event.at<=windowMs);
      if (current.length) this.windows.set(key,current); else this.windows.delete(key);
    }
  }
}

function normalize(value:string):string {
  return value.normalize('NFKC').toLocaleLowerCase('de-DE').replace(/[’']/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/gu,' ');
}
function includesPhrase(text:string,phrase:string):boolean {
  if((` ${text} `).includes(` ${phrase} `))return true;
  if(phrase.includes(' ')||phrase.length<4)return false;
  return text.split(' ').some(token=>token.length>phrase.length+1&&token.startsWith(phrase)&&token.length<=phrase.length+12);
}
function containsSensitiveTopic(text:string):boolean{return /\b(?:diagnos(?:e|en)|krankheit|medikament(?:e|en)?|therapie|sexualität|sexuell|religion|religiös|gott|kirche|partei|wahlkampf|politisch|politiker|rassistisch|suizid)\b/iu.test(text);}
function nextQuestion(store:FeatureStore,topic:SparkTopic):{text:string;index:number}{
  const category=topic.category||'gaming',pool=SPARK_QUESTION_POOLS[category]||SPARK_QUESTION_POOLS.community;
  const cursors=store.config<Record<string,number>>('spark_question_cursors',{}),index=((cursors[topic.id]??-1)+1)%pool.length;
  return {text:pool[index]!,index};
}
