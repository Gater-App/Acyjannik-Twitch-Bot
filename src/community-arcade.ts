import { randomInt, randomUUID } from 'node:crypto';
import type { ChatMessage } from './types.js';
import { FeatureStore } from './feature-store.js';

export interface ArcadeSettings {
  petEnabled: boolean; dropsEnabled: boolean; wheelEnabled: boolean; autoDrops: boolean;
  petCooldownMs: number; dropDurationMs: number; wheelCooldownMs: number; allowChatSpin: boolean;
}
export interface PetState {
  name: string; level: number; xp: number; hunger: number; happiness: number; energy: number;
  stage: 'egg'|'baby'|'young'|'adult'|'legendary'; paused: boolean; animation: string; updatedAt: number;
}
interface PetRow {name:string;level:number;xp:number;hunger:number;happiness:number;energy:number;stage:PetState['stage'];paused:number;animation:string;updated_at:number}
const DEFAULT_SETTINGS: ArcadeSettings = { petEnabled:false,dropsEnabled:false,wheelEnabled:false,autoDrops:false,petCooldownMs:120_000,dropDurationMs:60_000,wheelCooldownMs:300_000,allowChatSpin:false };
const DEFAULT_CHALLENGES = ['Eine Runde ohne Springen','Fünf Minuten nur Pistolen','Chat wählt die nächste Quest','Zeit für ein Gaming-Quiz','Der Drache bekommt einen Energieschub!','Mystery Drop für den Chat'];
const LIMITS: Record<string,number> = { common:5,rare:10,epic:20,legendary:35,community:10 };
const clean = (s:string,n=80) => Array.from(s.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim()).slice(0,n).join('');

/** Three small community features sharing the existing SQLite connection and XP ledger. */
export class CommunityArcade {
  private lastWheelAt = 0;
  constructor(private readonly store:FeatureStore, private readonly broadcasterId:string) {
    this.store.miniGameTransaction(db=>{
      const n=(db.prepare('SELECT COUNT(*) n FROM chaos_wheel_challenges').get() as {n:number}).n;
      if(!n)for(const title of DEFAULT_CHALLENGES)db.prepare('INSERT INTO chaos_wheel_challenges(id,title,weight,active) VALUES(?,?,1,1)').run(randomUUID(),title);
    });
  }
  settings():ArcadeSettings { return {...DEFAULT_SETTINGS,...this.store.config<Partial<ArcadeSettings>>('arcade_settings',{})}; }
  updateSettings(next:ArcadeSettings):void {
    for(const k of ['petEnabled','dropsEnabled','wheelEnabled','autoDrops','allowChatSpin'] as const)if(typeof next[k]!=='boolean')throw new Error(`Ungültige Arcade-Einstellung: ${k}`);
    for(const k of ['petCooldownMs','dropDurationMs','wheelCooldownMs'] as const)if(!Number.isInteger(next[k])||next[k]<1000||next[k]>86_400_000)throw new Error(`Ungültige Arcade-Einstellung: ${k}`);
    this.store.setConfig('arcade_settings',next);
  }
  pet():PetState { return this.store.miniGameQuery(db=>this.toPet(db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow)); }
  snapshot(type:'pet'|'drop'|'wheel',now=Date.now()):Record<string,unknown> {
    return this.store.miniGameQuery(db=>{
      if(type==='pet'){
        const p=this.toPet(db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow);
        return {type,visible:this.settings().petEnabled,pet:p,capturedAt:now};
      }
      if(type==='drop'){
        const d=db.prepare("SELECT * FROM mystery_drops WHERE status IN ('announced','claiming','resolving','completed') ORDER BY created_at DESC LIMIT 1").get() as {id:string;rarity:string;status:string;starts_at:number;ends_at:number;result_json:string|null;resolved_at:number|null}|undefined;
        if(!d||(['completed'].includes(d.status)&&now-(d.resolved_at||0)>12000))return {type,visible:false,capturedAt:now};
        const participants=(db.prepare('SELECT COUNT(*) n FROM mystery_claims WHERE drop_id=?').get(d.id) as {n:number}).n;
        return {type,visible:this.settings().dropsEnabled,drop:{rarity:d.rarity,status:d.status,endsAt:d.ends_at,participants,result:d.result_json?JSON.parse(d.result_json):null},capturedAt:now};
      }
      const w=db.prepare('SELECT * FROM chaos_wheel_spins ORDER BY created_at DESC LIMIT 1').get() as {id:string;title:string;status:string;created_at:number}|undefined;
      return {type,visible:this.settings().wheelEnabled&&!!w&&now-w.created_at<15_000,wheel:w?{id:w.id,title:w.title,status:w.status,createdAt:w.created_at}:null,capturedAt:now};
    });
  }
  handle(m:ChatMessage,command:string,args:string[],now=Date.now()):string|undefined {
    const s=this.settings(), admin=m.senderUserId===this.broadcasterId, mod=admin||m.isModerator===true;
    if(['pet','feed','play','petcare','petstats','petname','pethelp','petevolution','setpetname','petpause','petresume'].includes(command)){
      if(!s.petEnabled&&command!=='pethelp')return '🐉 Das Community-Pet ist derzeit pausiert.';
      if(command==='pethelp')return '🐉 !pet · !feed · !play · !petcare · !petstats · !petevolution. Pflege-Cooldown: 2 Min.';
      if(command==='pet'||command==='petstats'||command==='petname'||command==='petevolution'){
        const p=this.pet(); if(command==='petname')return `🐉 Unser Drache heißt ${p.name}.`;
        if(command==='petevolution')return `🐉 ${p.name}: ${stageLabel(p.stage)} · Level ${p.level}. Nächste Stufe: ${nextStage(p.stage)}.`;
        return `🐉 ${p.name} · ${stageLabel(p.stage)} · Level ${p.level} · Sättigung ${p.hunger}% · Freude ${p.happiness}% · Energie ${p.energy}%.`;
      }
      if(command==='setpetname'){
        if(!admin)return '⛔ Nur Jannik darf den Pet-Namen ändern.';
        const name=clean(args.join(' '),24);if(name.length<2)return '🐉 Bitte einen Namen mit 2–24 Zeichen angeben.';
        this.store.miniGameTransaction(db=>db.prepare("UPDATE community_pet SET name=?,animation='happy',updated_at=? WHERE id=1").run(name,now));return `🐉 Unser Drache heißt jetzt ${name}!`;
      }
      if(command==='petpause'||command==='petresume'){
        if(!admin)return '⛔ Nur Jannik darf Pflege pausieren oder fortsetzen.';
        this.store.miniGameTransaction(db=>db.prepare("UPDATE community_pet SET paused=?,animation='idle',updated_at=? WHERE id=1").run(command==='petpause'?1:0,now));return command==='petpause'?'🐉 Pet-Interaktionen pausiert.':'🐉 Pet-Interaktionen fortgesetzt.';
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
        if(!d)return '🎁 Gerade ist keine Kiste offen.';return `🎁 ${d.rarity} Mystery Drop · ${Math.max(0,Math.ceil((d.ends_at-now)/1000))}s · !claim`;
      }
      if(command==='claim')return this.claim(m,now);
      if(!mod)return '⛔ Nur Jannik oder Mods dürfen Drops verwalten.';
      if(command==='startdrop')return this.startDrop(m.senderUserId,now,args[0]);
      if(command==='canceldrop')return this.cancelDrop(now)?'🎁 Der Drop wurde abgebrochen.':'🎁 Kein offener Drop.';
      return '🎁 Drop-Konfiguration erfolgt im Dashboard.';
    }
    if(['wheel','spin','wheelstatus','startwheel','cancelwheel','wheelpause','wheelresume'].includes(command)){
      if(!s.wheelEnabled&&command!=='wheel')return '🎡 Das Chaos Wheel ist derzeit deaktiviert.';
      if(command==='wheel'||command==='wheelstatus')return `🎡 Chaos Wheel ${this.activeChallenges().length} aktive Challenges · Cooldown ${Math.ceil(s.wheelCooldownMs/60000)} Min.`;
      if(command==='wheelpause'||command==='wheelresume'){
        if(!admin)return '⛔ Nur Jannik darf das Rad pausieren.';
        this.store.setConfig('arcade_wheel_paused',command==='wheelpause');return command==='wheelpause'?'🎡 Das Rad ist pausiert.':'🎡 Das Rad ist wieder freigegeben.';
      }
      if(command==='cancelwheel'){
        if(!mod)return '⛔ Nur Jannik oder Mods dürfen den Dreh abbrechen.';
        this.store.miniGameTransaction(db=>db.prepare("UPDATE chaos_wheel_spins SET status='canceled',resolved_at=? WHERE status='spinning'").run(now));return '🎡 Der Dreh wurde abgebrochen.';
      }
      if(!mod&&!(command==='spin'&&s.allowChatSpin))return '⛔ Der Dreh muss von Jannik oder einem Mod gestartet werden.';
      return this.spin(m.senderUserId,now);
    }
    return undefined;
  }
  tick(now=Date.now()):string[] {
    const out:string[]=[];
    const due=this.store.miniGameTransaction(db=>{
      const d=db.prepare("SELECT id,rarity FROM mystery_drops WHERE status IN ('announced','claiming') AND ends_at<=?").get(now) as {id:string;rarity:string}|undefined;
      if(!d)return undefined;
      db.prepare("UPDATE mystery_drops SET status='resolving' WHERE id=? AND status IN ('announced','claiming')").run(d.id);
      const claims=db.prepare('SELECT user_id,display_name FROM mystery_claims WHERE drop_id=? ORDER BY claimed_at').all(d.id) as Array<{user_id:string;display_name:string}>;
      const amount=LIMITS[d.rarity]||5;
      const result={participants:claims.length,rewardXp:amount};db.prepare("UPDATE mystery_drops SET status='completed',result_json=?,resolved_at=? WHERE id=? AND status='resolving'").run(JSON.stringify(result),now,d.id);
      db.prepare("UPDATE community_pet SET animation='drop',happiness=MIN(100,happiness+?),xp=xp+?,updated_at=? WHERE id=1").run(claims.length?3:0,claims.length?2:0,now);
      return {claims:claims,rarity:d.rarity,id:d.id,amount};
    });
    if(due){for(const c of due.claims)this.store.awardXp(`drop:${due.id}:${c.user_id}`,c.user_id,c.display_name,due.amount,'bonus:mystery-drop',now,50);out.push(`🎁 ${due.rarity} Drop geöffnet! ${due.claims.length} Teilnehmende erhalten je ${due.amount} XP${due.claims.length?' und der Drache freut sich!':'.'}`);}
    this.store.miniGameTransaction(db=>{
      db.prepare("UPDATE community_pet SET hunger=MAX(20,hunger-MIN(5,MAX(0,CAST((?-updated_at)/86400000 AS INTEGER)))),energy=MIN(100,energy+MIN(5,MAX(0,CAST((?-updated_at)/86400000 AS INTEGER)))),updated_at=updated_at+MAX(0,CAST((?-updated_at)/86400000 AS INTEGER))*86400000 WHERE id=1 AND ?-updated_at>=86400000").run(now,now,now,now);
      db.prepare("UPDATE community_pet SET animation=CASE WHEN paused=1 THEN 'sleep' WHEN animation IN ('feed','play','care','happy','drop','levelup','evolution') AND updated_at<? THEN 'idle' ELSE animation END WHERE id=1").run(now-12000);
    });
    return out;
  }
  configureChallenge(title:string,weight:number,active:boolean,id?:string):string {
    const cleanTitle=clean(title,80);if(!cleanTitle||!Number.isInteger(weight)||weight<1||weight>1000)throw new Error('Challenge oder Gewichtung ungültig.');
    const key=id||randomUUID();this.store.miniGameTransaction(db=>db.prepare('INSERT INTO chaos_wheel_challenges(id,title,weight,active) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,weight=excluded.weight,active=excluded.active').run(key,cleanTitle,weight,active?1:0));return key;
  }
  activeChallenges():Array<{id:string;title:string;weight:number}> { return this.store.miniGameQuery(db=>db.prepare('SELECT id,title,weight FROM chaos_wheel_challenges WHERE active=1 ORDER BY title').all() as Array<{id:string;title:string;weight:number}>); }
  manageChallenges():Array<{id:string;title:string;weight:number;active:boolean}> { return this.store.miniGameQuery(db=>(db.prepare('SELECT id,title,weight,active FROM chaos_wheel_challenges ORDER BY title').all() as Array<{id:string;title:string;weight:number;active:number}>).map(x=>({...x,active:x.active===1}))); }
  startDropAdmin(actor:string,rarity:string|undefined,now=Date.now()):string { if(!this.settings().dropsEnabled)return '🎁 Mystery Drops sind deaktiviert.';return this.startDrop(actor,now,rarity); }
  spinAdmin(actor:string,now=Date.now()):string { if(!this.settings().wheelEnabled)return '🎡 Das Chaos Wheel ist deaktiviert.';return this.spin(actor,now); }
  private interact(m:ChatMessage,kind:'feed'|'play'|'care',s:ArcadeSettings,now:number):string {
    return this.store.miniGameTransaction(db=>{
      const p=db.prepare('SELECT * FROM community_pet WHERE id=1').get() as PetRow;
      if(p.paused)return '🐉 Das Pet macht gerade Pause.';
      if(db.prepare('SELECT 1 FROM community_pet_interactions WHERE event_id=?').get(m.eventId))return '🐉 Diese Interaktion wurde bereits verarbeitet.';
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
      return kind==='feed'?`🐉 @${clean(m.senderDisplayName,32)} füttert ${p.name}! Sättigung ${hunger}%, Freude ${happiness}%.`:kind==='play'?`✨ @${clean(m.senderDisplayName,32)} spielt mit ${p.name}! +5 Pet-XP (Level ${level}).`:`💚 @${clean(m.senderDisplayName,32)} pflegt ${p.name}. Freude ${happiness}%.`;
    });
  }
  private startDrop(actor:string,now:number,rarityArg?:string):string {
    const rarity=(rarityArg||'common').toLowerCase();if(!(rarity in LIMITS))return '🎁 Seltenheit: common, rare, epic, legendary oder community.';
    const id=randomUUID(),ends=now+this.settings().dropDurationMs;
    try{this.store.miniGameTransaction(db=>db.prepare("INSERT INTO mystery_drops(id,rarity,status,starts_at,ends_at,created_by,created_at) VALUES(?,?,'claiming',?,?,?,?)").run(id,rarity,now,ends,actor,now));}
    catch{return '🎁 Es läuft bereits ein Drop.';}
    return `🎁 MYSTERY DROP (${rarity})! Ihr habt ${Math.ceil(this.settings().dropDurationMs/1000)} Sekunden Zeit. Schreibt !claim!`;
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
  private spin(actor:string,now:number):string {
    if(this.store.config('arcade_wheel_paused',false))return '🎡 Das Rad ist pausiert.';
    return this.store.miniGameTransaction(db=>{
      const open=db.prepare("SELECT 1 FROM chaos_wheel_spins WHERE status='spinning'").get();if(open)return '🎡 Ein Dreh läuft bereits.';
      const recent=db.prepare("SELECT created_at FROM chaos_wheel_spins WHERE status='completed' ORDER BY created_at DESC LIMIT 1").get() as {created_at:number}|undefined;
      if(recent&&now-recent.created_at<this.settings().wheelCooldownMs)return '🎡 Das Rad braucht noch eine kurze Pause.';
      const options=db.prepare('SELECT id,title,weight FROM chaos_wheel_challenges WHERE active=1').all() as Array<{id:string;title:string;weight:number}>;
      const total=options.reduce((a,x)=>a+x.weight,0);if(options.length<2||total<=0)return '🎡 Es müssen mindestens zwei aktive Challenges vorhanden sein.';
      let point=randomInt(total);const selected=options.find(x=>(point-=x.weight)<0)!;
      const id=randomUUID();db.prepare("INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at) VALUES(?,?,?,'spinning',?,?)").run(id,selected.id,selected.title,actor,now);
      db.prepare("UPDATE chaos_wheel_spins SET status='completed',resolved_at=? WHERE id=?").run(now,id);
      if(selected.title.toLowerCase().includes('drache'))db.prepare("UPDATE community_pet SET energy=MIN(100,energy+10),happiness=MIN(100,happiness+5),animation='happy',updated_at=? WHERE id=1").run(now);
      return `🎡 Das Chaos Wheel landet auf: ${selected.title}! Jannik entscheidet, ob die Challenge gespielt wird.`;
    });
  }
  private toPet(r:PetRow):PetState { return {name:r.name,level:r.level,xp:r.xp,hunger:r.hunger,happiness:r.happiness,energy:r.energy,stage:r.stage,paused:r.paused===1,animation:r.animation,updatedAt:r.updated_at}; }
}
function stageFor(level:number):PetState['stage'] { return level>=25?'legendary':level>=15?'adult':level>=8?'young':level>=3?'baby':'egg'; }
function stageLabel(s:PetState['stage']):string { return ({egg:'Drachenei',baby:'Baby-Drache',young:'Jungdrache',adult:'Erwachsener Drache',legendary:'Legendärer Drache'})[s]; }
function nextStage(s:PetState['stage']):string { return ({egg:'Level 3 · Baby-Drache',baby:'Level 8 · Jungdrache',young:'Level 15 · Erwachsener Drache',adult:'Level 25 · Legendärer Drache',legendary:'Maximale Entwicklungsstufe erreicht'})[s]; }
