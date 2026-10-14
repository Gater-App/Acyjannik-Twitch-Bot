import { randomInt, randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { ChatMessage } from './types.js';
import { FeatureStore, type QuestPolicy } from './feature-store.js';

export type ChaosWheelActionType = 'manual_challenge'|'start_mystery_drop'|'boost_pet';

export interface ArcadeSettings {
  petEnabled: boolean; dropsEnabled: boolean; wheelEnabled: boolean; wheelAutoPilotEnabled: boolean; autoDrops: boolean;
  petCooldownMs: number; dropDurationMs: number; wheelCooldownMs: number; allowChatSpin: boolean;
  activityRetentionDays: number; wheelChallengeDurationMs: number;
}
export interface PetState {
  name: string; level: number; xp: number; hunger: number; happiness: number; energy: number;
  stage: 'egg'|'baby'|'young'|'adult'|'legendary'; paused: boolean; animation: string; updatedAt: number;
}
interface PetRow {name:string;level:number;xp:number;hunger:number;happiness:number;energy:number;stage:PetState['stage'];paused:number;animation:string;updated_at:number}
const DEFAULT_SETTINGS: ArcadeSettings = { petEnabled:false,dropsEnabled:false,wheelEnabled:false,wheelAutoPilotEnabled:true,autoDrops:false,petCooldownMs:120_000,dropDurationMs:60_000,wheelCooldownMs:300_000,allowChatSpin:false,activityRetentionDays:90,wheelChallengeDurationMs:300_000 };
const DEFAULT_CHALLENGES:ReadonlyArray<{id:string;title:string;actionType:ChaosWheelActionType}> = [
  {id:'builtin:pet-energy',title:'Elio bekommt einen Energieschub!',actionType:'boost_pet'},
  {id:'builtin:mystery-drop',title:'Mystery Drop für den Chat',actionType:'start_mystery_drop'},
];
const LIMITS: Record<string,number> = { common:5,rare:10,epic:20,legendary:35,community:10 };
export const WHEEL_AUTO_INTERVAL_MS = 30 * 60_000;
const clean = (s:string,n=80) => Array.from(s.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim()).slice(0,n).join('');

/** Three small community features sharing the existing SQLite connection and XP ledger. */
export class CommunityArcade {
  private lastWheelAt = 0;
  constructor(private readonly store:FeatureStore, private readonly broadcasterId:string, private readonly chooseIndex:(exclusiveMax:number)=>number=randomInt) {
    this.store.miniGameTransaction(db=>{
      const n=(db.prepare('SELECT COUNT(*) n FROM chaos_wheel_challenges').get() as {n:number}).n;
      if(!n)for(const challenge of DEFAULT_CHALLENGES)db.prepare('INSERT INTO chaos_wheel_challenges(id,title,weight,active,action_type) VALUES(?,?,1,1,?)').run(challenge.id,challenge.title,challenge.actionType);
    });
  }
  settings():ArcadeSettings { return {...DEFAULT_SETTINGS,...this.store.config<Partial<ArcadeSettings>>('arcade_settings',{})}; }
  updateSettings(next:ArcadeSettings):void {
    for(const k of ['petEnabled','dropsEnabled','wheelEnabled','wheelAutoPilotEnabled','autoDrops','allowChatSpin'] as const)if(typeof next[k]!=='boolean')throw new Error(`Ungültige Arcade-Einstellung: ${k}`);
    for(const k of ['petCooldownMs','dropDurationMs','wheelCooldownMs','wheelChallengeDurationMs'] as const)if(!Number.isInteger(next[k])||next[k]<1000||next[k]>86_400_000)throw new Error(`Ungültige Arcade-Einstellung: ${k}`);
    if(!Number.isInteger(next.activityRetentionDays)||next.activityRetentionDays<1||next.activityRetentionDays>3650)throw new Error('activityRetentionDays muss zwischen 1 und 3650 liegen.');
    this.store.setConfig('arcade_settings',next);
  }
  pet():PetState { return this.store.miniGameQuery(db=>this.toPet(db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow)); }
  snapshot(type:'pet'|'drop'|'wheel',now=Date.now()):Record<string,unknown> {
    return this.store.miniGameQuery(db=>{
      if(type==='pet'){
        const p=this.toPet(db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow);
        return {type,visible:this.settings().petEnabled,pet:{...p,stageLabel:stageLabel(p.stage)},capturedAt:now};
      }
      if(type==='drop'){
        const d=db.prepare("SELECT * FROM mystery_drops WHERE status IN ('announced','claiming','resolving','completed') ORDER BY created_at DESC LIMIT 1").get() as {id:string;rarity:string;status:string;starts_at:number;ends_at:number;result_json:string|null;resolved_at:number|null}|undefined;
        if(!d||(['completed'].includes(d.status)&&now-(d.resolved_at||0)>12000))return {type,visible:false,capturedAt:now};
        const participants=(db.prepare('SELECT COUNT(*) n FROM mystery_claims WHERE drop_id=?').get(d.id) as {n:number}).n;
        return {type,visible:this.settings().dropsEnabled,drop:{rarityLabel:dropRarityLabel(d.rarity),status:d.status,endsAt:d.ends_at,participants,result:d.result_json?JSON.parse(d.result_json):null},capturedAt:now};
      }
      const w=db.prepare("SELECT * FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {id:string;title:string;status:string;created_at:number;resolved_at:number|null;ends_at:number|null;action_type:string;wheel_key:string|null}|undefined;
      const visible=!!w&&this.settings().wheelEnabled&&(w.status==='active'||now-(w.resolved_at??w.created_at)<15_000);
      return {type,visible,wheel:w?{id:w.id,title:w.title,status:w.status,actionType:w.action_type,wheelKey:w.wheel_key,createdAt:w.created_at,endsAt:w.ends_at}:null,capturedAt:now};
    });
  }
  handle(m:ChatMessage,command:string,args:string[],now=Date.now()):string|undefined {
    const s=this.settings(), admin=m.senderUserId===this.broadcasterId, mod=admin||m.isModerator===true;
    if(['pet','feed','play','petcare','petstats','petname','pethelp','petevolution','setpetname','petpause','petresume'].includes(command)){
      if(!s.petEnabled&&command!=='pethelp')return 'Elio macht gerade Pause; die Katzenpflege ist derzeit deaktiviert.';
      if(command==='pethelp')return 'Elio 🐱: !pet Zustand · !feed Katzenfutter · !play Spielangel/Wollknäuel · !petcare Pflege · !petstats Werte. Auch !petname und !petevolution bleiben verfügbar. Cooldown: 2 Min.';
      if(command==='pet'||command==='petstats'||command==='petname'||command==='petevolution'){
        const p=this.pet(); if(command==='petname')return `Elio heißt aktuell ${p.name}.`;
        if(command==='petevolution')return `${p.name}: ${stageLabel(p.stage)} · Level ${p.level}. Nächste Lebensphase: ${nextStage(p.stage)}.`;
        return `${p.name} 🐱 · ${stageLabel(p.stage)} · Level ${p.level} · Sättigung ${p.hunger}% · Zufriedenheit ${p.happiness}% · Energie ${p.energy}%.`;
      }
      if(command==='setpetname'){
        if(!admin)return '⛔ Nur Jannik darf den Pet-Namen ändern.';
        const name=clean(args.join(' '),24);if(name.length<2)return 'Bitte einen Namen mit 2–24 Zeichen angeben.';
        this.store.miniGameTransaction(db=>db.prepare("UPDATE community_pet SET name=?,animation='happy',updated_at=? WHERE id=1").run(name,now));return `Elio 🐱 heißt jetzt ${name}!`;
      }
      if(command==='petpause'||command==='petresume'){
        if(!admin)return '⛔ Nur Jannik darf Pflege pausieren oder fortsetzen.';
        this.store.miniGameTransaction(db=>db.prepare("UPDATE community_pet SET paused=?,animation='idle',updated_at=? WHERE id=1").run(command==='petpause'?1:0,now));return command==='petpause'?'Elio 🐱 macht eine Pflegepause.':'Elio 🐱 ist wieder für Pflege und Spiel bereit.';
      }
      const kind=command==='feed'?'feed':command==='play'?'play':'care';
      return this.interact(m,kind,s,now);
    }
    if(['claim','drop','dropstats','drops','startdrop','canceldrop','dropconfig'].includes(command)){
      if(!s.dropsEnabled&&command!=='drops')return '🎁 Mystery Drops sind derzeit deaktiviert.';
      if(command==='drops')return '🎁 Kostenloser virtueller Drop: !claim während des Countdowns. Keine Echtgeld- oder Sachpreise.';
      if(command==='drop'||command==='dropstats'){
        const d=this.store.miniGameQuery(db=>db.prepare("SELECT id,rarity,ends_at,status FROM mystery_drops WHERE status IN ('announced','claiming') ORDER BY created_at DESC LIMIT 1").get()) as {id:string;rarity:string;ends_at:number;status:string}|undefined;
        if(command==='dropstats')return `🎁 Deine Claims: ${this.store.miniGameQuery(db=> (db.prepare('SELECT COUNT(*) n FROM mystery_claims WHERE user_id=?').get(m.senderUserId) as {n:number}).n)}.`;
        if(!d)return '🎁 Gerade ist keine Kiste offen.';return `🎁 Ein Mystery Drop läuft noch ${Math.max(0,Math.ceil((d.ends_at-now)/1000))} Sekunden – mit !claim seid ihr dabei!`;
      }
      if(command==='claim')return this.claim(m,now);
      if(!mod)return '⛔ Nur Jannik oder Mods dürfen Drops verwalten.';
      if(command==='startdrop')return this.startDrop(m.senderUserId,now,args[0]);
      if(command==='canceldrop')return this.cancelDrop(now)?'🎁 Der Drop wurde abgebrochen.':'🎁 Kein offener Drop.';
      return '🎁 Drop-Konfiguration erfolgt im Dashboard.';
    }
    if(['wheel','spin','wheelstatus','startwheel','cancelwheel','wheelpause','wheelresume'].includes(command)){
      if(!s.wheelEnabled&&command!=='wheel'&&command!=='cancelwheel')return '🎡 Das Chaos Wheel ist derzeit deaktiviert.';
      if(command==='wheel'||command==='wheelstatus')return `🎡 Chaos Wheel ${this.activeChallenges().length} aktive Challenges · Cooldown ${Math.ceil(s.wheelCooldownMs/60000)} Min.`;
      if(command==='wheelpause'||command==='wheelresume'){
        if(!admin)return '⛔ Nur Jannik darf das Rad pausieren.';
        this.store.setConfig('arcade_wheel_paused',command==='wheelpause');return command==='wheelpause'?'🎡 Das Rad ist pausiert.':'🎡 Das Rad ist wieder freigegeben.';
      }
      if(command==='cancelwheel'){
        if(!mod)return '⛔ Nur Jannik oder Mods dürfen den Dreh abbrechen.';
        return this.finishCurrentTask(now);
      }
      if(!mod&&!(command==='spin'&&s.allowChatSpin))return '⛔ Der Dreh muss von Jannik oder einem Mod gestartet werden.';
      return this.spin(m.senderUserId,now,true);
    }
    return undefined;
  }
  tick(now=Date.now()):string[] { return this.tickMessages(now).map(item=>item.message); }
  tickMessages(now=Date.now()):Array<{message:string;category:'wheel'|'drop'|'pet'}> {
    const out:Array<{message:string;category:'wheel'|'drop'|'pet'}>=[];
    this.store.finishExpiredPolls(now);
    const finishedPolls=this.store.miniGameTransaction(db=>{
      const rows=db.prepare("SELECT id,task_ref FROM chaos_wheel_spins WHERE status='active' AND wheel_key='quest_vote' AND task_ref IS NOT NULL").all() as Array<{id:string;task_ref:string}>;
      const finished:string[]=[];
      for(const row of rows){const poll=this.store.poll(row.task_ref);if(!poll||poll.status!=='ended')continue;
        let message='📜 Die Quest-Abstimmung ist beendet – es gab keine eindeutige Wahl.';
        if(poll.winnerOption!==null&&!poll.tied){
          const questId=poll.options[poll.winnerOption]?.questId;
          const settings=this.store.config<Partial<QuestPolicy>>('quest_settings',{});
          const policy:QuestPolicy={maxLength:settings.maxLength??180,queueLimit:settings.queueLimit??100,maxOpenPerUser:settings.maxOpenPerUser??2,cooldownMs:settings.cooldownMs??300_000,activeDurationMs:settings.activeDurationMs??0,completionXp:settings.completionXp??25};
          const started=questId?this.store.transitionQuest(questId,'active','auto:chaos-wheel',now,policy):undefined;
          message=started?.ok?`📜 Die Community hat „${started.quest.title}“ gewählt – die Quest läuft jetzt!`:'📜 Die Abstimmung ist beendet, aber die gewählte Quest konnte nicht gestartet werden.';
        }
        db.prepare("UPDATE chaos_wheel_spins SET status='completed',resolved_at=? WHERE id=? AND status='active'").run(now,row.id);
        finished.push(message);}
      return finished;
    });
    for(const message of finishedPolls)out.push({message,category:'wheel'});
    const expiredTasks=this.store.miniGameTransaction(db=>{
      const rows=db.prepare("SELECT id,wheel_key FROM chaos_wheel_spins WHERE status='active' AND wheel_key='pistols_timer' AND ends_at<=?").all(now) as Array<{id:string;wheel_key:string}>;
      for(const row of rows)db.prepare("UPDATE chaos_wheel_spins SET status='completed',resolved_at=? WHERE id=? AND status='active'").run(now,row.id);
      return rows.length;
    });
    if(expiredTasks)out.push({message:'🎡 Die 5-Minuten-Challenge ist abgelaufen. Der Bot bestätigt nicht, ob die Regel eingehalten wurde.',category:'wheel'});
    // Keep a resolving drop recoverable until every idempotent XP award has been
    // recorded. A crash can then safely resume this work on the next tick.
    const due=this.store.miniGameTransaction(db=>{
      const d=db.prepare("SELECT id,rarity,status,result_json FROM mystery_drops WHERE status IN ('announced','claiming','resolving') AND ends_at<=? ORDER BY created_at LIMIT 1").get(now) as {id:string;rarity:string;status:string;result_json:string|null}|undefined;
      if(!d)return undefined;
      const newlyResolving=d.status!=='resolving'&&db.prepare("UPDATE mystery_drops SET status='resolving' WHERE id=? AND status IN ('announced','claiming')").run(d.id).changes===1;
      const claims=db.prepare('SELECT user_id,display_name FROM mystery_claims WHERE drop_id=? ORDER BY claimed_at').all(d.id) as Array<{user_id:string;display_name:string}>;
      const amount=LIMITS[d.rarity]||5;
      const result=d.result_json?JSON.parse(d.result_json) as {participants:number;rewardXp:number}:{participants:claims.length,rewardXp:amount};
      if(newlyResolving){db.prepare('UPDATE mystery_drops SET result_json=? WHERE id=? AND status=\'resolving\'').run(JSON.stringify(result),d.id);
        db.prepare("UPDATE community_pet SET animation='drop',happiness=MIN(100,happiness+?),xp=xp+?,updated_at=? WHERE id=1").run(claims.length?3:0,claims.length?2:0,now);}
      return {claims,id:d.id,amount:result.rewardXp,result};
    });
    if(due){
      for(const c of due.claims)this.store.awardXp(`drop:${due.id}:${c.user_id}`,c.user_id,c.display_name,due.amount,'bonus:mystery-drop',now,50);
      const completed=this.store.miniGameTransaction(db=>db.prepare("UPDATE mystery_drops SET status='completed',result_json=?,resolved_at=? WHERE id=? AND status='resolving'").run(JSON.stringify(due.result),now,due.id).changes===1);
      if(completed)out.push({message:due.claims.length
        ?`🎁 Der Mystery Drop ist geöffnet! ${due.claims.length} ${due.claims.length===1?'Person erhält':'Personen erhalten'} je ${due.amount} XP. Danke fürs Mitmachen – Elio schnurrt schon!`
        :'🎁 Der Mystery Drop ist vorbei – diesmal hat niemand mitgemacht. Beim nächsten Mal mit !claim dabei sein!',category:'drop'});
    }
    const batch=this.store.miniGameTransaction(db=>{
      const oldest=now-2*60_000;
      db.prepare('UPDATE community_pet_interactions SET announced_at=created_at WHERE announced_at IS NULL AND created_at<?').run(oldest);
      const rows=db.prepare('SELECT event_id,user_id,kind FROM community_pet_interactions WHERE announced_at IS NULL AND created_at>=? AND created_at<=? ORDER BY created_at').all(now-60_000,now) as Array<{event_id:string;user_id:string;kind:string}>;
      const participants=new Set(rows.map(row=>row.user_id));
      const last=this.store.config<number>('pet_chat_batch_last_at',0);
      if(participants.size<3||(last>0&&now-last<60_000))return undefined;
      const ids=rows.map(row=>row.event_id);
      if(!ids.length)return undefined;
      const placeholders=ids.map(()=>'?').join(',');
      db.prepare(`UPDATE community_pet_interactions SET announced_at=? WHERE event_id IN (${placeholders}) AND announced_at IS NULL`).run(now,...ids);
      return {participants:participants.size,actions:rows.length};
    });
    if(batch){this.store.setConfig('pet_chat_batch_last_at',now);out.push({message:`Elio schnurrt: ${batch.participants} aus dem Chat haben ihn mit ${batch.actions} Aktionen gepflegt. Danke, dass ihr euch gemeinsam um die Katze kümmert!`,category:'pet'});}
    this.store.miniGameTransaction(db=>{
      db.prepare("UPDATE community_pet SET hunger=MAX(20,hunger-MIN(5,MAX(0,CAST((?-updated_at)/86400000 AS INTEGER)))),energy=MIN(100,energy+MIN(5,MAX(0,CAST((?-updated_at)/86400000 AS INTEGER)))),updated_at=updated_at+MAX(0,CAST((?-updated_at)/86400000 AS INTEGER))*86400000 WHERE id=1 AND ?-updated_at>=86400000").run(now,now,now,now);
      db.prepare("UPDATE community_pet SET animation=CASE WHEN paused=1 THEN 'sleep' WHEN animation IN ('feed','play','care','happy','drop','levelup','evolution') AND updated_at<? THEN 'idle' ELSE animation END WHERE id=1").run(now-12000);
      const cutoff=now-this.settings().activityRetentionDays*86_400_000;
      db.prepare('DELETE FROM mystery_claims WHERE claimed_at<?').run(cutoff);
      db.prepare("DELETE FROM mystery_drops WHERE status IN ('completed','canceled','expired') AND COALESCE(resolved_at,created_at)<?").run(cutoff);
      db.prepare('DELETE FROM chaos_wheel_spins WHERE created_at<?').run(cutoff);
    });
    return out;
  }
  configureChallenge(title:string,weight:number,active:boolean,id?:string,actionType:ChaosWheelActionType='manual_challenge'):string {
    const cleanTitle=clean(title,80);if(!cleanTitle||!Number.isInteger(weight)||weight<1||weight>1000)throw new Error('Challenge oder Gewichtung ungültig.');
    if(!['manual_challenge','start_mystery_drop','boost_pet'].includes(actionType))throw new Error('Wheel-Aktion ist ungültig.');
    if(active&&actionType==='manual_challenge')throw new Error('Manuelle Challenges sind im automatischen Glücksrad nicht mehr zulässig.');
    const key=id||randomUUID();this.store.miniGameTransaction(db=>db.prepare('INSERT INTO chaos_wheel_challenges(id,title,weight,active,action_type) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,weight=excluded.weight,active=excluded.active,action_type=excluded.action_type').run(key,cleanTitle,weight,active?1:0,actionType));return key;
  }
  activeChallenges():Array<{id:string;title:string;weight:number;actionType:ChaosWheelActionType;wheelKey:string|null}> { return this.store.miniGameQuery(db=>db.prepare("SELECT id,title,weight,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges WHERE active=1 AND action_type!='manual_challenge' ORDER BY title").all() as Array<{id:string;title:string;weight:number;actionType:ChaosWheelActionType;wheelKey:string|null}>); }
  manageChallenges():Array<{id:string;title:string;weight:number;active:boolean;actionType:ChaosWheelActionType;wheelKey:string|null;kind:'automatic'|'streamer-task';description:string}> { return this.store.miniGameQuery(db=>(db.prepare('SELECT id,title,weight,active,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges ORDER BY title').all() as Array<{id:string;title:string;weight:number;active:number;actionType:ChaosWheelActionType;wheelKey:string|null}>).map(x=>({...x,active:x.active===1,kind:x.actionType==='manual_challenge'?'streamer-task':'automatic',description:wheelDescription(x.wheelKey,x.title)}))); }
  wheelStatus(now=Date.now()):Record<string,unknown>{
    const settings=this.settings();
    const active=this.store.miniGameQuery(db=>db.prepare("SELECT id,title,action_type actionType,wheel_key wheelKey,created_at createdAt,ends_at endsAt FROM chaos_wheel_spins WHERE status='active' ORDER BY created_at DESC LIMIT 1").get() as {id:string;title:string;actionType:ChaosWheelActionType;wheelKey:string|null;createdAt:number;endsAt:number|null}|undefined);
    const latest=this.store.miniGameQuery(db=>db.prepare("SELECT created_at createdAt FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {createdAt:number}|undefined);
    const activeDrop=this.store.miniGameQuery(db=>db.prepare("SELECT d.ends_at endsAt,d.source_spin_id sourceSpinId FROM mystery_drops d WHERE d.status IN ('announced','claiming','resolving') ORDER BY d.created_at DESC LIMIT 1").get() as {endsAt:number;sourceSpinId:string|null}|undefined);
    const gameRunning=this.hasBlockingCommunityGame();
    const dropActive=!!this.store.miniGameQuery(db=>db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving')").get());
    const challenges=this.activeChallenges();
    const available=challenges.filter(x=>(x.actionType==='boost_pet'&&settings.petEnabled)||(x.actionType==='start_mystery_drop'&&settings.dropsEnabled&&!dropActive));
    const total=available.reduce((n,x)=>n+x.weight,0);
    const nextSpinAt=latest?latest.createdAt+settings.wheelCooldownMs:0;
    const nextAutoSpinAt=latest?latest.createdAt+WHEEL_AUTO_INTERVAL_MS:0;
    let reason='Bereit für den nächsten Dreh.';
    if(!settings.wheelEnabled)reason='Das Glücksrad ist ausgeschaltet.';
    else if(!settings.wheelAutoPilotEnabled||this.store.config('arcade_wheel_paused',false))reason='Der Auto-Pilot ist pausiert.';
    else if(active)reason='Eine Rad-Aktion läuft bereits.';
    else if(activeDrop)reason='Ein Mystery Drop läuft gerade; das Rad wartet, damit niemand seine Teilnahme verliert.';
    else if(gameRunning)reason='Ein Community-Spiel läuft gerade; das Rad wartet, damit es nicht dazwischenfunkt.';
    else if(now<nextSpinAt)reason=`Nächster Dreh ab ${new Date(nextSpinAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}.`;
    else if(available.length<2||total<=0)reason='Es werden mindestens zwei aktuell verfügbare Rad-Felder benötigt.';
    const managed=this.manageChallenges();
    const tasks=managed.filter(x=>x.active&&x.kind==='streamer-task'&&x.wheelKey!=='gaming_quiz'&&(x.wheelKey!=='quest_vote'||this.questPollAvailable()));
    const taskTotal=tasks.reduce((sum,x)=>sum+x.weight,0);
    const wheelFields=managed.map(x=>{
      const automatic=x.kind==='automatic',poolTotal=automatic?total:total+taskTotal;
      const eligible=automatic?available.some(a=>a.id===x.id):tasks.some(t=>t.id===x.id);
      return {...x,probabilityLabel:automatic?'Auto-Pilot':'Manueller Dreh',probability:eligible&&poolTotal?Math.round(x.weight/poolTotal*1000)/10:0};
    });
    const questReady=this.questPollAvailable();
    const manualCanSpin=settings.wheelEnabled&&!active&&!activeDrop&&!gameRunning&&now>=nextSpinAt&&available.length+tasks.length>=2&&this.manageChallenges().some(x=>x.active&&x.wheelKey==='no_jumping'||x.active&&x.wheelKey==='pistols_timer'||x.active&&x.wheelKey==='quest_vote'&&questReady);
    return {enabled:settings.wheelEnabled,autoPilotEnabled:settings.wheelAutoPilotEnabled&&!this.store.config('arcade_wheel_paused',false),canSpin:reason==='Bereit für den nächsten Dreh.',canManualSpin:manualCanSpin,reason,nextSpinAt,nextAutoSpinAt,autoSpinDue:now>=nextAutoSpinAt,activeAction:active??(activeDrop?{actionType:'start_mystery_drop',title:activeDrop.sourceSpinId?'Mystery Drop vom Glücksrad':'Mystery Drop',endsAt:activeDrop.endsAt}:null),entries:available.map(x=>({...x,probability:total?Math.round(x.weight/total*1000)/10:0,automation:'Automatisch durch den Bot.'})),taskEntries:tasks.map(x=>({...x,probability:taskTotal?Math.round(x.weight/taskTotal*1000)/10:0,automation:'Jannicks Aufgabe im Fortnite-Spiel.'})),wheelFields,unavailable:[...challenges.filter(x=>!available.some(a=>a.id===x.id)&&x.actionType!=='manual_challenge').map(x=>({id:x.id,title:x.title,reason:availabilityReason(x.actionType,settings,dropActive)})),...this.manageChallenges().filter(x=>x.active&&x.wheelKey==='quest_vote'&&!questReady).map(x=>({id:x.id,title:x.title,reason:'Mindestens zwei freigegebene Quests sowie freie Quest- und Umfrageplätze erforderlich.'}))]};
  }
  autoSpinIfDue(now=Date.now()):string|undefined {
    const status=this.wheelStatus(now) as {enabled:boolean;autoPilotEnabled:boolean;autoSpinDue:boolean;canSpin:boolean};
    if(!status.enabled||!status.autoPilotEnabled||!status.autoSpinDue||!status.canSpin)return undefined;
    return this.spin('auto:wheel',now,false);
  }
  spinActionTypeAt(now:number):ChaosWheelActionType|undefined {
    return this.store.miniGameQuery(db=>{
      const row=db.prepare('SELECT action_type FROM chaos_wheel_spins WHERE created_at=? ORDER BY rowid DESC LIMIT 1').get(now) as {action_type:ChaosWheelActionType}|undefined;
      return row?.action_type;
    });
  }
  emergencyStop(now=Date.now()):string{
    const active=this.store.miniGameTransaction(db=>{
      const rows=db.prepare("SELECT id,task_ref FROM chaos_wheel_spins WHERE status='active'").all() as Array<{id:string;task_ref:string|null}>;
      for(const row of rows){if(row.task_ref)this.store.endPoll(row.task_ref,now,true);db.prepare("UPDATE chaos_wheel_spins SET status='canceled',resolved_at=? WHERE id=? AND status='active'").run(now,row.id);}
      return rows.length>0;
    });
    this.store.setConfig('arcade_wheel_paused',true);
    this.store.setConfig('arcade_settings',{...this.settings(),wheelAutoPilotEnabled:false});
    return active?'🛑 Auto-Pilot gestoppt und laufende Challenge beendet. Ein bereits gestarteter Mystery Drop läuft sicher bis zum Ende und wird normal ausgewertet.':'🛑 Auto-Pilot gestoppt. Ein bereits gestarteter Mystery Drop läuft sicher bis zum Ende und wird normal ausgewertet.';
  }
  resumeAutoPilot():void{this.store.setConfig('arcade_wheel_paused',false);}
  finishCurrentTask(now=Date.now()):string{
    const result=this.store.miniGameTransaction(db=>{
      const row=db.prepare("SELECT id,task_ref FROM chaos_wheel_spins WHERE status='active' AND action_type='manual_challenge' ORDER BY created_at DESC LIMIT 1").get() as {id:string;task_ref:string|null}|undefined;
      if(!row)return false;
      if(row.task_ref)this.store.endPoll(row.task_ref,now,true);
      return db.prepare("UPDATE chaos_wheel_spins SET status='canceled',resolved_at=? WHERE id=? AND status='active'").run(now,row.id).changes===1;
    });
    return result?'🎡 Jannicks laufende Rad-Aufgabe wurde beendet. Das Ergebnis wurde nicht bewertet.':'🎡 Es läuft keine Rad-Aufgabe.';
  }
  startDropAdmin(actor:string,rarity:string|undefined,now=Date.now()):string { if(!this.settings().dropsEnabled)return '🎁 Mystery Drops sind deaktiviert.';return this.startDrop(actor,now,rarity); }
  spinAdmin(actor:string,now=Date.now()):string { if(!this.settings().wheelEnabled)return '🎡 Das Chaos Wheel ist deaktiviert.';return this.spin(actor,now,true); }
  configureWheelField(id:string,active:boolean,weight:number):void{
    if(!Number.isInteger(weight)||weight<1||weight>1000)throw new Error('Wahrscheinlichkeit ist ungültig.');
    this.store.miniGameTransaction(db=>{
      const row=db.prepare('SELECT wheel_key,action_type FROM chaos_wheel_challenges WHERE id=?').get(id) as {wheel_key:string|null;action_type:ChaosWheelActionType}|undefined;
      if(!row)throw new Error('Radfeld nicht gefunden.');
      if(row.wheel_key==='gaming_quiz'&&active)throw new Error('Gaming-Quiz bleibt deaktiviert.');
      if(active&&row.action_type==='manual_challenge'&&!['quest_vote','no_jumping','pistols_timer'].includes(row.wheel_key||''))throw new Error('Dieses historische Aufgabenfeld ist nicht automatisiert und bleibt aus dem Rad ausgeschlossen.');
      db.prepare('UPDATE chaos_wheel_challenges SET active=?,weight=? WHERE id=?').run(active?1:0,weight,id);
    });
  }
  private hasBlockingCommunityGame():boolean{return this.store.miniGameQuery(db=>Boolean(db.prepare("SELECT 1 FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting') LIMIT 1").get()||db.prepare("SELECT 1 FROM detective_rounds WHERE phase='playing' LIMIT 1").get()));}
  private questPollAvailable():boolean{
    const modules=this.store.config<Record<string,boolean>>('modules',{}),poll=this.store.config<{enabled?:boolean}>('poll_settings',{}),quest=this.store.config<{enabled?:boolean}>('quest_settings',{});
    return modules.quests!==false&&modules.polls!==false&&poll.enabled!==false&&quest.enabled!==false&&!this.store.activeQuest()&&!this.store.activePoll(Date.now())&&this.store.approvedQuests(2).length>=2;
  }
  private interact(m:ChatMessage,kind:'feed'|'play'|'care',s:ArcadeSettings,now:number):string {
    return this.store.miniGameTransaction(db=>{
      const p=db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow;
      if(p.paused)return 'Elio macht gerade Pause.';
      if(db.prepare('SELECT 1 FROM community_pet_interactions WHERE event_id=?').get(m.eventId))return 'Diese Elio-Interaktion wurde bereits verarbeitet.';
      const previous=db.prepare('SELECT MAX(created_at) at FROM community_pet_interactions WHERE user_id=?').get(m.senderUserId) as {at:number|null};
      if(previous.at&&now-previous.at<s.petCooldownMs)return `⏳ Bitte noch ${Math.ceil((s.petCooldownMs-(now-previous.at))/1000)}s bis zur nächsten Pet-Aktion warten.`;
      const hunger=kind==='feed'?Math.min(100,p.hunger+8):p.hunger;
      const happiness=Math.min(100,p.happiness+(kind==='feed'?2:kind==='play'?8:5));
      const energy=kind==='play'?Math.max(10,p.energy-5):Math.min(100,p.energy+(kind==='care'?1:0));
      const xp=p.xp+(kind==='play'?5:2),level=1+Math.floor(xp/100),stage=stageFor(level);
      const animation=level>p.level?(stage!==p.stage?'evolution':'levelup'):kind==='feed'?'feed':kind==='play'?'play':'care';
      db.prepare('INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at) VALUES(?,?,?,?)').run(m.eventId,m.senderUserId,kind,now);
      db.prepare('DELETE FROM community_pet_interactions WHERE created_at<?').run(now-7*86_400_000);
      db.prepare('UPDATE community_pet SET hunger=?,happiness=?,energy=?,xp=?,level=?,stage=?,animation=?,updated_at=? WHERE id=1').run(hunger,happiness,energy,xp,level,stage,animation,now);
      return kind==='feed'?`@${clean(m.senderDisplayName,32)} gibt ${p.name} Katzenfutter oder ein Leckerli. Sättigung ${hunger}%, Zufriedenheit ${happiness}%.`:kind==='play'?`@${clean(m.senderDisplayName,32)} spielt mit ${p.name} an der Spielangel oder mit dem Wollknäuel. +5 Elio-XP (Level ${level}).`:`@${clean(m.senderDisplayName,32)} kümmert sich um ${p.name}. Zufriedenheit ${happiness}%, Energie ${energy}%.`;
    });
  }
  private startDrop(actor:string,now:number,rarityArg?:string):string {
    const rarity=(rarityArg||'common').toLowerCase();if(!(rarity in LIMITS))return '🎁 Diese Seltenheitsstufe gibt es nicht.';
    try{return this.store.miniGameTransaction(db=>this.insertDrop(db,actor,now,rarity));}
    catch{return '🎁 Es läuft bereits ein Drop.';}
  }
  private claim(m:ChatMessage,now:number):string {
    return this.store.miniGameTransaction(db=>{
      const d=db.prepare("SELECT id,ends_at FROM mystery_drops WHERE status IN ('announced','claiming') ORDER BY created_at DESC LIMIT 1").get() as {id:string;ends_at:number}|undefined;
      if(!d||d.ends_at<=now)return '🎁 Gerade ist kein Drop zum Claim offen.';
      const result=db.prepare('INSERT OR IGNORE INTO mystery_claims(drop_id,user_id,display_name,claimed_at) VALUES(?,?,?,?)').run(d.id,m.senderUserId,clean(m.senderDisplayName,48),now);
      return result.changes?'🎁 Du bist beim Mystery Drop dabei!':'🎁 Dein Claim ist bereits gespeichert.';
    });
  }
  private cancelDrop(now:number):boolean {return this.store.miniGameTransaction(db=>db.prepare("UPDATE mystery_drops SET status='canceled',resolved_at=? WHERE status IN ('announced','claiming')").run(now).changes>0);}
  private spin(actor:string,now:number,includeTasks=false):string {
    if(this.store.config('arcade_wheel_paused',false))return '🎡 Das Rad ist pausiert.';
    if(!includeTasks&&!this.settings().wheelAutoPilotEnabled)return '🎡 Der Auto-Pilot ist ausgeschaltet.';
    if(this.hasBlockingCommunityGame())return '🎡 Ein Community-Spiel läuft bereits. Das Rad wartet, damit es nicht dazwischenfunkt.';
    return this.store.miniGameTransaction(db=>{
      const open=db.prepare("SELECT 1 FROM chaos_wheel_spins WHERE status IN ('spinning','active')").get();if(open)return '🎡 Eine Rad-Aktion läuft bereits.';
      if(db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving') LIMIT 1").get())return '🎡 Ein Mystery Drop läuft bereits. Das Rad wartet, damit die Runde nicht gestört wird.';
      const recent=db.prepare("SELECT created_at FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {created_at:number}|undefined;
      if(recent&&now-recent.created_at<this.settings().wheelCooldownMs)return '🎡 Das Rad braucht noch eine kurze Pause.';
      const options=db.prepare("SELECT id,title,weight,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges WHERE active=1 AND action_type!='manual_challenge'").all() as Array<{id:string;title:string;weight:number;actionType:ChaosWheelActionType;wheelKey:string|null}>;
      const settings=this.settings();
      const dropActive=Boolean(db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving') LIMIT 1").get());
      const available=options.filter(x=>(x.actionType==='boost_pet'&&settings.petEnabled)||(x.actionType==='start_mystery_drop'&&settings.dropsEnabled&&!dropActive));
      let pool=available;
      if(includeTasks){
        const modules=this.store.config<Record<string,boolean>>('modules',{}),pollSettings=this.store.config<{enabled?:boolean}>('poll_settings',{}),questSettings=this.store.config<{enabled?:boolean}>('quest_settings',{});
        const approved=this.store.approvedQuests(5),hasPoll=Boolean(db.prepare("SELECT 1 FROM polls WHERE status='active'").get());
        const tasks=db.prepare("SELECT id,title,weight,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges WHERE active=1 AND action_type='manual_challenge' ORDER BY CASE wheel_key WHEN 'quest_vote' THEN 0 WHEN 'no_jumping' THEN 1 WHEN 'pistols_timer' THEN 2 ELSE 3 END").all() as typeof options;
        const taskAvailable=tasks.filter(x=>x.wheelKey==='no_jumping'||x.wheelKey==='pistols_timer'||(x.wheelKey==='quest_vote'&&modules.quests!==false&&modules.polls!==false&&pollSettings.enabled!==false&&questSettings.enabled!==false&&!hasPoll&&!this.store.activeQuest()&&approved.length>=2));
        pool=[...available,...taskAvailable];
      }
      const total=pool.reduce((a,x)=>a+x.weight,0);if(pool.length<2||total<=0)return '🎡 Es sind nicht genügend aktuell verfügbare Rad-Felder vorhanden.';
      let point=this.chooseIndex(total);if(!Number.isInteger(point)||point<0||point>=total)throw new Error('Wheel-Auswahl außerhalb des gültigen Bereichs.');
      const selected=pool.find(x=>(point-=x.weight)<0)!;
      const id=randomUUID();
      if(selected.actionType==='manual_challenge'){
        if(!includeTasks||!['quest_vote','no_jumping','pistols_timer'].includes(selected.wheelKey||''))return '🎡 Dieses Aufgabenfeld ist im Auto-Pilot nicht zulässig.';
        let taskRef:string|null=null,endsAt:number|null=null,status='completed',message='';
        if(selected.wheelKey==='quest_vote'){
          const approved=this.store.approvedQuests(5),pollCfg=this.store.config<{durationMs?:number;allowVoteChange?:boolean}>('poll_settings',{});
          const options=approved.slice(0,5).map(q=>({label:q.title,questId:q.id}));
          const poll=this.store.createPoll({type:'quest',question:'Welche Quest soll als Nächstes gespielt werden?',options,durationMs:Math.max(15_000,Math.min(120_000,pollCfg.durationMs??60_000)),allowVoteChange:pollCfg.allowVoteChange!==false,createdBy:actor,now});
          if(!poll)return '🎡 Die Quest-Auswahl kann gerade nicht starten; es wurde nichts ausgelöst.';
          taskRef=poll.id;endsAt=poll.endsAt;status='active';message=`📜 Quest-Wahl gestartet! Schreibt !vote 1 bis !vote ${options.length}. Die Abstimmung endet in ${Math.ceil((poll.endsAt-now)/1000)} Sekunden; die gewählte freigegebene Quest startet danach automatisch.`;
        }else if(selected.wheelKey==='pistols_timer'){
          endsAt=now+300_000;status='active';message='🎡 Jannicks Aufgabe: Fünf Minuten nur Pistolen! Der Countdown läuft; der Bot prüft nicht, welche Waffen im Spiel verwendet werden.';
        }else{status='active';message='🎡 Jannicks Aufgabe: Eine Runde ohne Springen! OBS zeigt die Aufgabe bis zum Beenden mit !cancelwheel. Der Bot kann die Einhaltung nicht prüfen.';}
        db.prepare("INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at,action_type,ends_at,resolved_at,wheel_key,task_ref) VALUES(?,?,?, ?,?,?,?, ?,?, ?,?)")
          .run(id,selected.id,selected.title,status,actor,now,selected.actionType,endsAt,status==='completed'?now:null,selected.wheelKey,taskRef);
        return message;
      }
      db.prepare("INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at,action_type,ends_at,resolved_at,wheel_key) VALUES(?,?,?,'completed',?,?,?,NULL,?,?)").run(id,selected.id,selected.title,actor,now,selected.actionType,now,selected.wheelKey);
      if(selected.actionType==='boost_pet'){
        db.prepare("UPDATE community_pet SET energy=MIN(100,energy+10),happiness=MIN(100,happiness+5),animation='happy',updated_at=? WHERE id=1").run(now);
        return `Ergebnis: ${selected.title}! Elio erhält automatisch +10 Energie und +5 Zufriedenheit.`;
      }
      if(selected.actionType==='start_mystery_drop'){
        const announcement=this.insertDrop(db,`wheel:${id}`,now,'common',id);
        return `🎡 Ergebnis: ${selected.title}! ${announcement}`;
      }
      throw new Error('Unbekannte Glücksrad-Aktion wurde verworfen.');
    });
  }
  private insertDrop(db:BetterSqlite3.Database,actor:string,now:number,rarity:string,sourceSpinId?:string):string {
    const id=randomUUID(),duration=this.settings().dropDurationMs,ends=now+duration;
    db.prepare("INSERT INTO mystery_drops(id,rarity,status,starts_at,ends_at,created_by,created_at,source_spin_id) VALUES(?,?,'claiming',?,?,?,?,?)")
      .run(id,rarity,now,ends,actor,now,sourceSpinId??null);
    return `🎁 Ein Mystery Drop startet! Schreibt innerhalb von ${Math.ceil(duration/1000)} Sekunden !claim, um mitzumachen!`;
  }
  private toPet(r:PetRow):PetState { return {name:r.name,level:r.level,xp:r.xp,hunger:r.hunger,happiness:r.happiness,energy:r.energy,stage:r.stage,paused:r.paused===1,animation:r.animation,updatedAt:r.updated_at}; }
}
function dropRarityLabel(rarity:string):string {
  return ({common:'Gewöhnlicher Drop',rare:'Seltener Drop',epic:'Epischer Drop',legendary:'Legendärer Drop',community:'Community-Drop'} as Record<string,string>)[rarity]??'Mystery Drop';
}
function availabilityReason(action:ChaosWheelActionType,settings:ArcadeSettings,dropActive:boolean):string {
  if(action==='manual_challenge')return 'Manuelle Felder sind dauerhaft vom Rad ausgeschlossen.';
  if(action==='boost_pet'&&!settings.petEnabled)return 'Elio ist derzeit ausgeschaltet.';
  if(action==='start_mystery_drop'&&!settings.dropsEnabled)return 'Mystery Drops sind derzeit ausgeschaltet.';
  if(action==='start_mystery_drop'&&dropActive)return 'Ein Mystery Drop läuft bereits.';
  return 'Diese Aktion ist derzeit nicht ausführbar.';
}
function wheelDescription(key:string|null,title:string):string {
  if(key==='quest_vote')return 'Chat stimmt über freigegebene Quests ab; die Gewinnerquest startet automatisch.';
  if(key==='no_jumping')return 'Jannicks Fortnite-Aufgabe: eine Runde ohne Springen. Nicht automatisch prüfbar.';
  if(key==='pistols_timer')return 'Jannicks Fortnite-Aufgabe: fünf Minuten nur Pistolen; Countdown läuft automatisch.';
  if(key==='gaming_quiz')return 'Deaktiviert; bleibt nur zur Wahrung der bisherigen Rad-Historie gespeichert.';
  if(key==='boost_pet')return 'Elio erhält sofort Energie und Zufriedenheit.';
  if(key==='start_mystery_drop')return 'Mystery Drop startet; !claim und XP-Auswertung laufen automatisch.';
  return title;
}
function stageFor(level:number):PetState['stage'] { return level>=25?'legendary':level>=15?'adult':level>=8?'young':level>=3?'baby':'egg'; }
function stageLabel(s:PetState['stage']):string { return ({egg:'Kätzchen',baby:'Jungkatze',young:'Erwachsene Katze',adult:'Erfahrene Katze',legendary:'Legendäre Community-Katze'})[s]; }
function nextStage(s:PetState['stage']):string { return ({egg:'Level 3 · Jungkatze',baby:'Level 8 · Erwachsene Katze',young:'Level 15 · Erfahrene Katze',adult:'Level 25 · Legendäre Community-Katze',legendary:'Höchste Lebensphase erreicht'})[s]; }
