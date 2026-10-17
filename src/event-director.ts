import { randomInt, randomUUID } from 'node:crypto';
import { FeatureStore } from './feature-store.js';
import type { ChatMessage } from './types.js';

export type ActivityLevel='quiet'|'low'|'normal'|'high';
export interface EventDirectorSettings {
  enabled:boolean; paused:boolean; autoBosses:boolean; autoDrops:boolean; autoWheel:boolean; autoChaos:boolean;
  autoSecretEvents:boolean; autoStories:boolean; minimumActivity:ActivityLevel;
  minimumGapMs:number; maxEventsPerHour:number; bossMinIntervalMs:number; bossMaxIntervalMs:number;
  bossAdaptiveHp:boolean; discordAnnouncements:boolean;
}
export interface EventCandidate { type:string; priority:number; enabled:boolean; ready:boolean; minimumActivity?:ActivityLevel; interval?:{min:number;max:number;afterCompletion?:boolean}; start:()=>string|undefined }
export interface DirectorSnapshot { settings:EventDirectorSettings; activity:{level:ActivityLevel;uniqueChatters5m:number;messages5m:number;uniqueChatters15m:number;uniqueChatters30m:number}; lastEventAt:number|null; recentAutomaticEvents:number; leaseUntil:number; reason:string; activeEvent:{type:string;id:string;status:string;endsAt:number|null}|null; nextScheduled:{type:string;at:number}|null; recentRuns:Array<{type:string;startedAt:number;reason:string}> }
const DEFAULTS:EventDirectorSettings={enabled:false,paused:false,autoBosses:false,autoDrops:false,autoWheel:false,autoChaos:false,autoSecretEvents:false,autoStories:false,minimumActivity:'normal',minimumGapMs:900_000,maxEventsPerHour:2,bossMinIntervalMs:4_500_000,bossMaxIntervalMs:6_300_000,bossAdaptiveHp:true,discordAnnouncements:false};
const LEVELS:ActivityLevel[]=['quiet','low','normal','high'];

export function adaptiveBossHp(activeChatters:number,history:Array<{status:string;participants:number}>,enabled=true):number {
  const active=Math.max(0,Math.floor(activeChatters));
  const base=active<=1?60:active<=3?60+(active-1)*45:active<=8?150+(active-3)*40:active<=15?350+(active-8)*43:Math.min(1200,650+(active-15)*35);
  if(!enabled||history.length<3)return Math.max(60,Math.min(1200,base));
  const sample=history.slice(0,10),averageParticipants=sample.reduce((sum,row)=>sum+Math.max(0,row.participants),0)/sample.length;
  const wins=sample.filter(row=>row.status==='defeated').length,successRate=wins/sample.length;
  const participationFactor=Math.max(.9,Math.min(1.1,active/Math.max(1,averageParticipants)));
  const successFactor=.9+successRate*.2;
  return Math.max(60,Math.min(1200,Math.round(base*Math.max(.8,Math.min(1.2,participationFactor*successFactor)))));
}

/** The single automatic-start gate. Activity is shared as short-lived, message-free samples between processes. */
export class EventDirector {
  private readonly owner=randomUUID();
  constructor(private readonly store:FeatureStore,private readonly choose:(max:number)=>number=(max)=>randomInt(Math.max(1,max))){}
  settings():EventDirectorSettings {
    const raw=this.store.config<Partial<EventDirectorSettings>>('event_director_settings',{});
    return {...DEFAULTS,...raw,minimumGapMs:bounded(raw.minimumGapMs,DEFAULTS.minimumGapMs,900_000,7_200_000),
      maxEventsPerHour:bounded(raw.maxEventsPerHour,2,1,4),bossMinIntervalMs:bounded(raw.bossMinIntervalMs,DEFAULTS.bossMinIntervalMs,4_500_000,6_300_000),
      bossMaxIntervalMs:bounded(raw.bossMaxIntervalMs,DEFAULTS.bossMaxIntervalMs,4_500_000,6_300_000),
      minimumActivity:LEVELS.includes(raw.minimumActivity as ActivityLevel)?raw.minimumActivity as ActivityLevel:'normal'};
  }
  updateSettings(input:Partial<EventDirectorSettings>):EventDirectorSettings {
    const next={...this.settings()};for(const key of ['enabled','paused','autoBosses','autoDrops','autoWheel','autoChaos','autoStories','autoSecretEvents','minimumActivity','minimumGapMs','maxEventsPerHour','bossMinIntervalMs','bossMaxIntervalMs','bossAdaptiveHp','discordAnnouncements'] as const){if(input[key]!==undefined)(next as unknown as Record<string,unknown>)[key]=input[key];}
    for(const k of ['enabled','paused','autoBosses','autoDrops','autoWheel','autoChaos','autoSecretEvents','autoStories','bossAdaptiveHp','discordAnnouncements'] as const)if(typeof next[k]!=='boolean')throw new Error('Event-Director-Schalter müssen Ein oder Aus sein.');
    if(!LEVELS.includes(next.minimumActivity))throw new Error('Aktivitätsschwelle ungültig.');
    if(!Number.isInteger(next.minimumGapMs)||next.minimumGapMs<900_000||next.minimumGapMs>7_200_000)throw new Error('Der globale Abstand muss 15 bis 120 Minuten betragen.');
    if(!Number.isInteger(next.maxEventsPerHour)||next.maxEventsPerHour<1||next.maxEventsPerHour>4)throw new Error('Pro Stunde sind 1 bis 4 automatische Ereignisse zulässig.');
    if(!Number.isInteger(next.bossMinIntervalMs)||!Number.isInteger(next.bossMaxIntervalMs)||next.bossMinIntervalMs<4_500_000||next.bossMaxIntervalMs>6_300_000||next.bossMinIntervalMs>next.bossMaxIntervalMs)throw new Error('Boss-Intervalle müssen innerhalb 75 bis 105 Minuten liegen.');
    this.store.setConfig('event_director_settings',next);return next;
  }
  observe(message:ChatMessage,now:number,excludedUserIds:string[]):void {
    const login=message.senderLogin.toLowerCase(),text=message.message.trim().replace(/\s+/gu,' ');
    if(excludedUserIds.includes(message.senderUserId)||message.senderUserId===message.broadcasterUserId||KNOWN_CHAT_BOTS.has(login)||/bot$/u.test(login)||!text||text.length>300||Array.from(text).length<3||text.startsWith('!'))return;
    if(!message.senderUserId||!message.eventId)return;
    this.store.miniGameTransaction(db=>{
      db.prepare('DELETE FROM event_director_activity WHERE last_seen<=?').run(now-30*60_000);
      if(db.prepare('SELECT 1 FROM event_director_activity WHERE event_id=?').get(message.eventId))return;
      const recent=db.prepare('SELECT MAX(last_seen) at FROM event_director_activity WHERE user_id=?').get(message.senderUserId) as {at:number|null};
      // One sample per account per ten seconds stops message floods inflating activity.
      if(recent.at!==null&&recent.at>now-10_000)return;
      const bucketStart=Math.floor(now/10_000)*10_000;
      db.prepare('INSERT OR IGNORE INTO event_director_activity(user_id,bucket_start,last_seen,event_id) VALUES(?,?,?,?)').run(message.senderUserId,bucketStart,now,message.eventId);
    });
  }
  activity(now=Date.now()) {
    const counts=this.store.miniGameQuery(db=>{
      const window=(milliseconds:number)=>db.prepare('SELECT COUNT(DISTINCT user_id) uniqueChatters,COUNT(*) messages FROM event_director_activity WHERE last_seen>? AND last_seen<=?').get(now-milliseconds,now) as {uniqueChatters:number;messages:number};
      return {five:window(5*60_000),fifteen:window(15*60_000),thirty:window(30*60_000)};
    });
    const uniqueChatters5m=counts.five.uniqueChatters,uniqueChatters15m=counts.fifteen.uniqueChatters,uniqueChatters30m=counts.thirty.uniqueChatters,messages5m=counts.five.messages;
    const level:ActivityLevel=uniqueChatters5m>=12&&messages5m>=30?'high':uniqueChatters5m>=5&&messages5m>=10?'normal':uniqueChatters5m>=2?'low':'quiet';
    return {level,uniqueChatters5m,messages5m,uniqueChatters15m,uniqueChatters30m};
  }
  snapshot(now=Date.now(),reason='') :DirectorSnapshot {
    const activity=this.activity(now),state=this.store.state<{lastEventAt:number|null}>('event_director_state',{lastEventAt:null});
    const recentAutomaticEvents=this.store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM event_director_runs WHERE started_at>?').get(now-60*60_000) as {n:number}).n);
    const leaseUntil=this.store.miniGameQuery(db=>(db.prepare('SELECT lease_until FROM event_director_lease WHERE id=1').get() as {lease_until:number}).lease_until);
    const activeEvent=this.store.miniGameQuery(db=>db.prepare(`SELECT type,id,status,endsAt FROM (
      SELECT 'community-chaos' type,id,status,deadline endsAt FROM community_chaos_events WHERE status='active'
      UNION ALL SELECT kind type,id,status,ends_at endsAt FROM community_interactive_events WHERE status='open' AND kind!='game_night'
      UNION ALL SELECT 'boss' type,id,status,expires_at endsAt FROM boss_fights WHERE status='active'
      UNION ALL SELECT 'mystery-drop' type,id,status,ends_at endsAt FROM mystery_drops WHERE status IN ('announced','claiming','resolving')
      UNION ALL SELECT 'chaos-wheel' type,id,status,ends_at endsAt FROM chaos_wheel_spins WHERE status IN ('spinning','active')
      UNION ALL SELECT 'community-vault' type,id,status,ends_at endsAt FROM community_vault_rounds WHERE status='active'
    ) LIMIT 1`).get() as DirectorSnapshot['activeEvent']);
    const timers=this.store.state<Record<string,number|null>>('event_director_timers',{});
    const nextScheduled=Object.entries(timers).filter((row):row is [string,number]=>typeof row[1]==='number'&&row[1]>now).sort((a,b)=>a[1]-b[1]).map(([type,at])=>({type,at}))[0]||null;
    const recentRuns=this.store.miniGameQuery(db=>db.prepare('SELECT event_type type,started_at startedAt,reason FROM event_director_runs ORDER BY started_at DESC LIMIT 10').all() as DirectorSnapshot['recentRuns']);
    return {settings:this.settings(),activity,lastEventAt:state.lastEventAt,recentAutomaticEvents,leaseUntil,reason:reason||this.store.state<string>('event_director_reason','Noch keine automatische Entscheidung getroffen.'),activeEvent:activeEvent||null,nextScheduled,recentRuns};
  }
  intervalDue(type:string,now:number,minMs:number,maxMs:number,enabled:boolean,live:boolean,active=false,completedAt?:number):boolean {
    const timers=this.store.state<Record<string,number|null>>('event_director_timers',{});
    if(!enabled||!live){if(timers[type]!==null)this.store.setState('event_director_timers',{...timers,[type]:null},now);return false;}
    let due=timers[type];if(active){if(due!==0)this.store.setState('event_director_timers',{...timers,[type]:0},now);return false;}
    if(due===undefined||due===null){due=now+minMs+this.choose(Math.max(1,maxMs-minMs+1));this.store.setState('event_director_timers',{...timers,[type]:due},now);return false;}
    if(due===0){due=(completedAt||now)+minMs+this.choose(Math.max(1,maxMs-minMs+1));this.store.setState('event_director_timers',{...timers,[type]:due},now);}
    return now>=due;
  }
  markIntervalStarted(type:string,now:number,minMs:number,maxMs:number):void {
    const timers=this.store.state<Record<string,number|null>>('event_director_timers',{});
    const next={...timers,[type]:now+minMs+this.choose(Math.max(1,maxMs-minMs+1))};this.store.setState('event_director_timers',next,now);
  }
  run(input:{live:boolean;busy:boolean;now:number;candidates:EventCandidate[]}):{message:string;type:string}|undefined {
    const now=input.now,cfg=this.settings();
    if(!cfg.enabled){this.setReason('Event Director ist deaktiviert.',now);return;}
    if(cfg.paused){this.setReason('Event Director ist pausiert.',now);return;}
    if(!input.live){this.setReason('Twitch-Stream ist offline.',now);return;}
    if(input.busy){this.setReason('Ein anderes Community-Spiel oder eine Chataktion läuft.',now);return;}
    const activity=this.activity(now);if(LEVELS.indexOf(activity.level)<LEVELS.indexOf(cfg.minimumActivity)){this.setReason('Die tatsächliche Chataktivität liegt unter der eingestellten Schwelle.',now);return;}
    const state=this.store.state<{lastEventAt:number|null;lastType?:string}>('event_director_state',{lastEventAt:null});
    if(state.lastEventAt!==null&&now-state.lastEventAt<cfg.minimumGapMs){this.setReason('Der gemeinsame Event-Cooldown ist aktiv.',now);return;}
    if(this.store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM event_director_runs WHERE started_at>?').get(now-60*60_000) as {n:number}).n)>=cfg.maxEventsPerHour){this.setReason('Das automatische Event-Budget dieser Stunde ist erreicht.',now);return;}
    const candidates=input.candidates.filter(c=>c.enabled&&c.ready&&LEVELS.indexOf(activity.level)>=LEVELS.indexOf(c.minimumActivity||'low'))
      .map(candidate=>{const last=this.store.miniGameQuery(db=>(db.prepare('SELECT MAX(started_at) at FROM event_director_runs WHERE event_type=?').get(candidate.type) as {at:number|null}).at)||0;const aging=Math.min(3,Math.floor((now-(last||now-90*60_000))/(90*60_000)));return {candidate,effective:candidate.priority-aging};})
      .sort((a,b)=>a.effective-b.effective||a.candidate.priority-b.candidate.priority).map(entry=>entry.candidate);
    if(!candidates.length){this.setReason('Kein aktiviertes Event ist fällig und konfliktfrei.',now);return;}
    const claimed=this.store.miniGameTransaction(db=>{
      const row=db.prepare('SELECT owner,lease_until FROM event_director_lease WHERE id=1').get() as {owner:string|null;lease_until:number};
      if(row.lease_until>now&&row.owner!==this.owner)return false;
      db.prepare('UPDATE event_director_lease SET owner=?,lease_until=?,updated_at=? WHERE id=1').run(this.owner,now+30_000,now);return true;
    });
    if(!claimed){this.setReason('Eine andere Scheduler-Instanz hält gerade die Start-Lease.',now);return;}
    try {
      for(const candidate of candidates){
        let message:string|undefined;try{message=candidate.start();}catch(error){this.setReason(`Start von ${candidate.type} fehlgeschlagen: ${error instanceof Error?error.message:'unbekannter Fehler'}`,now);continue;}if(!message)continue;
        const id=randomUUID();
        this.store.miniGameTransaction(db=>{
          db.prepare('INSERT INTO event_director_runs(id,event_type,started_at,reason) VALUES(?,?,?,\'automatic\')').run(id,candidate.type,now);
          this.store.setState('event_director_state',{lastEventAt:now,lastType:candidate.type},now);
        });
        if(candidate.interval){if(candidate.interval.afterCompletion)this.store.setState('event_director_timers',{...this.store.state<Record<string,number|null>>('event_director_timers',{}),[candidate.type]:0},now);else this.markIntervalStarted(candidate.type,now,candidate.interval.min,candidate.interval.max);}
        this.setReason(`${candidate.type} wurde automatisch gestartet.`,now);
        return {message,type:candidate.type};
      }
      this.setReason('Ein fälliger Eventstart wurde von der jeweiligen Engine abgelehnt.',now);return;
    } finally {this.store.miniGameQuery(db=>db.prepare('UPDATE event_director_lease SET owner=NULL,lease_until=0,updated_at=? WHERE id=1 AND owner=?').run(now,this.owner));}
  }
  private setReason(reason:string,now:number):void{this.store.setState('event_director_reason',reason.slice(0,240),now);}
}
function bounded(value:unknown,fallback:number,min:number,max:number):number{return Number.isInteger(value)?Math.max(min,Math.min(max,Number(value))):fallback;}
const KNOWN_CHAT_BOTS=new Set(['nightbot','streamelements','streamlabs','moobot','fossabot','wizebot','commanderroot','sery_bot','serybot']);
