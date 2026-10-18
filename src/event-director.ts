import { randomInt, randomUUID } from 'node:crypto';
import { FeatureStore } from './feature-store.js';
import type { ChatMessage } from './types.js';

export type ActivityLevel='quiet'|'low'|'normal'|'high';
export interface EventDirectorSettings {
  enabled:boolean; paused:boolean; autoBosses:boolean; autoDrops:boolean; autoWheel:boolean; autoChaos:boolean; adaptiveEventWeighting:boolean;
  autoSecretEvents:boolean; autoStories:boolean; minimumActivity:ActivityLevel;
  minimumGapMs:number; maxEventsPerHour:number; bossMinIntervalMs:number; bossMaxIntervalMs:number;
  bossAdaptiveHp:boolean; discordAnnouncements:boolean;
}
export interface EventCandidate { type:string; priority:number; enabled:boolean; ready:boolean; minimumActivity?:ActivityLevel; interval?:{min:number;max:number;afterCompletion?:boolean}; intervalKey?:string; start:()=>string|undefined }
export interface DirectorRun {id:string;type:string;startedAt:number;scheduledFor:number|null;endedAt:number|null;status:string;triggeredBy:string;sourceEventId:string|null;participants:number;distinctParticipants:number;xp:number;activeChatters:number;success:boolean|null;payoutStatus:string;deliveryStatus:string;outcome:string|null;error:string|null;reason:string}
export interface DirectorSnapshot { settings:EventDirectorSettings; activity:{level:ActivityLevel;uniqueChatters5m:number;chatSignals5m:number;uniqueChatters15m:number;uniqueChatters30m:number}; lastEventAt:number|null; recentAutomaticEvents:number; leaseUntil:number; reason:string; activeEvent:{type:string;id:string;status:string;endsAt:number|null}|null; nextScheduled:{type:string;at:number}|null; recentRuns:DirectorRun[] }
const DEFAULTS:EventDirectorSettings={enabled:false,paused:false,autoBosses:false,autoDrops:false,autoWheel:false,autoChaos:false,adaptiveEventWeighting:true,autoSecretEvents:false,autoStories:false,minimumActivity:'normal',minimumGapMs:900_000,maxEventsPerHour:2,bossMinIntervalMs:4_500_000,bossMaxIntervalMs:6_300_000,bossAdaptiveHp:true,discordAnnouncements:false};
const LEVELS:ActivityLevel[]=['quiet','low','normal','high'];

export function adaptiveBossHp(activeChatters:number,history:Array<{status:string;participants:number;averageDamage?:number;durationMs?:number}>,enabled=true):number {
  const active=Math.max(0,Math.floor(activeChatters));
  const base=active<=1?60:active<=3?60+(active-1)*45:active<=8?150+(active-3)*40:active<=15?350+(active-8)*43:Math.min(1200,650+(active-15)*35);
  if(!enabled||history.length<3)return Math.max(60,Math.min(1200,base));
  const sample=history.slice(0,10),averageParticipants=sample.reduce((sum,row)=>sum+Math.max(0,row.participants),0)/sample.length;
  const wins=sample.filter(row=>row.status==='defeated').length,successRate=wins/sample.length;
  const participationFactor=Math.max(.9,Math.min(1.1,active/Math.max(1,averageParticipants)));
  const successFactor=.9+successRate*.2;
  const measured=sample.filter(row=>Number.isFinite(row.averageDamage)&&Number.isFinite(row.durationMs)&&row.durationMs!>0);
  const damageRate=measured.length?measured.reduce((sum,row)=>sum+(row.averageDamage!/Math.max(1,row.durationMs!))*60_000,0)/measured.length:0;
  const paceFactor=measured.length?Math.max(.95,Math.min(1.05,1+(damageRate-8)/160)):1;
  const durationFactor=measured.length?Math.max(.95,Math.min(1.05,1+((5*60_000-measured.reduce((sum,row)=>sum+row.durationMs!,0)/measured.length)/(50*60_000)))):1;
  return Math.max(60,Math.min(1200,Math.round(base*Math.max(.8,Math.min(1.2,participationFactor*successFactor*paceFactor*durationFactor)))));
}

/** The single automatic-start gate. Activity is shared as short-lived, message-free samples between processes. */
export class EventDirector {
  constructor(private readonly store:FeatureStore,private readonly choose:(max:number)=>number=(max)=>randomInt(Math.max(1,max))){}
  settings():EventDirectorSettings {
    const raw=this.store.config<Partial<EventDirectorSettings>>('event_director_settings',{});
    return {...DEFAULTS,...raw,minimumGapMs:bounded(raw.minimumGapMs,DEFAULTS.minimumGapMs,900_000,7_200_000),
      maxEventsPerHour:bounded(raw.maxEventsPerHour,2,1,4),bossMinIntervalMs:bounded(raw.bossMinIntervalMs,DEFAULTS.bossMinIntervalMs,4_500_000,6_300_000),
      bossMaxIntervalMs:bounded(raw.bossMaxIntervalMs,DEFAULTS.bossMaxIntervalMs,4_500_000,6_300_000),
      minimumActivity:LEVELS.includes(raw.minimumActivity as ActivityLevel)?raw.minimumActivity as ActivityLevel:'normal'};
  }
  updateSettings(input:Partial<EventDirectorSettings>):EventDirectorSettings {
    const next={...this.settings()};for(const key of ['enabled','paused','autoBosses','autoDrops','autoWheel','autoChaos','adaptiveEventWeighting','autoStories','autoSecretEvents','minimumActivity','minimumGapMs','maxEventsPerHour','bossMinIntervalMs','bossMaxIntervalMs','bossAdaptiveHp','discordAnnouncements'] as const){if(input[key]!==undefined)(next as unknown as Record<string,unknown>)[key]=input[key];}
    for(const k of ['enabled','paused','autoBosses','autoDrops','autoWheel','autoChaos','adaptiveEventWeighting','autoSecretEvents','autoStories','bossAdaptiveHp','discordAnnouncements'] as const)if(typeof next[k]!=='boolean')throw new Error('Event-Director-Schalter müssen Ein oder Aus sein.');
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
    const uniqueChatters5m=counts.five.uniqueChatters,uniqueChatters15m=counts.fifteen.uniqueChatters,uniqueChatters30m=counts.thirty.uniqueChatters,chatSignals5m=counts.five.messages;
    const level:ActivityLevel=uniqueChatters5m>=12&&chatSignals5m>=30?'high':uniqueChatters5m>=5&&chatSignals5m>=10?'normal':uniqueChatters5m>=2?'low':'quiet';
    return {level,uniqueChatters5m,chatSignals5m,uniqueChatters15m,uniqueChatters30m};
  }
  snapshot(now=Date.now(),reason='') :DirectorSnapshot {
    this.reconcileLifecycle(now);
    const cfg=this.settings(),activity=this.activity(now),state=this.store.state<{lastEventAt:number|null}>('event_director_state',{lastEventAt:null});
    const recentAutomaticEvents=this.store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM event_director_runs WHERE started_at>? AND triggered_by='system' AND status IN ('started','active','completed','aborted')").get(now-60*60_000) as {n:number}).n);
    const leaseUntil=this.store.miniGameQuery(db=>(db.prepare('SELECT lease_until FROM event_director_lease WHERE id=1').get() as {lease_until:number}).lease_until);
    const activeEvent=this.store.miniGameQuery(db=>db.prepare(`SELECT type,id,status,endsAt FROM (
      SELECT 'community-chaos' type,id,status,deadline endsAt FROM community_chaos_events WHERE status='active'
      UNION ALL SELECT kind type,id,status,ends_at endsAt FROM community_interactive_events WHERE status='open' AND kind!='game_night'
      UNION ALL SELECT 'boss' type,id,status,expires_at endsAt FROM boss_fights WHERE status='active'
      UNION ALL SELECT 'mystery-drop' type,id,status,ends_at endsAt FROM mystery_drops WHERE status IN ('announced','claiming','resolving')
      UNION ALL SELECT 'chaos-wheel' type,id,status,ends_at endsAt FROM chaos_wheel_spins WHERE status IN ('spinning','active')
      UNION ALL SELECT 'community-vault' type,id,status,ends_at endsAt FROM community_vault_rounds WHERE status='active'
    ) LIMIT 1`).get() as DirectorSnapshot['activeEvent']);
    const timers=this.store.state<Record<string,number|null>>('event_director_timers',{}),scheduled=Object.entries(timers).filter((row):row is [string,number]=>typeof row[1]==='number'&&row[1]>now).map(([key,at])=>({type:key==='drop'?'mystery-drop':key,at}));
    const chaosSettings=this.store.config<{enabled?:boolean;autoEnabled?:boolean}>('community_chaos_settings',{}),chaosNext=this.store.miniGameQuery(db=>(db.prepare('SELECT next_at at FROM community_chaos_scheduler WHERE id=1').get() as {at:number|null}|undefined)?.at||null);
    if((cfg.autoChaos||cfg.autoStories)&&chaosSettings.enabled===true&&chaosSettings.autoEnabled===true&&chaosNext&&chaosNext>now)scheduled.push({type:'story-or-chaos',at:chaosNext});
    const arcade=this.store.config<{wheelAutoPilotEnabled?:boolean}>('arcade_settings',{}),lastWheel=this.store.miniGameQuery(db=>(db.prepare("SELECT created_at at FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {at:number}|undefined)?.at||null);
    if(cfg.autoWheel&&arcade.wheelAutoPilotEnabled===true&&!this.store.config('arcade_wheel_paused',false)&&lastWheel!==null&&lastWheel+30*60_000>now)scheduled.push({type:'chaos-wheel',at:lastWheel+30*60_000});
    const nextScheduled=scheduled.sort((a,b)=>a.at-b.at)[0]||null;
    const recentRunsRaw=this.store.miniGameQuery(db=>db.prepare('SELECT id,event_type type,started_at startedAt,scheduled_for scheduledFor,completed_at endedAt,status,triggered_by triggeredBy,source_event_id sourceEventId,participant_count participants,distinct_participant_count distinctParticipants,xp_total xp,active_chatter_count activeChatters,success,payout_status payoutStatus,delivery_status deliveryStatus,outcome,error_status error,reason FROM event_director_runs ORDER BY CASE WHEN status=\'planned\' THEN 0 ELSE 1 END,COALESCE(scheduled_for,started_at) DESC LIMIT 20').all() as Array<Omit<DirectorRun,'success'>&{success:number|null}>);
    const recentRuns=recentRunsRaw.map(row=>({...row,success:row.success===null?null:Boolean(row.success)}));
    return {settings:cfg,activity,lastEventAt:state.lastEventAt,recentAutomaticEvents,leaseUntil,reason:reason||this.store.state<string>('event_director_reason','Noch keine automatische Entscheidung getroffen.'),activeEvent:activeEvent||null,nextScheduled,recentRuns};
  }
  intervalDue(type:string,now:number,minMs:number,maxMs:number,enabled:boolean,live:boolean,active=false,completedAt?:number,eventType=type):boolean {
    const timers=this.store.state<Record<string,number|null>>('event_director_timers',{});
    if(!enabled||!live){if(timers[type]!==null)this.store.setState('event_director_timers',{...timers,[type]:null},now);this.skipPlanned(eventType,now,enabled?'Stream offline':'Eventtyp deaktiviert');return false;}
    let due=timers[type];if(active){if(due!==0)this.store.setState('event_director_timers',{...timers,[type]:0},now);return false;}
    if(due===undefined||due===null){due=now+minMs+this.choose(Math.max(1,maxMs-minMs+1));this.store.setState('event_director_timers',{...timers,[type]:due},now);this.writePlan(eventType,due,now);return false;}
    if(due===0){due=(completedAt||now)+minMs+this.choose(Math.max(1,maxMs-minMs+1));this.store.setState('event_director_timers',{...timers,[type]:due},now);this.writePlan(eventType,due,now);}
    return now>=due;
  }
  markIntervalStarted(type:string,now:number,minMs:number,maxMs:number,eventType=type):void {
    const timers=this.store.state<Record<string,number|null>>('event_director_timers',{});
    const at=now+minMs+this.choose(Math.max(1,maxMs-minMs+1)),next={...timers,[type]:at};this.store.setState('event_director_timers',next,now);this.writePlan(eventType,at,now);
  }
  run(input:{live:boolean;busy:boolean;now:number;candidates:EventCandidate[]}):{message:string;type:string}|undefined {
    const now=input.now,cfg=this.settings();this.reconcileLifecycle(now);
    if(!cfg.enabled){this.setReason('Event Director ist deaktiviert.',now);return;}
    if(cfg.paused){this.setReason('Event Director ist pausiert.',now);return;}
    if(!input.live){this.setReason('Twitch-Stream ist offline.',now);return;}
    if(input.busy){this.setReason('Ein anderes Community-Spiel oder eine Chataktion läuft.',now);return;}
    const activity=this.activity(now);if(LEVELS.indexOf(activity.level)<LEVELS.indexOf(cfg.minimumActivity)){this.setReason('Die tatsächliche Chataktivität liegt unter der eingestellten Schwelle.',now);return;}
    const state=this.store.state<{lastEventAt:number|null;lastType?:string}>('event_director_state',{lastEventAt:null});
    if(state.lastEventAt!==null&&now-state.lastEventAt<cfg.minimumGapMs){this.setReason('Der gemeinsame Event-Cooldown ist aktiv.',now);return;}
    if(this.store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM event_director_runs WHERE started_at>? AND triggered_by='system' AND status IN ('started','active','completed','aborted')").get(now-60*60_000) as {n:number}).n)>=cfg.maxEventsPerHour){this.setReason('Das automatische Event-Budget dieser Stunde ist erreicht.',now);return;}
    const candidates=input.candidates.filter(c=>c.enabled&&c.ready&&LEVELS.indexOf(activity.level)>=LEVELS.indexOf(c.minimumActivity||'low'))
      .map(candidate=>{const rows=this.store.miniGameQuery(db=>db.prepare("SELECT participant_count participants,active_chatter_count activeChatters,success FROM event_director_runs WHERE event_type=? AND status='completed' ORDER BY started_at DESC LIMIT 10").all(candidate.type) as Array<{participants:number;activeChatters:number;success:number|null}>);const last=this.store.miniGameQuery(db=>(db.prepare('SELECT MAX(started_at) at FROM event_director_runs WHERE event_type=?').get(candidate.type) as {at:number|null}).at)||0;const aging=Math.min(3,Math.floor((now-(last||now-90*60_000))/(90*60_000)));const noParticipation=rows.length?rows.filter(row=>row.participants===0).length/rows.length:0;const successRate=rows.length?rows.filter(row=>row.success===1).length/rows.length:.5;const engagement=rows.length?rows.reduce((sum,row)=>sum+Math.min(1,row.participants/Math.max(1,row.activeChatters)),0)/rows.length:.5;const recentRepeat=this.store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM (SELECT event_type FROM event_director_runs WHERE status IN ('completed','active','started') ORDER BY started_at DESC LIMIT 2) WHERE event_type=?").get(candidate.type) as {n:number}).n);const penalty=cfg.adaptiveEventWeighting?noParticipation*2+(0.5-successRate)*1.2+(0.5-engagement)*1.2+(recentRepeat?0.5:0):0;return {candidate,effective:candidate.priority+penalty-aging};})
      .sort((a,b)=>a.effective-b.effective||a.candidate.priority-b.candidate.priority).map(entry=>entry.candidate);
    if(!candidates.length){this.setReason('Kein aktiviertes Event ist fällig und konfliktfrei.',now);return;}
    const leaseOwner=randomUUID();const claimed=this.claimLease(now,leaseOwner);
    if(!claimed){this.setReason('Eine andere Scheduler-Instanz hält gerade die Start-Lease.',now);return;}
    try {
      for(const candidate of candidates){
        let message:string|undefined;try{message=candidate.start();}catch(error){const reason=`Start von ${candidate.type} fehlgeschlagen: ${error instanceof Error?error.message:'unbekannter Fehler'}`;this.recordFailure(candidate.type,reason,'system',now);this.skipPlanned(candidate.type,now,reason);this.setReason(reason,now);continue;}if(!message){const reason='Die Event-Engine hat den Start abgelehnt.';this.recordFailure(candidate.type,reason,'system',now);this.skipPlanned(candidate.type,now,reason);continue;}
        const source=this.activeSourceEvent(now);if(!source){const reason=`${candidate.type} hat keine aktive, persistierte Eventinstanz erzeugt.`;this.recordFailure(candidate.type,reason,'system',now);this.skipPlanned(candidate.type,now,reason);this.setReason(reason,now);continue;}const id=randomUUID();
        this.store.miniGameTransaction(db=>{
          const plan=db.prepare("SELECT id FROM event_director_runs WHERE event_type=? AND status='planned' ORDER BY scheduled_for DESC LIMIT 1").get(candidate.type) as {id:string}|undefined;
          if(plan)db.prepare("UPDATE event_director_runs SET started_at=?,completed_at=NULL,status='active',triggered_by='system',source_event_id=?,payout_status='pending',active_chatter_count=?,reason='automatic' WHERE id=? AND status='planned'").run(now,source.id,activity.uniqueChatters5m,plan.id);
          else db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,reason,status,triggered_by,source_event_id,payout_status,active_chatter_count) VALUES(?,?,?,'automatic','active','system',?,'pending',?)").run(id,candidate.type,now,source.id,activity.uniqueChatters5m);
          this.store.setState('event_director_state',{lastEventAt:now,lastType:candidate.type},now);
        });
        if(candidate.interval){const intervalKey=candidate.intervalKey||candidate.type;if(candidate.interval.afterCompletion)this.store.setState('event_director_timers',{...this.store.state<Record<string,number|null>>('event_director_timers',{}),[intervalKey]:0},now);else this.markIntervalStarted(intervalKey,now,candidate.interval.min,candidate.interval.max,candidate.type);}
        this.setReason(`${candidate.type} wurde automatisch gestartet.`,now);
        return {message,type:candidate.type};
      }
      this.setReason('Ein fälliger Eventstart wurde von der jeweiligen Engine abgelehnt.',now);return;
    } finally {this.releaseLease(now,leaseOwner);}
  }
  manualStart(type:string,actor:string,now:number,start:()=>string|undefined):{id:string;message:string}{
    const leaseOwner=randomUUID();const claimed=this.claimLease(now,leaseOwner);if(!claimed)throw new Error('Eine andere Event-Director-Aktion läuft gerade. Bitte kurz warten.');
    try{
      if(this.activeSourceEvent(now))throw new Error('Ein inkompatibles Community-Event läuft bereits.');
      let message:string|undefined;try{message=start()}catch(error){this.recordFailure(type,error instanceof Error?error.message:'Unbekannter Startfehler',actor,now);throw error;}
      if(!message){this.recordFailure(type,'Die vorhandene Event-Engine hat den Start abgelehnt.',actor,now);throw new Error('Das Event konnte wegen seines aktuellen Zustands oder eines Konflikts nicht gestartet werden.');}
      const source=this.activeSourceEvent(now);if(!source){const error=new Error('Der Start wurde nicht als aktive Eventinstanz gespeichert.');this.recordFailure(type,error.message,actor,now);throw error;}const id=randomUUID();
      const activeChatters=this.activity(now).uniqueChatters5m;
      this.store.miniGameTransaction(db=>{db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,reason,status,triggered_by,source_event_id,payout_status,active_chatter_count) VALUES(?,?,?,'manual',?,?,?,'pending',?)").run(id,type,now,source?'active':'started',actor,source.id,activeChatters);this.store.setState('event_director_state',{lastEventAt:now,lastType:type},now);});
      if(type==='boss'){this.skipPlanned('boss',now,'Der Timer wurde durch einen manuellen Bossstart ersetzt.');this.store.setState('event_director_timers',{...this.store.state<Record<string,number|null>>('event_director_timers',{}),boss:0},now);}
      if(type==='mystery-drop')this.markIntervalStarted('drop',now,60*60_000,90*60_000,'mystery-drop');
      this.setReason(`${type} wurde manuell von ${actor} gestartet.`,now);return {id,message};
    }finally{this.releaseLease(now,leaseOwner);}
  }
  private claimLease(now:number,owner:string):boolean{return this.store.miniGameTransaction(db=>{const row=db.prepare('SELECT owner,lease_until FROM event_director_lease WHERE id=1').get() as {owner:string|null;lease_until:number};if(row.lease_until>now)return false;db.prepare('UPDATE event_director_lease SET owner=?,lease_until=?,updated_at=? WHERE id=1').run(owner,now+30_000,now);return true;});}
  private releaseLease(now:number,owner:string):void{this.store.miniGameQuery(db=>db.prepare('UPDATE event_director_lease SET owner=NULL,lease_until=0,updated_at=? WHERE id=1 AND owner=?').run(now,owner));}
  private writePlan(type:string,scheduledFor:number,now:number):void{this.store.miniGameTransaction(db=>{const plan=db.prepare("SELECT id FROM event_director_runs WHERE event_type=? AND status='planned' ORDER BY scheduled_for DESC LIMIT 1").get(type) as {id:string}|undefined;if(plan)db.prepare("UPDATE event_director_runs SET scheduled_for=?,reason='automatic schedule',triggered_by='system' WHERE id=? AND status='planned'").run(scheduledFor,plan.id);else db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,scheduled_for,reason,status,triggered_by,payout_status) VALUES(?,?,?,?,'automatic schedule','planned','system','not-applicable')").run(randomUUID(),type,now,scheduledFor);});}
  private skipPlanned(type:string,now:number,reason:string):void{this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status='skipped',completed_at=?,reason=?,outcome='skipped' WHERE event_type=? AND status='planned'").run(now,reason.slice(0,240),type));}
  finishSource(sourceEventId:string,status:'completed'|'aborted'|'failed'|'skipped',now:number,payoutStatus='unknown'):void{this.reconcileLifecycle(now);this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status=?,completed_at=?,payout_status=? WHERE source_event_id=? AND status IN ('started','active','completed')").run(status,now,payoutStatus,sourceEventId));}
  private activeSourceEvent(now:number):{type:string;id:string;status:string;endsAt:number|null}|null{return this.store.miniGameQuery(db=>db.prepare(`SELECT type,id,status,endsAt FROM (
      SELECT 'community-chaos' type,id,status,deadline endsAt FROM community_chaos_events WHERE status='active'
      UNION ALL SELECT kind type,id,status,ends_at endsAt FROM community_interactive_events WHERE status='open' AND kind!='game_night'
      UNION ALL SELECT 'boss' type,id,status,expires_at endsAt FROM boss_fights WHERE status='active'
      UNION ALL SELECT 'mystery-drop' type,id,status,ends_at endsAt FROM mystery_drops WHERE status IN ('announced','claiming','resolving')
      UNION ALL SELECT 'chaos-wheel' type,id,status,ends_at endsAt FROM chaos_wheel_spins WHERE status IN ('spinning','active')
      UNION ALL SELECT 'community-vault' type,id,status,ends_at endsAt FROM community_vault_rounds WHERE status='active'
    ) LIMIT 1`).get() as DirectorSnapshot['activeEvent']||null);}
  private recordFailure(type:string,reason:string,actor:string,now:number):void{this.store.miniGameQuery(db=>db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,completed_at,reason,status,triggered_by,payout_status,error_status) VALUES(?,?,?,?,?,'failed',?,'none',?)").run(randomUUID(),type,now,now,actor==='system'?`automatic: ${reason}`:`manual: ${reason}`,actor,reason.slice(0,240)));}
  private reconcileLifecycle(now:number):void{
    const active=this.activeSourceEvent(now);
    if(active){this.store.miniGameTransaction(db=>{if(db.prepare('SELECT 1 FROM event_director_runs WHERE source_event_id=?').get(active.id))return;const type=active.type==='mystery_case'||active.type==='elio_rescue'||active.type==='secret_portal'?'secret-event':active.type;db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,reason,status,triggered_by,source_event_id,payout_status,active_chatter_count) VALUES(?,?,?,'recovered after restart','active','recovery',?,'pending',?)").run(randomUUID(),type,now,active.id,this.activity(now).uniqueChatters5m);});}
    const pending=this.store.miniGameQuery(db=>db.prepare("SELECT id,event_type type,source_event_id sourceId FROM event_director_runs WHERE status IN ('started','active') AND source_event_id IS NOT NULL ORDER BY started_at DESC LIMIT 50").all() as Array<{id:string;type:string;sourceId:string}>);
    for(const run of pending){
      const result=this.store.miniGameQuery(db=>{
        if(run.type==='boss'){const row=db.prepare('SELECT status,finished_at endedAt FROM boss_fights WHERE id=?').get(run.sourceId) as {status:string;endedAt:number|null}|undefined;if(!row)return;const stats=db.prepare('SELECT COUNT(*) participants,COUNT(DISTINCT user_id) distinctParticipants,COALESCE(SUM(xp_awarded),0) xp FROM boss_participants WHERE boss_id=?').get(run.sourceId) as {participants:number;distinctParticipants:number;xp:number};const payout=db.prepare("SELECT reward_granted granted FROM boss_fights WHERE id=?").get(run.sourceId) as {granted:number};const delivery=db.prepare("SELECT status FROM discord_event_outbox WHERE event_type='event.director.boss' AND aggregate_id=? ORDER BY created_at DESC LIMIT 1").get(run.sourceId) as {status:string}|undefined;return {row,status:row.status==='active'?'active':row.status==='defeated'||row.status==='timeout'?'completed':row.status==='ended'||row.status==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:stats.xp,outcome:row.status,success:row.status==='defeated',payoutStatus:payout.granted?'settled':'none',deliveryStatus:delivery?.status||'not-configured'};}
        if(run.type==='story-or-chaos'||run.type==='community-chaos'){const row=db.prepare('SELECT status,completed_at endedAt,result_json result FROM community_chaos_events WHERE id=?').get(run.sourceId) as {status:string;endedAt:number|null;result:string|null}|undefined;if(!row)return;const stats=db.prepare('SELECT COUNT(*) participants,COUNT(DISTINCT user_id) distinctParticipants FROM community_chaos_participants WHERE event_id=?').get(run.sourceId) as {participants:number;distinctParticipants:number};const data=row.result?JSON.parse(row.result) as {totalXp?:number;participants?:number;success?:boolean}:{};const story=db.prepare("SELECT o.status FROM elio_chronicles_events e LEFT JOIN discord_event_outbox o ON o.id=e.diary_outbox_id WHERE e.chaos_event_id=?").get(run.sourceId) as {status:string|null}|undefined;const delivery=db.prepare("SELECT status FROM discord_event_outbox WHERE event_type='community.chaos' AND aggregate_id=? ORDER BY created_at DESC LIMIT 1").get(run.sourceId) as {status:string}|undefined;return {row,status:row.status==='active'?'active':row.status==='completed'?'completed':row.status==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:data.totalXp||0,outcome:row.status,success:row.status==='completed'&&(data.totalXp||0)>0,payoutStatus:row.status==='completed'?'settled':row.status==='canceled'?'none':'pending',deliveryStatus:story?.status?`story:${story.status}`:delivery?.status||'not-configured'};}
        if(run.type==='mystery-drop'){const row=db.prepare('SELECT status,resolved_at endedAt,result_json result FROM mystery_drops WHERE id=?').get(run.sourceId) as {status:string;endedAt:number|null;result:string|null}|undefined;if(!row)return;const stats=db.prepare('SELECT COUNT(*) participants,COUNT(DISTINCT user_id) distinctParticipants,COALESCE(SUM(reward_xp),0) xp FROM mystery_claims WHERE drop_id=?').get(run.sourceId) as {participants:number;distinctParticipants:number;xp:number};const delivery=db.prepare("SELECT status FROM discord_event_outbox WHERE event_type='mystery.drop' AND aggregate_id=? ORDER BY created_at DESC LIMIT 1").get(run.sourceId) as {status:string}|undefined;return {row,status:['announced','claiming','resolving'].includes(row.status)?'active':row.status==='completed'||row.status==='expired'?'completed':row.status==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:stats.xp,outcome:row.status,success:row.status==='completed'&&stats.participants>0,payoutStatus:row.status==='completed'?'settled':row.status==='canceled'?'none':'pending',deliveryStatus:delivery?.status||'not-configured'};}
        if(run.type==='chaos-wheel'){const row=db.prepare('SELECT status,resolved_at endedAt,reward_status payoutStatus FROM chaos_wheel_spins WHERE id=?').get(run.sourceId) as {status:string;endedAt:number|null;payoutStatus:string}|undefined;if(!row)return;const delivery=db.prepare("SELECT status FROM discord_event_outbox WHERE event_type='chaos-wheel.action' AND aggregate_id=? ORDER BY created_at DESC LIMIT 1").get(run.sourceId) as {status:string}|undefined;return {row,status:row.status==='active'||row.status==='spinning'?'active':row.status==='completed'?'completed':row.status==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:0,distinctParticipants:0,xp:0,outcome:row.status,success:row.status==='completed',payoutStatus:row.payoutStatus,deliveryStatus:delivery?.status||'not-configured'};}
        const row=db.prepare('SELECT status,updated_at endedAt,settings_json settings,kind FROM community_interactive_events WHERE id=?').get(run.sourceId) as {status:string;endedAt:number;settings:string;kind:string}|undefined;if(!row)return;const stats=db.prepare("SELECT COUNT(*) participants,COUNT(DISTINCT identity_key) distinctParticipants FROM community_interactive_participants WHERE event_id=? AND status!='withdrawn'").get(run.sourceId) as {participants:number;distinctParticipants:number};const prefix=row.kind==='battle'?'community-battle:':'secret-event:';const ledger=db.prepare("SELECT COALESCE(SUM(amount),0) xp FROM xp_ledger WHERE event_id LIKE ?").get(`${prefix}${run.sourceId}:%`) as {xp:number};const delivery=db.prepare("SELECT status FROM discord_event_outbox WHERE aggregate_id=? AND event_type IN ('community.battle','community.secret-event') ORDER BY created_at DESC LIMIT 1").get(run.sourceId) as {status:string}|undefined;return {row,status:row.status==='open'||row.status==='scheduled'?'active':row.status==='completed'?'completed':row.status==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:ledger.xp,outcome:row.status,success:row.status==='completed',payoutStatus:row.status==='completed'?'settled':row.status==='canceled'?'none':'pending',deliveryStatus:delivery?.status||'not-configured'};
      });
      if(!result)continue;
      this.store.miniGameQuery(db=>db.prepare('UPDATE event_director_runs SET status=?,completed_at=?,participant_count=?,distinct_participant_count=?,xp_total=?,outcome=?,success=?,payout_status=?,delivery_status=? WHERE id=? AND status IN (\'started\',\'active\')').run(result.status,result.status==='active'?null:(result.endedAt||now),result.participants,result.distinctParticipants,result.xp,String(result.outcome),result.success?1:0,result.payoutStatus,result.deliveryStatus||'not-configured',run.id));
    }
  }
  private setReason(reason:string,now:number):void{this.store.setState('event_director_reason',reason.slice(0,240),now);}
}
function bounded(value:unknown,fallback:number,min:number,max:number):number{return Number.isInteger(value)?Math.max(min,Math.min(max,Number(value))):fallback;}
const KNOWN_CHAT_BOTS=new Set(['nightbot','streamelements','streamlabs','moobot','fossabot','wizebot','commanderroot','sery_bot','serybot']);
