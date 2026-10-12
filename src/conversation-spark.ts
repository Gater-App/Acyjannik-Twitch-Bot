import { randomUUID, createHash } from 'node:crypto';
import type { ChatMessage } from './types.js';
import { FeatureStore, type SparkProposal } from './feature-store.js';

export type SparkActionType = 'poll' | 'quest' | 'challenge';
export interface SparkTopic { id: string; label: string; terms: string[]; actionType: SparkActionType; }
export interface SparkConfig {
  enabled: boolean; paused: boolean; windowMs: number; minParticipants: number; minMessages: number; minScore: number;
  globalCooldownMs: number; topicCooldownMs: number; proposalTtlMs: number; maxPending: number;
  chatSuggestionsEnabled: boolean; pauseDuringPolls: boolean; metadataRetentionMs: number; allowedActionTypes: SparkActionType[];
}
export const DEFAULT_SPARK_CONFIG: SparkConfig = {
  enabled:false, paused:false, windowMs:600_000, minParticipants:3, minMessages:5, minScore:12,
  globalCooldownMs:1_200_000, topicCooldownMs:3_600_000, proposalTtlMs:1_800_000, maxPending:5,
  chatSuggestionsEnabled:false, pauseDuringPolls:true, metadataRetentionMs:7*86_400_000,
  allowedActionTypes:['poll','quest','challenge'],
};

export const DEFAULT_SPARK_TOPICS: SparkTopic[] = [
  { id:'fortnite',label:'Fortnite / Spielmodus',actionType:'poll',terms:['fortnite','zero build','zero-build','battle royale','ranked','reload','build mode'] },
  { id:'minecraft',label:'Minecraft',actionType:'quest',terms:['minecraft','nether','enderdrache','ender dragon','redstone','creeper'] },
  { id:'elden-ring',label:'Elden Ring / Boss-Strategie',actionType:'poll',terms:['elden ring','malenia','radahn','bosskampf','boss strategie','boss-strategie','ausweichen','dodge','build'] },
  { id:'gaming-challenge',label:'Gaming-Challenge',actionType:'challenge',terms:['challenge','hardcore','no hit','ohne schaden','speedrun','schwierigkeitsgrad'] },
];

export interface TopicDetection { topic: SparkTopic; matchedTerms: string[]; }
export interface TopicDetector { detect(text: string, customTopics?: SparkTopic[]): TopicDetection[]; }

export class RuleBasedTopicDetector implements TopicDetector {
  detect(text: string, customTopics: SparkTopic[] = []): TopicDetection[] {
    const normalized = normalize(text);
    if (!normalized) return [];
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
    const saved=this.store.config<Partial<SparkConfig>>('spark_settings',{});
    return { ...DEFAULT_SPARK_CONFIG,...saved,
      allowedActionTypes:Array.isArray(saved.allowedActionTypes) ? saved.allowedActionTypes.filter((v):v is SparkActionType=>['poll','quest','challenge'].includes(v)) : DEFAULT_SPARK_CONFIG.allowedActionTypes };
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
      const key=`${this.channelId}:${topic.id}`;
      const activity=this.windows.get(key) || [];
      const fingerprint=createHash('sha256').update(normalize(message.message)).digest('hex');
      const sameUserCount=activity.filter((item)=>item.speakerId===message.senderUserId).length;
      if (sameUserCount>=3 || activity.some((item)=>item.speakerId===message.senderUserId && item.fingerprint===fingerprint && now-item.at<60_000)) continue;
      activity.push({eventId:message.eventId,speakerId:message.senderUserId,at:now,fingerprint,terms:matchedTerms});
      this.windows.set(key,activity);
      if (config.pauseDuringPolls && (this.store.activePoll(now) || this.store.activeBoss(now))) continue;
      const participants=new Set(activity.map((item)=>item.speakerId)).size;
      const terms=new Set(activity.flatMap((item)=>item.terms)).size;
      const buckets=new Set(activity.map((item)=>Math.floor(item.at/60_000))).size;
      const score=participants*2+activity.length+terms*2+(buckets>=2?1:0);
      if (participants<config.minParticipants || activity.length<config.minMessages || score<config.minScore) continue;
      const actionType=config.allowedActionTypes.includes(topic.actionType)?topic.actionType:config.allowedActionTypes[0];
      if (!actionType) continue;
      const proposal=this.store.createSparkProposal({id:randomUUID(),channelId:this.channelId,topicId:topic.id,topicLabel:topic.label,
        score,participants,messages:activity.length,actionType,createdAt:now,expiresAt:now+config.proposalTtlMs},
        config.maxPending,config.globalCooldownMs,config.topicCooldownMs);
      if (proposal) created.push(proposal);
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
    if (command==='sparkhelp') return '✨ Der Funke zählt Gaming-Themen nur im autorisierten Kanal (10-Minuten-Fenster, mehrere Personen/Nachrichten). Keine Chattexte werden gespeichert; Aktionen brauchen Freigabe im Dashboard oder durch Mods.';
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
function includesPhrase(text:string,phrase:string):boolean { return (` ${text} `).includes(` ${phrase} `); }
