import { randomInt, randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { ChatMessage } from './types.js';
import { FeatureStore, type QuestPolicy } from './feature-store.js';

export type ChaosWheelActionType = 'manual_challenge'|'start_mystery_drop'|'boost_pet';

export interface ArcadeSettings {
  petEnabled: boolean; petPersonalityEnabled:boolean; dropsEnabled: boolean; wheelEnabled: boolean; wheelAutoPilotEnabled: boolean; autoDrops: boolean;
  petMilestoneBonusEnabled:boolean; petMilestoneBonusXp:number;
  petCooldownMs: number; dropDurationMs: number; wheelCooldownMs: number; allowChatSpin: boolean;
  activityRetentionDays: number; wheelChallengeDurationMs: number;
  viewerRewardsEnabled:boolean;viewerActivityWindowMinutes:number;wheelWinnerXp:number;wheelCommunityBonusXp:number;
  wheelPersonalMysteryDrop:boolean;wheelWinnerChatAnnouncement:boolean;wheelWinnerOverlay:boolean;wheelMaxRewardsPerStream:number;
}
export interface PetState {
  name: string; level: number; xp: number; hunger: number; happiness: number; energy: number;
  stage: 'egg'|'baby'|'young'|'adult'|'legendary'; paused: boolean; animation: string; updatedAt: number;
  sleeping:boolean;sleepUntil:number;
  mood:'happy'|'tired'|'hungry'|'playful'|'cheeky'|'calm';moodLabel:string;
  outfit:{id:string;label:string;emoji:string};unlockedOutfits:Array<{id:string;label:string;emoji:string;unlockLevel:number;unlocked:boolean}>;
}
export interface PetPortalAction {
  ok:boolean; message:string; remainingMs:number; reaction?:string; changes?:{hunger:number;happiness:number;energy:number;xp:number;level:number}; leveledUp?:boolean;bonusXp?:number;
}
interface PetRow {name:string;level:number;xp:number;hunger:number;happiness:number;energy:number;stage:PetState['stage'];paused:number;animation:string;updated_at:number;state_updated_at:number;sleep_until:number}
const DEFAULT_SETTINGS: ArcadeSettings = { petEnabled:false,petPersonalityEnabled:true,petMilestoneBonusEnabled:false,petMilestoneBonusXp:5,dropsEnabled:false,wheelEnabled:false,wheelAutoPilotEnabled:true,autoDrops:false,petCooldownMs:120_000,dropDurationMs:60_000,wheelCooldownMs:300_000,allowChatSpin:false,activityRetentionDays:90,wheelChallengeDurationMs:300_000,viewerRewardsEnabled:false,viewerActivityWindowMinutes:15,wheelWinnerXp:25,wheelCommunityBonusXp:10,wheelPersonalMysteryDrop:false,wheelWinnerChatAnnouncement:true,wheelWinnerOverlay:true,wheelMaxRewardsPerStream:5 };
const PET_OUTFITS=[{id:'classic',label:'Klassischer Elio',emoji:'🐱',unlockLevel:1},{id:'gaming',label:'Gaming-Elio',emoji:'🎮🐱',unlockLevel:2},{id:'sleepy',label:'Schlafmützen-Elio',emoji:'😴🐱',unlockLevel:4},{id:'halloween',label:'Halloween-Elio',emoji:'🎃🐱',unlockLevel:6},{id:'king',label:'König Elio',emoji:'👑🐱',unlockLevel:10},{id:'winter',label:'Winter-Elio',emoji:'❄️🐱',unlockLevel:15}] as const;
const VIEWER_WHEEL_KEYS=new Set(['viewer_xp','viewer_mystery_drop','viewer_honor','community_bonus','quest_luck','chaos_title','extra_spin']);
const PET_EVENT_INTERVAL_MIN=3*60*60_000,PET_EVENT_INTERVAL_SPAN=3*60*60_000,PET_EVENT_RETENTION=30*86_400_000;
const PET_REACTIONS:Record<'feed'|'play'|'care',readonly string[]>={
  feed:['Elio schnurrt zufrieden und stupst deine Hand an.','Mjam! Das Leckerli war genau richtig.','Elio fängt das Leckerli mit einer kleinen Pfote.'],
  play:['Elio jagt dem Spielzeug hinterher und macht einen Luftsprung.','Die Spielangel ist besiegt – Elio sieht sehr stolz aus.','Elio rollt dem Wollknäuel hinterher und schnurrt.'],
  care:['Elio genießt die ruhige Aufmerksamkeit.','Elio blinzelt zufrieden und kuschelt sich ein.','Ein sanftes Schnurren: Elio fühlt sich wohl.'],
};
const PET_COMMON_EVENTS=[
  {kind:'ambient' as const,message:'Elio hat die Tastatur besetzt. Arbeiten ist offiziell kurz pausiert.'},
  {kind:'community' as const,message:'Elio hat ein geheimnisvolles Spielzeug gefunden. Wer mag, kann im Portal mit ihm spielen!'},
  {kind:'ambient' as const,message:'Elio verlangt Aufmerksamkeit. Sofort. Ein Besuch im Community-Portal hilft.'},
  {kind:'ambient' as const,message:'Elio hat Janniks Gaming-Stuhl erobert. Die nächste Runde muss wohl warten.'},
];
const PET_RARE_EVENTS=[
  '✨ Elio hat eine sternenstaubige Spielmaus entdeckt. Sie funkelt – mehr passiert nicht, aber Elio ist begeistert.',
  '🌙 Ein winziger Geisterfisch huscht durchs Zimmer. Elio hat ihn gesehen. Bestimmt.',
  '🔮 Elio sitzt vor einem leuchtenden Wollknäuel und tut sehr geheimnisvoll.',
];
const PET_MOODS:Record<PetState['mood'],string>={happy:'😻 Glücklich',tired:'😴 Müde',hungry:'🍽️ Hungrig',playful:'🧶 Verspielt',cheeky:'😼 Frech',calm:'🐾 Entspannt'};
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
  private currentStreamId:string|undefined;
  constructor(private readonly store:FeatureStore, private readonly broadcasterId:string, private readonly chooseIndex:(exclusiveMax:number)=>number=randomInt) {
    this.store.miniGameTransaction(db=>{
      const n=(db.prepare('SELECT COUNT(*) n FROM chaos_wheel_challenges').get() as {n:number}).n;
      if(!n)for(const challenge of DEFAULT_CHALLENGES)db.prepare('INSERT INTO chaos_wheel_challenges(id,title,weight,active,action_type) VALUES(?,?,1,1,?)').run(challenge.id,challenge.title,challenge.actionType);
    });
  }
  settings():ArcadeSettings { return {...DEFAULT_SETTINGS,...this.store.config<Partial<ArcadeSettings>>('arcade_settings',{})}; }
  setCurrentStreamId(streamId:string|undefined):void{this.currentStreamId=streamId||undefined;}
  updateSettings(next:ArcadeSettings,now=Date.now()):void {
    for(const k of ['petEnabled','dropsEnabled','wheelEnabled','wheelAutoPilotEnabled','autoDrops','allowChatSpin','viewerRewardsEnabled','wheelPersonalMysteryDrop','wheelWinnerChatAnnouncement','wheelWinnerOverlay'] as const)if(typeof next[k]!=='boolean')throw new Error(`Ungültige Arcade-Einstellung: ${k}`);
    if(typeof next.petPersonalityEnabled!=='boolean')throw new Error('Ungültige Elio-Einstellung.');
    if(typeof next.petMilestoneBonusEnabled!=='boolean')throw new Error('Der Elio-Meilensteinbonus muss Ein oder Aus sein.');
    if(!Number.isInteger(next.petMilestoneBonusXp)||next.petMilestoneBonusXp<1||next.petMilestoneBonusXp>10)throw new Error('Der Elio-Meilensteinbonus muss zwischen 1 und 10 XP liegen.');
    for(const k of ['petCooldownMs','dropDurationMs','wheelCooldownMs','wheelChallengeDurationMs'] as const)if(!Number.isInteger(next[k])||next[k]<1000||next[k]>86_400_000)throw new Error(`Ungültige Arcade-Einstellung: ${k}`);
    if(!Number.isInteger(next.viewerActivityWindowMinutes)||next.viewerActivityWindowMinutes<5||next.viewerActivityWindowMinutes>60)throw new Error('Das Aktivitätsfenster muss zwischen 5 und 60 Minuten liegen.');
    if(!Number.isInteger(next.wheelWinnerXp)||next.wheelWinnerXp<1||next.wheelWinnerXp>100)throw new Error('Die Gewinner-XP müssen zwischen 1 und 100 liegen.');
    if(!Number.isInteger(next.wheelCommunityBonusXp)||next.wheelCommunityBonusXp<1||next.wheelCommunityBonusXp>20)throw new Error('Der Community-Bonus muss zwischen 1 und 20 XP liegen.');
    if(!Number.isInteger(next.wheelMaxRewardsPerStream)||next.wheelMaxRewardsPerStream<1||next.wheelMaxRewardsPerStream>50)throw new Error('Das Limit muss zwischen 1 und 50 Gewinnen pro Stream liegen.');
    if(!Number.isInteger(next.activityRetentionDays)||next.activityRetentionDays<1||next.activityRetentionDays>3650)throw new Error('activityRetentionDays muss zwischen 1 und 3650 liegen.');
    const previous=this.settings().petPersonalityEnabled;
    this.store.setConfig('arcade_settings',next);
    if(next.petPersonalityEnabled!==previous)this.store.setConfig('pet_personality_next_event_at',next.petPersonalityEnabled?now+this.petEventInterval():0);
  }
  pet(now=Date.now()):PetState { return this.store.miniGameTransaction(db=>{this.applyPetNeeds(db,now);return this.petState(db,now);}); }
  petInteractionStats(now=Date.now()):{periodDays:7;total:number;feed:number;play:number;care:number;activeUsers:number}{return this.store.miniGameQuery(db=>{const row=db.prepare("SELECT COUNT(*) total,SUM(kind='feed') feed,SUM(kind='play') play,SUM(kind='care') care,COUNT(DISTINCT user_id) activeUsers FROM community_pet_interactions WHERE created_at>=?").get(now-7*86_400_000) as {total:number;feed:number|null;play:number|null;care:number|null;activeUsers:number};return {periodDays:7 as const,total:row.total,feed:row.feed||0,play:row.play||0,care:row.care||0,activeUsers:row.activeUsers};});}
  setPetOutfit(id:string):{id:string;label:string;emoji:string}{return this.store.miniGameTransaction(db=>{const row=db.prepare('SELECT level FROM community_pet WHERE id=1').get() as {level:number};const outfit=PET_OUTFITS.find(item=>item.id===id);if(!outfit)throw new Error('Dieses Elio-Outfit gibt es nicht.');if(row.level<outfit.unlockLevel)throw new Error(`Dieses Outfit wird ab Elio-Level ${outfit.unlockLevel} freigeschaltet.`);this.store.setConfig('community_pet_outfit',id);db.prepare("UPDATE community_pet SET animation='happy',updated_at=? WHERE id=1").run(Date.now());return {id:outfit.id,label:outfit.label,emoji:outfit.emoji};});}
  petActivity(now=Date.now()):Array<{id:string;kind:string;message:string;rare:boolean;createdAt:number}>{
    return this.store.miniGameQuery(db=>this.petActivities(db,now));
  }
  petPortalStatus(userId:string,now=Date.now()):{enabled:boolean;paused:boolean;remainingMs:number;cooldownMs:number} {
    return this.store.miniGameQuery(db=>{
      const p=db.prepare('SELECT paused FROM community_pet WHERE id=1').get() as {paused:number};
      const previous=db.prepare('SELECT MAX(created_at) at FROM community_pet_interactions WHERE user_id=?').get(userId) as {at:number|null};
      const cooldownMs=this.settings().petCooldownMs;
      return {enabled:this.settings().petEnabled,paused:p.paused===1,cooldownMs,remainingMs:previous.at===null?0:Math.max(0,cooldownMs-(now-previous.at))};
    });
  }
  interactFromPortal(m:ChatMessage,kind:'feed'|'play'|'care'|'sleep',now=Date.now()):PetPortalAction {
    const settings=this.settings();
    if(!settings.petEnabled)return {ok:false,message:'Elio macht gerade Pause; die Katzenpflege ist derzeit deaktiviert.',remainingMs:0};
    return this.interact(m,kind,settings,now,true);
  }
  claimFromPortal(m:ChatMessage,now=Date.now(),expectedDropId?:string):{ok:boolean;joined:boolean;message:string;dropId?:string;participants?:number} {
    if(!this.settings().dropsEnabled)return {ok:false,joined:false,message:'Mystery Drops sind derzeit deaktiviert.'};
    return this.store.miniGameTransaction(db=>{
      const drop=db.prepare("SELECT id,ends_at FROM mystery_drops WHERE status IN ('announced','claiming') ORDER BY created_at DESC LIMIT 1").get() as {id:string;ends_at:number}|undefined;
      if(!drop||drop.ends_at<=now||(expectedDropId&&drop.id!==expectedDropId))return {ok:false,joined:false,message:'Dieser Mystery Drop ist nicht mehr offen.'};
      const inserted=db.prepare('INSERT OR IGNORE INTO mystery_claims(drop_id,user_id,display_name,claimed_at) VALUES(?,?,?,?)').run(drop.id,m.senderUserId,clean(m.senderDisplayName,48),now).changes===1;
      const participants=(db.prepare('SELECT COUNT(*) n FROM mystery_claims WHERE drop_id=?').get(drop.id) as {n:number}).n;
      return {ok:true,joined:inserted,message:inserted?'Du bist beim Mystery Drop dabei!':'Deine Teilnahme ist bereits gespeichert.',dropId:drop.id,participants};
    });
  }
  snapshot(type:'pet'|'drop'|'wheel',now=Date.now()):Record<string,unknown> {
    return this.store.miniGameTransaction(db=>{
      if(type==='pet'){
        this.applyPetNeeds(db,now);
        const p=this.petState(db,now),events=this.petActivities(db,now),rare=events.find(event=>event.rare&&now-event.createdAt<=20_000);
        return {type,visible:this.settings().petEnabled,pet:{...p,stageLabel:stageLabel(p.stage)},events,
          obsHint:this.settings().petPersonalityEnabled&&rare?{message:rare.message,createdAt:rare.createdAt}:null,capturedAt:now};
      }
      if(type==='drop'){
        const d=db.prepare("SELECT * FROM mystery_drops WHERE status IN ('announced','claiming','resolving','completed') ORDER BY created_at DESC LIMIT 1").get() as {id:string;rarity:string;status:string;starts_at:number;ends_at:number;result_json:string|null;resolved_at:number|null}|undefined;
        if(!d||(['completed'].includes(d.status)&&now-(d.resolved_at||0)>12000))return {type,visible:false,capturedAt:now};
        const participants=(db.prepare('SELECT COUNT(*) n FROM mystery_claims WHERE drop_id=?').get(d.id) as {n:number}).n;
        return {type,visible:this.settings().dropsEnabled,drop:{id:d.id,rarityLabel:dropRarityLabel(d.rarity),status:d.status,endsAt:d.ends_at,participants,result:d.result_json?JSON.parse(d.result_json):null},capturedAt:now};
      }
      const w=db.prepare("SELECT * FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {id:string;title:string;status:string;created_at:number;resolved_at:number|null;ends_at:number|null;action_type:string;wheel_key:string|null}|undefined;
      const visible=!!w&&this.settings().wheelEnabled&&(w.status==='active'||now-(w.resolved_at??w.created_at)<15_000);
      return {type,visible,wheel:w?{id:w.id,title:w.title,status:w.status,actionType:w.action_type,wheelKey:w.wheel_key,createdAt:w.created_at,endsAt:w.ends_at}:null,capturedAt:now};
    });
  }
  handle(m:ChatMessage,command:string,args:string[],now=Date.now()):string|undefined {
    const s=this.settings(), admin=m.senderUserId===this.broadcasterId, mod=admin||m.isModerator===true;
    if(['pet','feed','play','petcare','petstats','petname','pethelp','petevolution','setpetname','petpause','petresume','petsleep','petwake'].includes(command)){
      if(!s.petEnabled&&command!=='pethelp')return 'Elio macht gerade Pause; die Katzenpflege ist derzeit deaktiviert.';
      if(command==='pethelp')return 'Elio 🐱: !pet Zustand · !feed Katzenfutter · !play Spielangel/Wollknäuel · !petcare Pflege · !petsleep Ruhezeit · !petstats Werte. Jannik kann mit !petwake wecken. Cooldown: 2 Min.';
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
      if(command==='petwake'){
        if(!admin)return '⛔ Nur Jannik darf Elio vorzeitig wecken.';
        this.store.miniGameTransaction(db=>db.prepare("UPDATE community_pet SET sleep_until=0,animation='idle',updated_at=? WHERE id=1").run(now));return '🐱 Elio ist wieder wach.';
      }
      const kind=command==='feed'?'feed':command==='play'?'play':command==='petsleep'?'sleep':'care';
      return this.interact(m,kind,s,now).message;
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
      const result=this.spin(m.senderUserId,now,true);
      return this.winnerChatAnnouncementEnabled()||!result.includes('@')?result:undefined;
    }
    return undefined;
  }
  tick(now=Date.now()):string[] { return this.tickMessages(now).map(item=>item.message); }
  tickMessages(now=Date.now()):Array<{message:string;category:'wheel'|'drop'|'pet'}> {
    const out:Array<{message:string;category:'wheel'|'drop'|'pet'}>=[];
    this.advancePetPersonalityEvent(now);
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
      const completed=this.store.miniGameTransaction(db=>{
        const changed=db.prepare("UPDATE mystery_drops SET status='completed',result_json=?,resolved_at=? WHERE id=? AND status='resolving'").run(JSON.stringify(due.result),now,due.id).changes===1;
        if(changed)this.store.recordCommunityEvent('mystery.drop.completed',{id:due.id,participants:due.claims.length,rewardXp:due.claims.length?due.amount:0},now);
        return changed;
      });
      if(completed)out.push({message:due.claims.length
        ?`🎁 Der Mystery Drop ist geöffnet! ${due.claims.length} ${due.claims.length===1?'Person erhält':'Personen erhalten'} je ${due.amount} XP. Danke fürs Mitmachen – Elio schnurrt schon!`
        :'🎁 Der Mystery Drop ist vorbei – diesmal hat niemand mitgemacht. Beim nächsten Mal mit !claim dabei sein!',category:'drop'});
    }
    const batch=this.store.miniGameTransaction(db=>{
      const oldest=now-2*60_000;
      db.prepare("UPDATE community_pet_interactions SET announced_at=created_at WHERE source='chat' AND announced_at IS NULL AND created_at<?").run(oldest);
      const rows=db.prepare("SELECT event_id,user_id,kind FROM community_pet_interactions WHERE source='chat' AND announced_at IS NULL AND created_at>=? AND created_at<=? ORDER BY created_at").all(now-60_000,now) as Array<{event_id:string;user_id:string;kind:string}>;
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
      this.applyPetNeeds(db,now);
      db.prepare("UPDATE community_pet SET animation=CASE WHEN paused=1 OR sleep_until>? THEN 'sleep' WHEN animation IN ('feed','play','care','happy','drop','levelup','evolution') AND updated_at<? THEN 'idle' ELSE animation END WHERE id=1").run(now,now-12000);
      db.prepare("UPDATE community_pet SET animation='idle' WHERE id=1 AND animation='surprise' AND COALESCE((SELECT MAX(created_at) FROM community_pet_events WHERE kind IN ('ambient','rare','community')),0)<?").run(now-12_000);
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
  activeChallenges():Array<{id:string;title:string;weight:number;actionType:ChaosWheelActionType;wheelKey:string|null}> { return this.store.miniGameQuery(db=>db.prepare("SELECT id,title,weight,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges WHERE active=1 AND (action_type!='manual_challenge' OR wheel_key IN ('viewer_xp','viewer_mystery_drop','viewer_honor','community_bonus','quest_luck','chaos_title','extra_spin')) ORDER BY title").all() as Array<{id:string;title:string;weight:number;actionType:ChaosWheelActionType;wheelKey:string|null}>); }
  manageChallenges():Array<{id:string;title:string;weight:number;active:boolean;actionType:ChaosWheelActionType;wheelKey:string|null;kind:'automatic'|'streamer-task'|'viewer-prize';description:string}> { return this.store.miniGameQuery(db=>(db.prepare('SELECT id,title,weight,active,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges ORDER BY title').all() as Array<{id:string;title:string;weight:number;active:number;actionType:ChaosWheelActionType;wheelKey:string|null}>).map(x=>({...x,active:x.active===1,kind:VIEWER_WHEEL_KEYS.has(x.wheelKey||'')?'viewer-prize':x.actionType==='manual_challenge'?'streamer-task':'automatic',description:wheelDescription(x.wheelKey,x.title)}))); }
  wheelStatus(now=Date.now()):Record<string,unknown>{
    const settings=this.settings();
    const active=this.store.miniGameQuery(db=>db.prepare("SELECT id,title,action_type actionType,wheel_key wheelKey,created_at createdAt,ends_at endsAt FROM chaos_wheel_spins WHERE status='active' ORDER BY created_at DESC LIMIT 1").get() as {id:string;title:string;actionType:ChaosWheelActionType;wheelKey:string|null;createdAt:number;endsAt:number|null}|undefined);
    const latest=this.store.miniGameQuery(db=>db.prepare("SELECT created_at createdAt FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {createdAt:number}|undefined);
    const activeDrop=this.store.miniGameQuery(db=>db.prepare("SELECT d.ends_at endsAt,d.source_spin_id sourceSpinId FROM mystery_drops d WHERE d.status IN ('announced','claiming','resolving') ORDER BY d.created_at DESC LIMIT 1").get() as {endsAt:number;sourceSpinId:string|null}|undefined);
    const gameRunning=this.hasBlockingCommunityGame();
    const dropActive=!!this.store.miniGameQuery(db=>db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving')").get());
    const participants=this.store.recentChatActivity(now,settings.viewerActivityWindowMinutes,[this.broadcasterId]);
    const xpEligible=participants.filter(user=>this.store.miniGameQuery(db=>this.bonusXpRemaining(db,user.userId,now,100)>0));
    const dropEligible=participants.filter(user=>this.store.miniGameQuery(db=>this.bonusXpRemaining(db,user.userId,now,50)>0));
    const prizeSlotsRemaining=this.wheelPrizeSlotsRemaining(settings);
    const approvedQuestCount=this.store.approvedQuests(50).length;
    const challenges=this.activeChallenges();
    const available=challenges.filter(x=>(x.actionType==='boost_pet'&&settings.petEnabled)||(x.actionType==='start_mystery_drop'&&settings.dropsEnabled&&!dropActive)
      ||(settings.viewerRewardsEnabled&&this.currentStreamId&&prizeSlotsRemaining>0&&((x.wheelKey==='viewer_xp'&&xpEligible.length>0)||(x.wheelKey==='viewer_mystery_drop'&&settings.wheelPersonalMysteryDrop&&settings.dropsEnabled&&dropEligible.length>0&&!dropActive)
        ||(['viewer_honor','chaos_title'].includes(x.wheelKey||'')&&participants.length>0)||(x.wheelKey==='community_bonus'&&participants.length>0)
        ||(x.wheelKey==='quest_luck'&&approvedQuestCount>0)||(x.wheelKey==='extra_spin'&&participants.length>0))));
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
      const automatic=x.kind==='automatic'||x.kind==='viewer-prize',poolTotal=automatic?total:total+taskTotal;
      const eligible=automatic?available.some(a=>a.id===x.id):tasks.some(t=>t.id===x.id);
      return {...x,probabilityLabel:automatic?'Auto-Pilot':'Manueller Dreh',probability:eligible&&poolTotal?Math.round(x.weight/poolTotal*1000)/10:0};
    });
    const viewerUnavailable=managed.filter(x=>x.active&&VIEWER_WHEEL_KEYS.has(x.wheelKey||'')&&!available.some(a=>a.id===x.id)).map(x=>({id:x.id,title:x.title,reason:!settings.viewerRewardsEnabled?'Zuschauer-Belohnungen sind deaktiviert.':!this.currentStreamId?'Es gibt noch keine bestätigte Live-Stream-ID.':prizeSlotsRemaining<=0?'Das Gewinnlimit für diesen Stream ist erreicht.':x.wheelKey==='viewer_xp'&&xpEligible.length===0?'Die aktiven Zuschauer haben ihr tägliches Bonus-XP-Limit erreicht oder sind nicht aktiv.':x.wheelKey==='viewer_mystery_drop'&&!settings.wheelPersonalMysteryDrop?'Persönliche Mystery Drops sind deaktiviert.':x.wheelKey==='viewer_mystery_drop'&&!settings.dropsEnabled?'Mystery Drops sind deaktiviert.':x.wheelKey==='quest_luck'&&approvedQuestCount===0?'Es gibt keine freigegebene Quest zum Hervorheben.':'Es ist aktuell niemand im Aktivitätsfenster berechtigt.'}));
    const questReady=this.questPollAvailable();
    const manualCanSpin=settings.wheelEnabled&&!active&&!activeDrop&&!gameRunning&&now>=nextSpinAt&&available.length+tasks.length>=2&&this.manageChallenges().some(x=>x.active&&x.wheelKey==='no_jumping'||x.active&&x.wheelKey==='pistols_timer'||x.active&&x.wheelKey==='quest_vote'&&questReady);
    const lastWinner=this.store.miniGameQuery(db=>db.prepare("SELECT winner_name winnerName,result_label resultLabel,created_at createdAt FROM chaos_wheel_spins WHERE winner_name IS NOT NULL ORDER BY created_at DESC LIMIT 1").get()) as {winnerName:string;resultLabel:string|null;createdAt:number}|undefined;
    return {enabled:settings.wheelEnabled,autoPilotEnabled:settings.wheelAutoPilotEnabled&&!this.store.config('arcade_wheel_paused',false),canSpin:reason==='Bereit für den nächsten Dreh.',canManualSpin:manualCanSpin,reason,nextSpinAt,nextAutoSpinAt,autoSpinDue:now>=nextAutoSpinAt,activeViewerCount:participants.length,eligibleWinnerCount:xpEligible.length,prizeSlotsRemaining,lastWinner:lastWinner||null,activeAction:active??(activeDrop?{actionType:'start_mystery_drop',title:activeDrop.sourceSpinId?'Mystery Drop vom Glücksrad':'Mystery Drop',endsAt:activeDrop.endsAt}:null),entries:available.map(x=>({...x,probability:total?Math.round(x.weight/total*1000)/10:0,automation:'Automatisch durch den Bot.'})),taskEntries:tasks.map(x=>({...x,probability:taskTotal?Math.round(x.weight/taskTotal*1000)/10:0,automation:'Janniks Aufgabe im Fortnite-Spiel.'})),wheelFields,unavailable:[...challenges.filter(x=>!available.some(a=>a.id===x.id)&&x.actionType!=='manual_challenge').map(x=>({id:x.id,title:x.title,reason:availabilityReason(x.actionType,settings,dropActive)})),...viewerUnavailable,...this.manageChallenges().filter(x=>x.active&&x.wheelKey==='quest_vote'&&!questReady).map(x=>({id:x.id,title:x.title,reason:'Mindestens zwei freigegebene Quests sowie freie Quest- und Umfrageplätze erforderlich.'}))]};
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
    return result?'🎡 Janniks laufende Rad-Aufgabe wurde beendet. Das Ergebnis wurde nicht bewertet.':'🎡 Es läuft keine Rad-Aufgabe.';
  }
  startDropAdmin(actor:string,rarity:string|undefined,now=Date.now()):string { if(!this.settings().dropsEnabled)return '🎁 Mystery Drops sind deaktiviert.';return this.startDrop(actor,now,rarity); }
  cancelDropAdmin(now=Date.now()):boolean{return this.cancelDrop(now);}
  spinAdmin(actor:string,now=Date.now()):string { if(!this.settings().wheelEnabled)return '🎡 Das Chaos Wheel ist deaktiviert.';return this.spin(actor,now,true); }
  winnerChatAnnouncementEnabled():boolean{return this.settings().wheelWinnerChatAnnouncement;}
  configureWheelField(id:string,active:boolean,weight:number):void{
    if(!Number.isInteger(weight)||weight<1||weight>1000)throw new Error('Wahrscheinlichkeit ist ungültig.');
    this.store.miniGameTransaction(db=>{
      const row=db.prepare('SELECT wheel_key,action_type FROM chaos_wheel_challenges WHERE id=?').get(id) as {wheel_key:string|null;action_type:ChaosWheelActionType}|undefined;
      if(!row)throw new Error('Radfeld nicht gefunden.');
      if(row.wheel_key==='gaming_quiz'&&active)throw new Error('Gaming-Quiz bleibt deaktiviert.');
      if(active&&row.action_type==='manual_challenge'&&!['quest_vote','no_jumping','pistols_timer',...VIEWER_WHEEL_KEYS].includes(row.wheel_key||''))throw new Error('Dieses historische Aufgabenfeld ist nicht automatisiert und bleibt aus dem Rad ausgeschlossen.');
      db.prepare('UPDATE chaos_wheel_challenges SET active=?,weight=? WHERE id=?').run(active?1:0,weight,id);
    });
  }
  private hasBlockingCommunityGame():boolean{return this.store.miniGameQuery(db=>Boolean(db.prepare(`SELECT 1 FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting')
    UNION ALL SELECT 1 FROM detective_rounds WHERE phase IN ('playing','results')
    UNION ALL SELECT 1 FROM community_chaos_events WHERE status='active'
    UNION ALL SELECT 1 FROM community_interactive_events WHERE status='open' AND kind!='game_night'
    UNION ALL SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving')
    UNION ALL SELECT 1 FROM chaos_wheel_spins WHERE status IN ('spinning','active')
    UNION ALL SELECT 1 FROM boss_fights WHERE status='active'
    UNION ALL SELECT 1 FROM polls WHERE status='active'
    UNION ALL SELECT 1 FROM community_vault_rounds WHERE status='active'
    UNION ALL SELECT 1 FROM seasonal_events WHERE active=1 LIMIT 1`).get()));}
  private wheelPrizeSlotsRemaining(settings=this.settings()):number{
    if(!this.currentStreamId)return 0;
    const used=this.store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM chaos_wheel_spins WHERE stream_id=? AND reward_status IN ('granted','cosmetic')").get(this.currentStreamId) as {n:number}).n);
    return Math.max(0,settings.wheelMaxRewardsPerStream-used);
  }
  private questPollAvailable():boolean{
    const modules=this.store.config<Record<string,boolean>>('modules',{}),poll=this.store.config<{enabled?:boolean}>('poll_settings',{}),quest=this.store.config<{enabled?:boolean}>('quest_settings',{});
    return modules.quests!==false&&modules.polls!==false&&poll.enabled!==false&&quest.enabled!==false&&!this.store.activeQuest()&&!this.store.activePoll(Date.now())&&this.store.approvedQuests(2).length>=2;
  }
  private interact(m:ChatMessage,kind:'feed'|'play'|'care'|'sleep',s:ArcadeSettings,now:number,portal=false):PetPortalAction {
    return this.store.miniGameTransaction(db=>{
      this.applyPetNeeds(db,now);
      const p=db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow;
      if(p.paused)return {ok:false,message:'Elio macht gerade Pflegepause.',remainingMs:0};
      if(p.sleep_until>now&&kind!=='care')return {ok:false,message:'Elio schläft gerade. Er wacht nach seiner Ruhezeit von selbst wieder auf.',remainingMs:p.sleep_until-now};
      if(db.prepare('SELECT 1 FROM community_pet_interactions WHERE event_id=?').get(m.eventId))return {ok:false,message:'Diese Elio-Aktion wurde bereits verarbeitet.',remainingMs:0};
      const previous=db.prepare('SELECT MAX(created_at) at FROM community_pet_interactions WHERE user_id=?').get(m.senderUserId) as {at:number|null};
      if(previous.at!==null&&now-previous.at<s.petCooldownMs){const remainingMs=s.petCooldownMs-(now-previous.at);return {ok:false,message:`⏳ Bitte noch ${Math.ceil(remainingMs/1000)}s bis zur nächsten Pet-Aktion warten.`,remainingMs};}
      const hunger=kind==='feed'?Math.min(100,p.hunger+8):p.hunger;
      const happiness=Math.min(100,p.happiness+(kind==='feed'?2:kind==='play'?8:kind==='sleep'?1:5));
      const energy=kind==='play'?Math.max(10,p.energy-8):Math.min(100,p.energy+(kind==='care'?2:0));
      const xp=p.xp+(kind==='play'?5:kind==='sleep'?0:2),level=1+Math.floor(xp/100),stage=stageFor(level);
      const animation=kind==='sleep'?'sleep':level>p.level?(stage!==p.stage?'evolution':'levelup'):kind==='feed'?'feed':kind==='play'?'play':'care';
      const sleepUntil=kind==='sleep'?now+6*60*60_000:Math.max(0,p.sleep_until||0);
      db.prepare('INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at,source) VALUES(?,?,?,?,?)').run(m.eventId,m.senderUserId,kind,now,portal?'portal':'chat');
      db.prepare('DELETE FROM community_pet_interactions WHERE created_at<?').run(now-7*86_400_000);
      db.prepare('UPDATE community_pet SET hunger=?,happiness=?,energy=?,xp=?,level=?,stage=?,animation=?,sleep_until=?,state_updated_at=?,updated_at=? WHERE id=1').run(hunger,happiness,energy,xp,level,stage,animation,sleepUntil,now,now);
      const bonusXp=s.petMilestoneBonusEnabled&&level>p.level&&level%5===0?this.store.awardXp(`elio-milestone:${m.eventId}`,m.senderUserId,clean(m.senderDisplayName,48),s.petMilestoneBonusXp,'bonus:elio-milestone',now,10):0;
      const reaction=kind==='sleep'?'Elio rollt sich ein und macht ein wohlverdientes Nickerchen.':this.personalityReaction(kind,db,now);
      const bonusMessage=bonusXp?` 🎉 Elio-Meilenstein: +${bonusXp} Community-XP.`:'';
      const message=kind==='feed'?`@${clean(m.senderDisplayName,32)} gibt ${p.name} Katzenfutter oder ein Leckerli. Sättigung ${hunger}%, Zufriedenheit ${happiness}%. ${reaction}${bonusMessage}`:kind==='play'?`@${clean(m.senderDisplayName,32)} spielt mit ${p.name} an der Spielangel oder mit dem Wollknäuel. +5 Elio-XP (Level ${level}). ${reaction}${bonusMessage}`:kind==='sleep'?`${p.name} ruht sich sechs Stunden aus. Energie ${energy}%. ${reaction}`:`@${clean(m.senderDisplayName,32)} kümmert sich um ${p.name}. Zufriedenheit ${happiness}%, Energie ${energy}%. ${reaction}${bonusMessage}`;
      return {ok:true,message,reaction,remainingMs:s.petCooldownMs,changes:{hunger:hunger-p.hunger,happiness:happiness-p.happiness,energy:energy-p.energy,xp:xp-p.xp,level:level-p.level},leveledUp:level>p.level,...(bonusXp?{bonusXp}:{})};
    });
  }
  private startDrop(actor:string,now:number,rarityArg?:string):string {
    const rarity=(rarityArg||'common').toLowerCase();if(!(rarity in LIMITS))return '🎁 Diese Seltenheitsstufe gibt es nicht.';
    try{return this.store.miniGameTransaction(db=>{const conflict=db.prepare(`SELECT 1 FROM community_chaos_events WHERE status='active'
      UNION ALL SELECT 1 FROM community_interactive_events WHERE status='open' AND kind!='game_night'
      UNION ALL SELECT 1 FROM chaos_wheel_spins WHERE status IN ('spinning','active')
      UNION ALL SELECT 1 FROM boss_fights WHERE status='active' UNION ALL SELECT 1 FROM polls WHERE status='active'
      UNION ALL SELECT 1 FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting')
      UNION ALL SELECT 1 FROM detective_rounds WHERE phase IN ('playing','results') UNION ALL SELECT 1 FROM community_vault_rounds WHERE status='active'
      UNION ALL SELECT 1 FROM seasonal_events WHERE active=1 UNION ALL SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving') LIMIT 1`).get();if(conflict)return '🎁 Ein anderes Community-Event läuft bereits. Der Mystery Drop wartet.';return this.insertDrop(db,actor,now,rarity);});}
    catch{return '🎁 Es läuft bereits ein Drop.';}
  }
  private claim(m:ChatMessage,now:number):string {
    const result=this.claimFromPortal(m,now);
    return result.ok?`🎁 ${result.message}`:result.message;
  }
  private cancelDrop(now:number):boolean {return this.store.miniGameTransaction(db=>{const drop=db.prepare("SELECT id FROM mystery_drops WHERE status IN ('announced','claiming')").get() as {id:string}|undefined;if(!drop)return false;const changed=db.prepare("UPDATE mystery_drops SET status='canceled',resolved_at=? WHERE id=? AND status IN ('announced','claiming')").run(now,drop.id).changes===1;if(changed)this.store.recordCommunityEvent('mystery.drop.canceled',{id:drop.id},now);return changed;});}
  private spin(actor:string,now:number,includeTasks=false):string {
    if(this.store.config('arcade_wheel_paused',false))return '🎡 Das Rad ist pausiert.';
    if(!includeTasks&&!this.settings().wheelAutoPilotEnabled)return '🎡 Der Auto-Pilot ist ausgeschaltet.';
    if(this.store.miniGameQuery(db=>Boolean(db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving') LIMIT 1").get())))return '🎡 Ein Mystery Drop läuft bereits. Das Rad wartet, damit die Runde nicht gestört wird.';
    if(this.hasBlockingCommunityGame())return '🎡 Ein Community-Spiel läuft bereits. Das Rad wartet, damit es nicht dazwischenfunkt.';
    return this.store.miniGameTransaction(db=>{
      const open=db.prepare("SELECT 1 FROM chaos_wheel_spins WHERE status IN ('spinning','active')").get();if(open)return '🎡 Eine Rad-Aktion läuft bereits.';
      if(db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving') LIMIT 1").get())return '🎡 Ein Mystery Drop läuft bereits. Das Rad wartet, damit die Runde nicht gestört wird.';
      const conflict=db.prepare(`SELECT 1 FROM community_chaos_events WHERE status='active'
        UNION ALL SELECT 1 FROM community_interactive_events WHERE status='open' AND kind!='game_night'
        UNION ALL SELECT 1 FROM boss_fights WHERE status='active' UNION ALL SELECT 1 FROM polls WHERE status='active'
        UNION ALL SELECT 1 FROM community_vault_rounds WHERE status='active' UNION ALL SELECT 1 FROM seasonal_events WHERE active=1 LIMIT 1`).get();
      if(conflict)return '🎡 Ein anderes Community-Event läuft bereits. Das Rad wartet.';
      const recent=db.prepare("SELECT created_at FROM chaos_wheel_spins WHERE status IN ('active','completed','canceled') ORDER BY created_at DESC LIMIT 1").get() as {created_at:number}|undefined;
      if(recent&&now-recent.created_at<this.settings().wheelCooldownMs)return '🎡 Das Rad braucht noch eine kurze Pause.';
      const options=db.prepare("SELECT id,title,weight,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges WHERE active=1 AND (action_type!='manual_challenge' OR wheel_key IN ('viewer_xp','viewer_mystery_drop','viewer_honor','community_bonus','quest_luck','chaos_title','extra_spin')) ORDER BY rowid").all() as Array<{id:string;title:string;weight:number;actionType:ChaosWheelActionType;wheelKey:string|null}>;
      const settings=this.settings();
      const dropActive=Boolean(db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving') LIMIT 1").get());
      const usedRewards=this.currentStreamId?(db.prepare("SELECT COUNT(*) n FROM chaos_wheel_spins WHERE stream_id=? AND reward_status IN ('granted','cosmetic')").get(this.currentStreamId) as {n:number}).n:settings.wheelMaxRewardsPerStream;
      const rewardSlotsRemaining=Math.max(0,settings.wheelMaxRewardsPerStream-usedRewards);
      const participants=this.store.recentChatActivity(now,settings.viewerActivityWindowMinutes,[this.broadcasterId]);
      const xpEligible=participants.filter(user=>this.bonusXpRemaining(db,user.userId,now,100)>0);
      const dropEligible=participants.filter(user=>this.bonusXpRemaining(db,user.userId,now,50)>0);
      const questOptions=this.store.approvedQuests(50);
      const available=options.filter(x=>(x.actionType==='boost_pet'&&settings.petEnabled)||(x.actionType==='start_mystery_drop'&&settings.dropsEnabled&&!dropActive)
        ||(settings.viewerRewardsEnabled&&this.currentStreamId&&rewardSlotsRemaining>0&&((x.wheelKey==='viewer_xp'&&xpEligible.length>0)||(x.wheelKey==='viewer_mystery_drop'&&settings.wheelPersonalMysteryDrop&&settings.dropsEnabled&&dropEligible.length>0&&!dropActive)
          ||(['viewer_honor','chaos_title'].includes(x.wheelKey||'')&&participants.length>0)||(x.wheelKey==='community_bonus'&&participants.length>0)
          ||(x.wheelKey==='quest_luck'&&questOptions.length>0)||x.wheelKey==='extra_spin')));
      let pool=available;
      if(includeTasks){
        const modules=this.store.config<Record<string,boolean>>('modules',{}),pollSettings=this.store.config<{enabled?:boolean}>('poll_settings',{}),questSettings=this.store.config<{enabled?:boolean}>('quest_settings',{});
        const approved=this.store.approvedQuests(5),hasPoll=Boolean(db.prepare("SELECT 1 FROM polls WHERE status='active'").get());
        const tasks=db.prepare("SELECT id,title,weight,action_type actionType,wheel_key wheelKey FROM chaos_wheel_challenges WHERE active=1 AND action_type='manual_challenge' ORDER BY CASE wheel_key WHEN 'quest_vote' THEN 0 WHEN 'no_jumping' THEN 1 WHEN 'pistols_timer' THEN 2 ELSE 3 END").all() as typeof options;
        const taskAvailable=tasks.filter(x=>x.wheelKey==='no_jumping'||x.wheelKey==='pistols_timer'||(x.wheelKey==='quest_vote'&&modules.quests!==false&&modules.polls!==false&&pollSettings.enabled!==false&&questSettings.enabled!==false&&!hasPoll&&!this.store.activeQuest()&&approved.length>=2));
        pool=[...available,...taskAvailable];
      }
      const total=pool.reduce((a,x)=>a+x.weight,0);if(pool.length<2||total<=0)return '🎡 Es sind nicht genügend aktuell verfügbare Rad-Felder vorhanden.';
      const wheelFieldsJson=JSON.stringify(pool.map(({id,title,weight,wheelKey})=>({id,title,weight,wheelKey})));
      let point=this.chooseIndex(total);if(!Number.isInteger(point)||point<0||point>=total)throw new Error('Wheel-Auswahl außerhalb des gültigen Bereichs.');
      let selected=pool.find(x=>(point-=x.weight)<0)!;
      let extraSpinUsed=false;
      if(selected.wheelKey==='extra_spin'){
        const secondPool=pool.filter(x=>x.wheelKey!=='extra_spin');
        const secondTotal=secondPool.reduce((sum,x)=>sum+x.weight,0);
        if(secondPool.length<1||secondTotal<1)return '🎡 Für einen sicheren Zusatzdreh ist gerade kein weiteres Feld verfügbar.';
        let secondPoint=this.chooseIndex(secondTotal);if(!Number.isInteger(secondPoint)||secondPoint<0||secondPoint>=secondTotal)throw new Error('Zusatzdreh außerhalb des gültigen Bereichs.');
        selected=secondPool.find(x=>(secondPoint-=x.weight)<0)!;extraSpinUsed=true;
      }
      const id=randomUUID();
      if(VIEWER_WHEEL_KEYS.has(selected.wheelKey||'')){
        const outcome=this.executeViewerOutcome(db,id,selected.wheelKey!,participants,xpEligible,dropEligible,questOptions,settings,now);
        if(!outcome)return '🎡 Das Ergebnis konnte sicher nicht vergeben werden; es wurde keine Belohnung versprochen.';
        const title=extraSpinUsed?`🎡 Noch ein Dreh: ${selected.title}`:selected.title;
        db.prepare("INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at,action_type,ends_at,resolved_at,wheel_key,wheel_fields_json,winner_user_id,winner_name,result_label,reward_status,stream_id) VALUES(?,?,?,'completed',?,?,?,NULL,?,?,?,?,?,?,?,?)")
          .run(id,selected.id,title,actor,now,selected.actionType,now,selected.wheelKey,wheelFieldsJson,outcome.winner?.userId??null,outcome.winner?.displayName??null,outcome.label,outcome.rewardStatus,this.currentStreamId);
        return extraSpinUsed?`🎡 Noch ein Dreh! ${outcome.message}`:outcome.message;
      }
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
          endsAt=now+300_000;status='active';message='🎡 Janniks Aufgabe: Fünf Minuten nur Pistolen! Der Countdown läuft; der Bot prüft nicht, welche Waffen im Spiel verwendet werden.';
        }else{status='active';message='🎡 Janniks Aufgabe: Eine Runde ohne Springen! OBS zeigt die Aufgabe bis zum Beenden mit !cancelwheel. Der Bot kann die Einhaltung nicht prüfen.';}
        db.prepare("INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at,action_type,ends_at,resolved_at,wheel_key,task_ref,wheel_fields_json) VALUES(?,?,?, ?,?,?,?, ?,?, ?,?,?)")
          .run(id,selected.id,selected.title,status,actor,now,selected.actionType,endsAt,status==='completed'?now:null,selected.wheelKey,taskRef,wheelFieldsJson);
        this.store.recordCommunityEvent('chaos-wheel.action',{id,title:selected.title,actionType:selected.wheelKey||selected.actionType,endsAt},now);
        return message;
      }
      db.prepare("INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at,action_type,ends_at,resolved_at,wheel_key,wheel_fields_json) VALUES(?,?,?,'completed',?,?,?,NULL,?,?,?)").run(id,selected.id,selected.title,actor,now,selected.actionType,now,selected.wheelKey,wheelFieldsJson);
      if(selected.actionType==='boost_pet'){
        db.prepare("UPDATE community_pet SET energy=MIN(100,energy+10),happiness=MIN(100,happiness+5),animation='happy',updated_at=? WHERE id=1").run(now);
        this.store.recordCommunityEvent('chaos-wheel.action',{id,title:selected.title,actionType:selected.actionType},now);
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
    this.store.recordCommunityEvent('mystery.drop.started',{id,rarity,endsAt:ends,durationMs:duration},now);
    return `🎁 Ein Mystery Drop startet! Schreibt innerhalb von ${Math.ceil(duration/1000)} Sekunden !claim, um mitzumachen!`;
  }
  private bonusXpRemaining(db:BetterSqlite3.Database,userId:string,now:number,dailyCap:number):number{
    const start=new Date(now);start.setUTCHours(0,0,0,0);
    const earned=(db.prepare("SELECT COALESCE(SUM(amount),0) total FROM xp_ledger WHERE user_id=? AND reason LIKE 'bonus:%' AND created_at>=?").get(userId,start.getTime()) as {total:number}).total;
    return Math.max(0,dailyCap-earned);
  }
  private executeViewerOutcome(db:BetterSqlite3.Database,spinId:string,key:string,participants:Array<{userId:string;displayName:string;login:string;lastActivityAt:number}>,xpEligible:Array<{userId:string;displayName:string;login:string;lastActivityAt:number}>,dropEligible:Array<{userId:string;displayName:string;login:string;lastActivityAt:number}>,quests:Array<{id:string;title:string}>,settings:ArcadeSettings,now:number):{message:string;label:string;rewardStatus:string;winner?:{userId:string;displayName:string}}|undefined{
    const pick=(list:typeof participants)=>list.length?list[Math.min(list.length-1,Math.max(0,this.chooseIndex(list.length)))]:undefined;
    if(key==='quest_luck'){
      if(!quests.length)return undefined;const quest=quests[Math.min(quests.length-1,Math.max(0,this.chooseIndex(quests.length)))];if(!quest)return undefined;
      return {label:quest.title,rewardStatus:'none',message:`🎯 Glückstreffer! Die freigegebene Challenge „${clean(quest.title,120)}“ wird für Jannik hervorgehoben. Sie startet nicht automatisch.`};
    }
    if(key==='community_bonus'){
      let paid=0;for(const user of participants){const amount=this.store.awardXp(`wheel:${spinId}:community:${user.userId}`,user.userId,clean(user.displayName,48),settings.wheelCommunityBonusXp,'bonus:chaos-wheel',now,100);if(amount>0)paid++;}
      if(!paid)return undefined;
      return {label:`${paid} aktive Zuschauer · ${settings.wheelCommunityBonusXp} XP`,rewardStatus:'granted',message:`✨ Community-Glück! ${paid} berechtigte aktive ${paid===1?'Person erhält':'Personen erhalten'} je ${settings.wheelCommunityBonusXp} XP! 💜`};
    }
    const list=key==='viewer_xp'?xpEligible:key==='viewer_mystery_drop'?dropEligible:participants,user=pick(list);if(!user)return undefined;
    const name=clean(user.displayName,48),winner={userId:user.userId,displayName:name};
    if(key==='viewer_xp'){
      const amount=this.store.awardXp(`wheel:${spinId}:winner-xp`,user.userId,name,settings.wheelWinnerXp,'bonus:chaos-wheel',now,100);if(!amount)return undefined;
      return {winner,label:`@${name} · ${amount} XP`,rewardStatus:'granted',message:`🎡 GLÜCKSPILZ! @${name} gewinnt ${amount} XP! 🎉`};
    }
    if(key==='viewer_mystery_drop'){
      const dropId=randomUUID(),amount=LIMITS.common!,dropEnds=now+settings.dropDurationMs;
      db.prepare("INSERT INTO mystery_drops(id,rarity,status,starts_at,ends_at,result_json,created_by,created_at,resolved_at,source_spin_id) VALUES(?,'common','completed',?,?,?,?,?,?,?)")
        .run(dropId,now,dropEnds,JSON.stringify({participants:1,rewardXp:amount}),`wheel:${spinId}`,now,now,spinId);
      db.prepare('INSERT INTO mystery_claims(drop_id,user_id,display_name,claimed_at,reward_xp) VALUES(?,?,?,?,?)').run(dropId,user.userId,name,now,amount);
      const paid=this.store.awardXp(`drop:${dropId}:${user.userId}`,user.userId,name,amount,'bonus:mystery-drop',now,50);if(!paid)return undefined;
      return {winner,label:`@${name} · Mystery Drop (${paid} XP)`,rewardStatus:'granted',message:`🎁 @${name} wurde vom Glücksrad ausgewählt und erhält einen persönlichen Mystery Drop mit ${paid} XP! 💜`};
    }
    if(key==='viewer_honor')return {winner,label:`@${name} · Ehrenmoment`,rewardStatus:'cosmetic',message:`👑 @${name} ist heute offiziell der Lieblingsmensch des Glücksrads! 💜`};
    if(key==='chaos_title')return {winner,label:`@${name} · Chaos-Magnet (60 Sekunden)`,rewardStatus:'cosmetic',message:`😈 @${name} ist für 60 Sekunden der offizielle Chaos-Magnet des Streams!`};
    if(key==='extra_spin')return {label:'Zusatzdreh',rewardStatus:'none',message:'🎡 Noch ein Dreh!'};
    return undefined;
  }
  private petState(db:BetterSqlite3.Database,now:number):PetState{
    const row=db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow;
    const latest=db.prepare('SELECT kind,rare,created_at AS createdAt FROM community_pet_events ORDER BY created_at DESC LIMIT 1').get() as {kind:string;rare:number;createdAt:number}|undefined;
    return this.toPet(row,now,this.settings().petPersonalityEnabled?latest:undefined);
  }
  private applyPetNeeds(db:BetterSqlite3.Database,now:number):void{
    const row=db.prepare('SELECT hunger,happiness,energy,paused,updated_at,state_updated_at,sleep_until FROM community_pet WHERE id=1').get() as {hunger:number;happiness:number;energy:number;paused:number;updated_at:number;state_updated_at:number;sleep_until:number};
    const baseline=row.state_updated_at||row.updated_at,period=6*60*60_000;
    if(row.paused===1||now<=baseline)return;
    const periods=Math.floor((now-baseline)/period);if(periods<1){if(row.sleep_until>0&&row.sleep_until<=now)db.prepare('UPDATE community_pet SET sleep_until=0,animation=CASE WHEN animation=\'sleep\' THEN \'idle\' ELSE animation END WHERE id=1').run();return;}
    const slept=Math.max(0,Math.min(periods,Math.floor((Math.min(now,row.sleep_until||0)-baseline)/period)));
    const awake=periods-slept;
    const hunger=Math.max(0,row.hunger-periods);
    const energy=Math.max(0,Math.min(100,row.energy-awake+slept*10));
    const happiness=Math.max(0,Math.min(100,row.happiness-Math.floor(periods/2)+slept));
    const stateAt=baseline+periods*period;
    db.prepare("UPDATE community_pet SET hunger=?,happiness=?,energy=?,state_updated_at=?,sleep_until=CASE WHEN sleep_until<=? THEN 0 ELSE sleep_until END,animation=CASE WHEN sleep_until>? THEN 'sleep' WHEN animation='sleep' THEN 'idle' ELSE animation END,updated_at=? WHERE id=1")
      .run(hunger,happiness,energy,stateAt,now,now,now);
  }
  private toPet(r:PetRow,now=Date.now(),latest?:{kind:string;rare:number;createdAt:number}):PetState {
    const mood:PetState['mood']=latest?.rare===1&&now-latest.createdAt<15*60_000?'cheeky':r.hunger<30?'hungry':r.energy<25?'tired':r.happiness>=75&&r.energy>=40?'playful':r.happiness>=55?'happy':'calm';
    const unlockedOutfits=PET_OUTFITS.map(item=>({...item,unlocked:r.level>=item.unlockLevel}));
    const selected=this.store.config<string>('community_pet_outfit','classic');
    const outfit=unlockedOutfits.find(item=>item.id===selected&&item.unlocked)||unlockedOutfits.find(item=>item.id==='classic')!;
    return {name:r.name,level:r.level,xp:r.xp,hunger:r.hunger,happiness:r.happiness,energy:r.energy,stage:r.stage,paused:r.paused===1,animation:r.animation,updatedAt:r.updated_at,sleeping:r.sleep_until>now,sleepUntil:r.sleep_until,mood,moodLabel:PET_MOODS[mood],outfit:{id:outfit.id,label:outfit.label,emoji:outfit.emoji},unlockedOutfits};
  }
  private petActivities(db:BetterSqlite3.Database,now:number):Array<{id:string;kind:string;message:string;rare:boolean;createdAt:number}>{
    return db.prepare('SELECT id,kind,message,rare,created_at AS createdAt FROM community_pet_events WHERE created_at>=? ORDER BY created_at DESC LIMIT 12').all(now-PET_EVENT_RETENTION).map(row=>{const event=row as {id:string;kind:string;message:string;rare:number;createdAt:number};return {...event,rare:event.rare===1};});
  }
  private personalityReaction(kind:'feed'|'play'|'care',db:BetterSqlite3.Database,now:number):string{
    const reaction=this.settings().petPersonalityEnabled?this.pick(PET_REACTIONS[kind]):kind==='feed'?'Elio schnurrt zufrieden.':kind==='play'?'Elio freut sich über die Spielrunde.':'Elio genießt die Aufmerksamkeit.';
    if(this.settings().petPersonalityEnabled)this.recordPetEvent(db,kind,reaction,now,false);
    return reaction;
  }
  private recordPetEvent(db:BetterSqlite3.Database,kind:string,message:string,now:number,rare=false):void{
    db.prepare('INSERT INTO community_pet_events(id,kind,message,rare,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),kind,message,rare?1:0,now);
    db.prepare('DELETE FROM community_pet_events WHERE created_at<? OR id NOT IN (SELECT id FROM community_pet_events ORDER BY created_at DESC LIMIT 100)').run(now-PET_EVENT_RETENTION);
  }
  private advancePetPersonalityEvent(now:number):void{
    const settings=this.settings();if(!settings.petEnabled||!settings.petPersonalityEnabled)return;
    this.store.miniGameTransaction(db=>{
      const pet=db.prepare('SELECT paused FROM community_pet WHERE id=1').get() as {paused:number};if(pet.paused)return;
      let nextAt=this.store.config<number>('pet_personality_next_event_at',0);
      if(!nextAt){nextAt=now+this.petEventInterval();this.store.setConfig('pet_personality_next_event_at',nextAt);return;}
      if(now<nextAt)return;
      const rare=this.choose(20)===0;
      const event=rare?{kind:'rare',message:this.pick(PET_RARE_EVENTS)}:this.pick(PET_COMMON_EVENTS);
      this.recordPetEvent(db,event.kind,event.message,now,rare);
      if(rare)this.store.recordCommunityEvent('elio.rare',{id:randomUUID(),message:event.message},now);
      db.prepare("UPDATE community_pet SET animation='surprise' WHERE id=1").run();
      this.store.setConfig('pet_personality_next_event_at',now+this.petEventInterval());
    });
  }
  private petEventInterval():number{return PET_EVENT_INTERVAL_MIN+this.choose(4)*PET_EVENT_INTERVAL_SPAN/3;}
  private pick<T>(values:readonly T[]):T{return values[this.choose(values.length)]!;}
  private choose(max:number):number{const value=this.chooseIndex(max);if(!Number.isInteger(value)||value<0||value>=max)throw new Error('Zufallsauswahl außerhalb des gültigen Bereichs.');return value;}
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
  if(key==='no_jumping')return 'Janniks Fortnite-Aufgabe: eine Runde ohne Springen. Nicht automatisch prüfbar.';
  if(key==='pistols_timer')return 'Janniks Fortnite-Aufgabe: fünf Minuten nur Pistolen; Countdown läuft automatisch.';
  if(key==='gaming_quiz')return 'Deaktiviert; bleibt nur zur Wahrung der bisherigen Rad-Historie gespeichert.';
  if(key==='boost_pet')return 'Elio erhält sofort Energie und Zufriedenheit.';
  if(key==='start_mystery_drop')return 'Mystery Drop startet; !claim und XP-Auswertung laufen automatisch.';
  return title;
}
function stageFor(level:number):PetState['stage'] { return level>=25?'legendary':level>=15?'adult':level>=8?'young':level>=3?'baby':'egg'; }
function stageLabel(s:PetState['stage']):string { return ({egg:'Kätzchen',baby:'Jungkatze',young:'Erwachsene Katze',adult:'Erfahrene Katze',legendary:'Legendäre Community-Katze'})[s]; }
function nextStage(s:PetState['stage']):string { return ({egg:'Level 3 · Jungkatze',baby:'Level 8 · Erwachsene Katze',young:'Level 15 · Erfahrene Katze',adult:'Level 25 · Legendäre Community-Katze',legendary:'Höchste Lebensphase erreicht'})[s]; }
