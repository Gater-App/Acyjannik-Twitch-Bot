import { randomInt, randomUUID } from 'node:crypto';
import { FeatureStore } from './feature-store.js';
import type { ChatMessage } from './types.js';

export type ActivityLevel='quiet'|'low'|'normal'|'high';
export interface EventDirectorSettings {
  enabled:boolean; paused:boolean; queuePaused:boolean; autoBosses:boolean; autoDrops:boolean; autoWheel:boolean; autoChaos:boolean; adaptiveEventWeighting:boolean;
  autoSecretEvents:boolean; autoStories:boolean; minimumActivity:ActivityLevel;
  minimumGapMs:number; maxEventsPerHour:number; bossMinIntervalMs:number; bossMaxIntervalMs:number;
  bossAdaptiveHp:boolean; discordAnnouncements:boolean;
}
export interface EventCandidate { type:string; priority:number; enabled:boolean; ready:boolean; minimumActivity?:ActivityLevel; interval?:{min:number;max:number;afterCompletion?:boolean}; intervalKey?:string; start:()=>string|undefined; manualStart?:(actor:string,payload:Record<string,unknown>)=>string|undefined }
export interface DirectorRun {id:string;type:string;startedAt:number;scheduledFor:number|null;endedAt:number|null;status:string;triggeredBy:string;sourceEventId:string|null;participants:number;distinctParticipants:number;xp:number;activeChatters:number;success:boolean|null;payoutStatus:string;deliveryStatus:string;outcome:string|null;error:string|null;reason:string}
export interface DirectorSnapshot { settings:EventDirectorSettings; activity:{level:ActivityLevel;uniqueChatters5m:number;chatSignals5m:number;uniqueChatters15m:number;uniqueChatters30m:number}; lastEventAt:number|null; recentAutomaticEvents:number; leaseUntil:number; reason:string; lastSchedulerAt:number|null; activeEvent:{type:string;id:string;status:string;endsAt:number|null}|null; nextScheduled:{type:string;at:number}|null; queue:Array<{id:string;type:string;status:string;scheduledFor:number|null;triggeredBy:string;priority:number;reason:string;maxDelayAt:number|null}>; forecast:Array<{id:string;type:string;at:number;status:string;estimated:boolean;reason:string}>; recentRuns:DirectorRun[] }
const DEFAULTS:EventDirectorSettings={enabled:false,paused:false,queuePaused:false,autoBosses:false,autoDrops:false,autoWheel:false,autoChaos:false,adaptiveEventWeighting:true,autoSecretEvents:false,autoStories:false,minimumActivity:'normal',minimumGapMs:120_000,maxEventsPerHour:6,bossMinIntervalMs:4_500_000,bossMaxIntervalMs:6_300_000,bossAdaptiveHp:true,discordAnnouncements:false};
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
    // Migrate only the former shipped defaults; explicitly customized values stay untouched.
    const legacyGap=raw.minimumGapMs===900_000?DEFAULTS.minimumGapMs:raw.minimumGapMs;
    const legacyHourlyCap=raw.maxEventsPerHour===2?DEFAULTS.maxEventsPerHour:raw.maxEventsPerHour;
    return {...DEFAULTS,...raw,minimumGapMs:bounded(legacyGap,DEFAULTS.minimumGapMs,120_000,7_200_000),
      maxEventsPerHour:bounded(legacyHourlyCap,DEFAULTS.maxEventsPerHour,1,8),bossMinIntervalMs:bounded(raw.bossMinIntervalMs,DEFAULTS.bossMinIntervalMs,4_500_000,6_300_000),
      bossMaxIntervalMs:bounded(raw.bossMaxIntervalMs,DEFAULTS.bossMaxIntervalMs,4_500_000,6_300_000),
      minimumActivity:LEVELS.includes(raw.minimumActivity as ActivityLevel)?raw.minimumActivity as ActivityLevel:'normal'};
  }
  updateSettings(input:Partial<EventDirectorSettings>):EventDirectorSettings {
    const next={...this.settings()};for(const key of ['enabled','paused','queuePaused','autoBosses','autoDrops','autoWheel','autoChaos','adaptiveEventWeighting','autoStories','autoSecretEvents','minimumActivity','minimumGapMs','maxEventsPerHour','bossMinIntervalMs','bossMaxIntervalMs','bossAdaptiveHp','discordAnnouncements'] as const){if(input[key]!==undefined)(next as unknown as Record<string,unknown>)[key]=input[key];}
    for(const k of ['enabled','paused','queuePaused','autoBosses','autoDrops','autoWheel','autoChaos','adaptiveEventWeighting','autoSecretEvents','autoStories','bossAdaptiveHp','discordAnnouncements'] as const)if(typeof next[k]!=='boolean')throw new Error('Event-Director-Schalter müssen Ein oder Aus sein.');
    if(!LEVELS.includes(next.minimumActivity))throw new Error('Aktivitätsschwelle ungültig.');
    if(!Number.isInteger(next.minimumGapMs)||next.minimumGapMs<120_000||next.minimumGapMs>7_200_000)throw new Error('Der gemeinsame Sicherheitsabstand muss 2 bis 120 Minuten betragen.');
    if(!Number.isInteger(next.maxEventsPerHour)||next.maxEventsPerHour<1||next.maxEventsPerHour>8)throw new Error('Pro Stunde sind 1 bis 8 automatische Ereignisse zulässig.');
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
      UNION ALL SELECT 'community-quest' type,id,status,expires_at endsAt FROM quests WHERE status='active'
      UNION ALL SELECT 'chat-imposter' type,id,phase status,phase_ends_at endsAt FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting')
      UNION ALL SELECT 'chat-detective' type,id,phase status,ends_at endsAt FROM detective_rounds WHERE phase='playing'
    ) LIMIT 1`).get() as DirectorSnapshot['activeEvent']);
    const timers=this.store.state<Record<string,number|null>>('event_director_timers',{}),scheduled=Object.entries(timers).filter((row):row is [string,number]=>typeof row[1]==='number'&&row[1]>now).map(([key,at])=>({type:key==='drop'?'mystery-drop':key,at}));
    const chaosSettings=this.store.config<{enabled?:boolean;autoEnabled?:boolean}>('community_chaos_settings',{}),chaosNext=this.store.miniGameQuery(db=>(db.prepare('SELECT next_at at FROM community_chaos_scheduler WHERE id=1').get() as {at:number|null}|undefined)?.at||null);
    if((cfg.autoChaos||cfg.autoStories)&&chaosSettings.enabled===true&&chaosSettings.autoEnabled===true&&chaosNext&&chaosNext>now)scheduled.push({type:'community-chaos',at:chaosNext});
    const arcade=this.store.config<{wheelAutoPilotEnabled?:boolean}>('arcade_settings',{}),lastWheel=this.store.miniGameQuery(db=>(db.prepare("SELECT created_at at FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {at:number}|undefined)?.at||null);
    if(cfg.autoWheel&&arcade.wheelAutoPilotEnabled===true&&!this.store.config('arcade_wheel_paused',false)&&lastWheel!==null&&lastWheel+30*60_000>now)scheduled.push({type:'chaos-wheel',at:lastWheel+30*60_000});
    const queue=this.store.miniGameQuery(db=>db.prepare("SELECT id,event_type type,status,scheduled_for scheduledFor,triggered_by triggeredBy,queue_priority priority,reason,max_delay_at maxDelayAt FROM event_director_runs WHERE status='queued' ORDER BY queue_priority DESC,scheduled_for,started_at LIMIT 50").all() as DirectorSnapshot['queue']);
    for(const item of queue)if(item.scheduledFor!==null)scheduled.push({type:item.type,at:item.scheduledFor});
    const nextScheduled=scheduled.sort((a,b)=>a.at-b.at)[0]||null;
    const planned=this.store.miniGameQuery(db=>db.prepare("SELECT id,event_type type,status,scheduled_for scheduledFor,reason FROM event_director_runs WHERE status='planned' AND scheduled_for IS NOT NULL ORDER BY scheduled_for LIMIT 50").all() as Array<{id:string;type:string;status:string;scheduledFor:number;reason:string}>);
    const forecast=[...planned.map(item=>({id:item.id,type:item.type,at:item.scheduledFor,status:item.status,estimated:false,reason:item.reason})),...queue.filter(item=>item.scheduledFor!==null).map(item=>({id:item.id,type:item.type,at:item.scheduledFor!,status:item.status,estimated:true,reason:item.reason})),...scheduled.filter(item=>!planned.some(plan=>plan.type===item.type&&plan.scheduledFor===item.at)&&!queue.some(request=>request.type===item.type&&request.scheduledFor===item.at)).map(item=>({id:`timer-${item.type}-${item.at}`,type:item.type,at:item.at,status:'planned',estimated:true,reason:'Persistierter Event-Timer; tatsächlicher Start hängt von Stream, Aktivität und Konfliktprüfung ab.'}))].filter(item=>item.at<=now+2*60*60_000).sort((a,b)=>a.at-b.at).slice(0,20);
    const lastSchedulerAt=this.store.miniGameQuery(db=>(db.prepare("SELECT updated_at at FROM feature_state WHERE key='event_director_reason'").get() as {at:number}|undefined)?.at||null);
    const recentRunsRaw=this.store.miniGameQuery(db=>db.prepare('SELECT id,event_type type,started_at startedAt,scheduled_for scheduledFor,completed_at endedAt,status,triggered_by triggeredBy,source_event_id sourceEventId,participant_count participants,distinct_participant_count distinctParticipants,xp_total xp,active_chatter_count activeChatters,success,payout_status payoutStatus,delivery_status deliveryStatus,outcome,error_status error,reason FROM event_director_runs ORDER BY CASE WHEN status=\'planned\' THEN 0 ELSE 1 END,COALESCE(scheduled_for,started_at) DESC LIMIT 20').all() as Array<Omit<DirectorRun,'success'>&{success:number|null}>);
    const recentRuns=recentRunsRaw.map(row=>({...row,success:row.success===null?null:Boolean(row.success)}));
    return {settings:cfg,activity,lastEventAt:state.lastEventAt,recentAutomaticEvents,leaseUntil,reason:reason||this.store.state<string>('event_director_reason','Noch keine automatische Entscheidung getroffen.'),lastSchedulerAt,activeEvent:activeEvent||null,nextScheduled,queue,forecast,recentRuns};
  }
  enqueueManual(type:string,actor:string,now:number,payload:Record<string,unknown>={},requestKey?:string,immediate=false):{id:string;scheduledFor:number;duplicate:boolean}{
    if(!MANUAL_QUEUE_TYPES.has(type))throw new Error('Diese Aktion kann nicht über die Event-Zentrale eingeplant werden.');
    if(!actor||actor.length>128)throw new Error('Die berechtigte Person konnte nicht bestätigt werden.');
    let encoded='{}';try{encoded=JSON.stringify(payload);if(encoded.length>2000)throw new Error();}catch{throw new Error('Die Event-Optionen sind ungültig oder zu groß.');}
    if(requestKey&&!/^[A-Za-z0-9_-]{8,100}$/u.test(requestKey))throw new Error('Die Anforderungskennung ist ungültig.');
    return this.store.miniGameTransaction(db=>{
      if(requestKey){const existing=db.prepare('SELECT id,scheduled_for scheduledFor FROM event_director_runs WHERE request_key=?').get(requestKey) as {id:string;scheduledFor:number|null}|undefined;if(existing)return {id:existing.id,scheduledFor:existing.scheduledFor||now,duplicate:true};}
      const recentDuplicate=db.prepare("SELECT id,scheduled_for scheduledFor FROM event_director_runs WHERE status='queued' AND event_type=? AND COALESCE(request_payload,'{}')=? AND started_at>? ORDER BY started_at DESC LIMIT 1").get(type,encoded,now-30_000) as {id:string;scheduledFor:number|null}|undefined;
      if(recentDuplicate)return {id:recentDuplicate.id,scheduledFor:recentDuplicate.scheduledFor||now,duplicate:true};
      const count=(db.prepare("SELECT COUNT(*) n FROM event_director_runs WHERE status='queued'").get() as {n:number}).n;if(count>=100)throw new Error('Die Event-Warteschlange ist voll. Bitte zuerst Einträge bearbeiten.');
      const tail=db.prepare("SELECT MAX(scheduled_for) at FROM event_director_runs WHERE status='queued'").get() as {at:number|null},active=this.activeSourceEvent(now),minimumGap=this.settings().minimumGapMs,state=this.store.state<{lastEventAt:number|null}>('event_director_state',{lastEventAt:null});
      const cooldownReadyAt=state.lastEventAt===null?now:state.lastEventAt+minimumGap,activeReadyAt=active?.endsAt&&active.endsAt>now?active.endsAt+minimumGap:now;
      const scheduledFor=immediate?Math.max(now,cooldownReadyAt,activeReadyAt):Math.max(now,cooldownReadyAt,activeReadyAt,tail.at===null?now:tail.at+minimumGap),id=randomUUID();
      db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,scheduled_for,reason,status,triggered_by,payout_status,request_payload,request_key,queue_priority,max_delay_at) VALUES(?,?,?,?,'Wartet auf Event-Zentrale',? ,?,'not-applicable',?,?,?,?)")
        .run(id,type,now,scheduledFor,'queued',actor,encoded,requestKey||null,immediate?100:0,now+6*60*60_000);
      return {id,scheduledFor,duplicate:false};
    });
  }
  updateQueued(id:string,action:'promote'|'reschedule'|'skip'|'cancel'|'retry',actor:string,now:number,scheduledFor?:number):boolean{
    if(!id||id.length>80||!actor)return false;
    return this.store.miniGameTransaction(db=>{
      const row=db.prepare('SELECT status FROM event_director_runs WHERE id=?').get(id) as {status:string}|undefined;if(!row)return false;
      if(action==='retry')return Boolean(db.prepare("UPDATE event_director_runs SET status='queued',started_at=?,completed_at=NULL,scheduled_for=?,triggered_by=?,reason='Von Administrator erneut eingeplant',error_status=NULL,queue_priority=100,max_delay_at=? WHERE id=? AND status='failed'").run(now,now,actor,now+6*60*60_000,id).changes);
      if(row.status!=='queued')return false;
      if(action==='promote')return Boolean(db.prepare("UPDATE event_director_runs SET scheduled_for=?,queue_priority=100,reason='In der Warteschlange vorgezogen' WHERE id=? AND status='queued'").run(now,id).changes);
      if(action==='reschedule'){
        if(!Number.isSafeInteger(scheduledFor)||scheduledFor!<now||scheduledFor!>now+6*60*60_000)return false;
        return Boolean(db.prepare("UPDATE event_director_runs SET scheduled_for=?,reason='Zeit durch Streamer Control angepasst',queue_priority=0 WHERE id=? AND status='queued'").run(scheduledFor,id).changes);
      }
      const status=action==='skip'?'skipped':'cancelled';return Boolean(db.prepare('UPDATE event_director_runs SET status=?,completed_at=?,reason=?,outcome=? WHERE id=? AND status=\'queued\'').run(status,now,action==='skip'?'Durch Streamer übersprungen':'Durch Streamer abgebrochen',status,id).changes);
    });
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
    if(!input.live){this.setReason('Twitch-Stream ist offline.',now);return;}
    if(input.busy){this.setReason('Ein anderes Community-Spiel oder eine Chataktion läuft.',now);return;}
    const queued=this.store.miniGameQuery(db=>db.prepare("SELECT id,event_type type,scheduled_for scheduledFor,triggered_by actor,request_payload payload,max_delay_at maxDelayAt FROM event_director_runs WHERE status='queued' ORDER BY queue_priority DESC,scheduled_for,started_at LIMIT 1").get() as {id:string;type:string;scheduledFor:number|null;actor:string;payload:string|null;maxDelayAt:number|null}|undefined);
    if(queued&&!cfg.queuePaused){
      if(queued.maxDelayAt!==null&&queued.maxDelayAt<=now){this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status='skipped',completed_at=?,reason='Gültigkeitsfenster der manuellen Anfrage abgelaufen',outcome='expired' WHERE id=? AND status='queued'").run(now,queued.id));this.setReason('Eine manuelle Anfrage ist nach sechs Stunden abgelaufen; die nächste Warteschlangenaktion wird geprüft.',now);return;}
      if(queued.scheduledFor!==null&&queued.scheduledFor>now){this.setReason(`Manuelle Aktion ${queued.type} ist für ${new Date(queued.scheduledFor).toLocaleTimeString('de-DE')} eingeplant.`,now);return;}
      const lastStart=this.store.state<{lastEventAt:number|null}>('event_director_state',{lastEventAt:null}).lastEventAt;
      if(lastStart!==null&&now-lastStart<cfg.minimumGapMs){const at=lastStart+cfg.minimumGapMs;this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET scheduled_for=?,reason='Wartet auf den gemeinsamen Sicherheitsabstand' WHERE id=? AND status='queued'").run(at,queued.id));this.setReason(`Manuelle Aktion ${queued.type} wartet bis ${new Date(at).toLocaleTimeString('de-DE')} auf den gemeinsamen Sicherheitsabstand.`,now);return;}
      const result=this.runQueuedManual(queued,input.candidates,now);if(result)return result;
      // A queued manual request owns the next eligible slot even when its own
      // handler reports a recoverable failure; automatic events must not jump it.
      return;
    }
    if(!cfg.enabled){this.setReason('Event Director ist deaktiviert.',now);return;}
    if(cfg.paused){this.setReason('Event Director ist pausiert.',now);return;}
    const activity=this.activity(now);if(LEVELS.indexOf(activity.level)<LEVELS.indexOf(cfg.minimumActivity)){this.setReason('Die tatsächliche Chataktivität liegt unter der eingestellten Schwelle.',now);return;}
    const state=this.store.state<{lastEventAt:number|null;lastType?:string}>('event_director_state',{lastEventAt:null});
    if(state.lastEventAt!==null&&now-state.lastEventAt<cfg.minimumGapMs){this.setReason('Der kurze Sicherheitsabstand zwischen zwei Starts ist aktiv; einzelne Event-Cooldowns laufen unabhängig.',now);return;}
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
  private runQueuedManual(queued:{id:string;type:string;scheduledFor:number|null;actor:string;payload:string|null},candidates:EventCandidate[],now:number):{message:string;type:string}|undefined{
    const candidate=candidates.find(item=>item.type===queued.type&&item.manualStart);
    if(!candidate?.manualStart){this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status='failed',completed_at=?,error_status='No manual event handler is registered.',reason='Diese Aktion kann derzeit nicht ausgeführt werden.' WHERE id=? AND status='queued'").run(now,queued.id));this.setReason(`Für ${queued.type} ist kein manueller Warteschlangen-Handler verfügbar.`,now);return;}
    const owner=randomUUID();if(!this.claimLease(now,owner)){this.setReason('Eine andere Event-Director-Instanz reserviert gerade den nächsten Warteschlangenplatz.',now);return;}
    try{
      const claimed=this.store.miniGameTransaction(db=>db.prepare("UPDATE event_director_runs SET status='started',reason='Manuelle Aktion wird ausgeführt' WHERE id=? AND status='queued'").run(queued.id).changes===1);if(!claimed)return;
      let payload:Record<string,unknown>={};try{const parsed=queued.payload?JSON.parse(queued.payload) as unknown:{};if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))payload=parsed as Record<string,unknown>;}catch{/* A malformed stored request fails safely below. */}
      let message:string|undefined;try{message=candidate.manualStart!(queued.actor,payload);}catch(error){const detail=error instanceof Error?error.message:'Unbekannter Fehler';this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status='failed',completed_at=?,reason=?,error_status=? WHERE id=? AND status='started'").run(now,`Manueller Start fehlgeschlagen: ${detail}`.slice(0,240),detail.slice(0,240),queued.id));this.setReason(`Manueller Start von ${queued.type} fehlgeschlagen: ${detail}`,now);return;}
      const source=this.activeSourceEvent(now);if(!message||!source){const error='Die bestehende Event-Engine hat keinen laufenden Eventstatus bestätigt.';this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status='failed',completed_at=?,reason=?,error_status=? WHERE id=? AND status='started'").run(now,error,error,queued.id));this.setReason(`${queued.type}: ${error}`,now);return;}
      const activity=this.activity(now);this.store.miniGameTransaction(db=>{db.prepare("UPDATE event_director_runs SET status='active',started_at=?,source_event_id=?,active_chatter_count=?,reason='Manuell über die Event-Warteschlange gestartet',payout_status='pending' WHERE id=? AND status='started'").run(now,source.id,activity.uniqueChatters5m,queued.id);this.store.setState('event_director_state',{lastEventAt:now,lastType:queued.type},now);});
      this.setReason(`${queued.type} wurde aus der manuellen Warteschlange gestartet.`,now);return {message,type:queued.type};
    }finally{this.releaseLease(now,owner);}
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
  finishSource(sourceEventId:string,status:'completed'|'aborted'|'failed'|'skipped',now:number,payoutStatus='unknown'):void{this.reconcileLifecycle(now);this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status=?,completed_at=?,payout_status=? WHERE source_event_id=? AND status IN ('started','active')").run(status,now,payoutStatus,sourceEventId));}
  private activeSourceEvent(now:number):{type:string;id:string;status:string;endsAt:number|null}|null{return this.store.miniGameQuery(db=>db.prepare(`SELECT type,id,status,endsAt FROM (
      SELECT 'community-chaos' type,id,status,deadline endsAt FROM community_chaos_events WHERE status='active'
      UNION ALL SELECT kind type,id,status,ends_at endsAt FROM community_interactive_events WHERE status='open' AND kind!='game_night'
      UNION ALL SELECT 'boss' type,id,status,expires_at endsAt FROM boss_fights WHERE status='active'
      UNION ALL SELECT 'mystery-drop' type,id,status,ends_at endsAt FROM mystery_drops WHERE status IN ('announced','claiming','resolving')
      UNION ALL SELECT 'chaos-wheel' type,id,status,ends_at endsAt FROM chaos_wheel_spins WHERE status IN ('spinning','active')
      UNION ALL SELECT 'community-vault' type,id,status,ends_at endsAt FROM community_vault_rounds WHERE status='active'
      UNION ALL SELECT 'community-quest' type,id,status,expires_at endsAt FROM quests WHERE status='active'
      UNION ALL SELECT 'chat-imposter' type,id,phase status,phase_ends_at endsAt FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting')
      UNION ALL SELECT 'chat-detective' type,id,phase status,ends_at endsAt FROM detective_rounds WHERE phase='playing'
    ) LIMIT 1`).get() as DirectorSnapshot['activeEvent']||null);}
  private recordFailure(type:string,reason:string,actor:string,now:number):void{this.store.miniGameQuery(db=>db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,completed_at,reason,status,triggered_by,payout_status,error_status) VALUES(?,?,?,?,?,'failed',?,'none',?)").run(randomUUID(),type,now,now,actor==='system'?`automatic: ${reason}`:`manual: ${reason}`,actor,reason.slice(0,240)));}
  private reconcileLifecycle(now:number):void{
    const active=this.activeSourceEvent(now);
    if(active){this.store.miniGameTransaction(db=>{
      if(db.prepare('SELECT 1 FROM event_director_runs WHERE source_event_id=?').get(active.id))return;
      const type=active.type==='mystery_case'||active.type==='elio_rescue'||active.type==='secret_portal'?'secret-event':active.type;
      const compatible=type==='community-chaos'?['community-chaos','elio-chronicles']:type==='secret-event'?['secret-event']: [type];
      const placeholders=compatible.map(()=>'?').join(',');
      const interrupted=db.prepare(`SELECT id,event_type FROM event_director_runs WHERE status='started' AND source_event_id IS NULL AND triggered_by!='system' AND event_type IN (${placeholders}) ORDER BY started_at DESC LIMIT 1`).get(...compatible) as {id:string;event_type:string}|undefined;
      if(interrupted){db.prepare("UPDATE event_director_runs SET status='active',source_event_id=?,reason='Nach Neustart mit laufender Eventinstanz verknüpft',payout_status='pending' WHERE id=? AND status='started' AND source_event_id IS NULL").run(active.id,interrupted.id);return;}
      db.prepare("INSERT INTO event_director_runs(id,event_type,started_at,reason,status,triggered_by,source_event_id,payout_status,active_chatter_count) VALUES(?,?,?,'Nach Neustart wiederhergestellt','active','recovery',?,'pending',?)").run(randomUUID(),type,now,active.id,this.activity(now).uniqueChatters5m);
    });}
    // A manual action is marked started before invoking its existing feature handler.
    // If the process died before a durable source appeared, fail it after the lease
    // expires rather than silently re-running a potentially non-idempotent start.
    this.store.miniGameQuery(db=>db.prepare("UPDATE event_director_runs SET status='failed',completed_at=?,reason='Start nach Prozessabbruch nicht bestätigt; aus Sicherheitsgründen nicht automatisch wiederholt',error_status='interrupted-start-unconfirmed' WHERE status='started' AND source_event_id IS NULL AND triggered_by!='system' AND started_at<=?").run(now,now-30_000));
    const pending=this.store.miniGameQuery(db=>db.prepare("SELECT id,event_type type,source_event_id sourceId FROM event_director_runs WHERE status IN ('started','active') AND source_event_id IS NOT NULL ORDER BY started_at DESC LIMIT 50").all() as Array<{id:string;type:string;sourceId:string}>);
    for(const run of pending){
      const result=this.store.miniGameQuery(db=>{
        if(run.type==='boss'){const row=db.prepare('SELECT status,finished_at endedAt FROM boss_fights WHERE id=?').get(run.sourceId) as {status:string;endedAt:number|null}|undefined;if(!row)return;const stats=db.prepare('SELECT COUNT(*) participants,COUNT(DISTINCT user_id) distinctParticipants,COALESCE(SUM(xp_awarded),0) xp FROM boss_participants WHERE boss_id=?').get(run.sourceId) as {participants:number;distinctParticipants:number;xp:number};const payout=db.prepare("SELECT reward_granted granted FROM boss_fights WHERE id=?").get(run.sourceId) as {granted:number};const delivery=db.prepare("SELECT status FROM discord_event_outbox WHERE event_type='event.director.boss' AND aggregate_id=? ORDER BY created_at DESC LIMIT 1").get(run.sourceId) as {status:string}|undefined;return {row,status:row.status==='active'?'active':row.status==='defeated'||row.status==='timeout'?'completed':row.status==='ended'||row.status==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:stats.xp,outcome:row.status,success:row.status==='defeated',payoutStatus:payout.granted?'settled':'none',deliveryStatus:delivery?.status||'not-configured'};}
        if(run.type==='story-or-chaos'||run.type==='community-chaos'||run.type==='elio-chronicles'){const row=db.prepare('SELECT status,completed_at endedAt,result_json result FROM community_chaos_events WHERE id=?').get(run.sourceId) as {status:string;endedAt:number|null;result:string|null}|undefined;if(!row)return;const stats=db.prepare('SELECT COUNT(*) participants,COUNT(DISTINCT user_id) distinctParticipants FROM community_chaos_participants WHERE event_id=?').get(run.sourceId) as {participants:number;distinctParticipants:number};const data=row.result?JSON.parse(row.result) as {totalXp?:number;participants?:number;success?:boolean}:{};const story=db.prepare("SELECT o.status FROM elio_chronicles_events e LEFT JOIN discord_event_outbox o ON o.id=e.diary_outbox_id WHERE e.chaos_event_id=?").get(run.sourceId) as {status:string|null}|undefined;const delivery=db.prepare("SELECT status FROM discord_event_outbox WHERE event_type='community.chaos' AND aggregate_id=? ORDER BY created_at DESC LIMIT 1").get(run.sourceId) as {status:string}|undefined;return {row,status:row.status==='active'?'active':row.status==='completed'?'completed':row.status==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:data.totalXp||0,outcome:row.status,success:row.status==='completed'&&(data.totalXp||0)>0,payoutStatus:row.status==='completed'?'settled':row.status==='canceled'?'none':'pending',deliveryStatus:story?.status?`story:${story.status}`:delivery?.status||'not-configured'};}
        if(run.type==='community-quest'){const row=db.prepare('SELECT status,completed_at endedAt,submitter_user_id userId,display_name name,reward_granted_at rewardAt FROM quests WHERE id=?').get(run.sourceId) as {status:string;endedAt:number|null;userId:string;name:string;rewardAt:number|null}|undefined;if(!row)return;const ledger=db.prepare("SELECT COALESCE(SUM(amount),0) xp FROM xp_ledger WHERE event_id=?").get(`quest:${run.sourceId}:completion`) as {xp:number};return {row,status:row.status==='active'?'active':row.status==='completed'?'completed':row.status==='canceled'?'aborted':row.status==='failed'?'failed':'skipped',endedAt:row.endedAt,participants:1,distinctParticipants:1,xp:ledger.xp,outcome:row.status,success:row.status==='completed',payoutStatus:row.status==='completed'?(row.rewardAt||ledger.xp?'settled':'none'):'none',deliveryStatus:'not-applicable'};}
        if(run.type==='chat-imposter'){const row=db.prepare('SELECT phase,updated_at endedAt,result_json result FROM imposter_rounds WHERE id=?').get(run.sourceId) as {phase:string;endedAt:number;result:string|null}|undefined;if(!row)return;const stats=db.prepare('SELECT COUNT(*) participants,COUNT(DISTINCT user_id) distinctParticipants,COALESCE(SUM(xp),0) xp FROM mini_game_awards WHERE round_id=? AND game=\'imposter\'').get(run.sourceId) as {participants:number;distinctParticipants:number;xp:number};return {row,status:['registration','role_distribution','playing','voting'].includes(row.phase)?'active':row.phase==='results'||row.phase==='finished'?'completed':row.phase==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:stats.xp,outcome:row.result||row.phase,success:row.phase==='results'||row.phase==='finished',payoutStatus:stats.xp?'settled':'none',deliveryStatus:'not-configured'};}
        if(run.type==='chat-detective'){const row=db.prepare('SELECT phase,updated_at endedAt,result_json result FROM detective_rounds WHERE id=?').get(run.sourceId) as {phase:string;endedAt:number;result:string|null}|undefined;if(!row)return;const stats=db.prepare('SELECT COUNT(*) participants,COUNT(DISTINCT user_id) distinctParticipants,COALESCE(SUM(xp),0) xp FROM mini_game_awards WHERE round_id=? AND game=\'detective\'').get(run.sourceId) as {participants:number;distinctParticipants:number;xp:number};return {row,status:row.phase==='playing'?'active':row.phase==='results'||row.phase==='finished'?'completed':row.phase==='canceled'?'aborted':'failed',endedAt:row.endedAt,participants:stats.participants,distinctParticipants:stats.distinctParticipants,xp:stats.xp,outcome:row.result||row.phase,success:row.phase==='results'||row.phase==='finished',payoutStatus:stats.xp?'settled':'none',deliveryStatus:'not-configured'};}
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
const MANUAL_QUEUE_TYPES=new Set(['boss','community-chaos','elio-chronicles','secret-event','mystery-drop','chaos-wheel','community-vault','chat-imposter','chat-detective','community-quest']);
const KNOWN_CHAT_BOTS=new Set(['nightbot','streamelements','streamlabs','moobot','fossabot','wizebot','commanderroot','sery_bot','serybot']);
