import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { ChatMessage } from './types.js';
import type { FeatureStore } from './feature-store.js';

export type PrankKind = 'chief' | 'accusation' | 'vault-alarm' | 'oracle';
export interface ModeratorPrankSettings { enabled: Record<PrankKind, boolean>; announce: Record<PrankKind, boolean>; }
interface ActivePrank { id: string; kind: PrankKind; startedAt: number; endsAt: number; targetId?: string; targetName?: string; }
interface PersistedPranks { settings: ModeratorPrankSettings; active?: ActivePrank; cooldowns: Partial<Record<PrankKind, number>>; optOutHashes: string[]; targetCooldowns?: Record<string,number>; oracleUserCooldowns?:Record<string,number>; oracleRecent?:number[]; }
const KINDS: PrankKind[] = ['chief','accusation','vault-alarm','oracle'];
const DEFAULTS: ModeratorPrankSettings = { enabled: { chief:false, accusation:false, 'vault-alarm':false, oracle:false }, announce: { chief:false, accusation:false, 'vault-alarm':false, oracle:false } };
const ORACLE_ANSWERS = ['Die Sterne empfehlen einen Snack und eine entspannte Runde.','Das Orakel sieht: Gleich passiert etwas völlig Normales.','Meine Kristallkugel ist beschlagen. Frag später noch einmal.','Die Antwort lautet vielleicht – aber mit sehr viel Konfetti.','Heute stehen die Chancen gut für gute Laune.'];
const PREFIX='【🔮 ORAKEL】';

export class ModeratorPranks {
  constructor(private readonly store: FeatureStore, private readonly vaultActive:()=>boolean, private readonly gamesBusy:()=>boolean) {}

  private data(now=Date.now()): PersistedPranks {
    const raw=this.store.config<Partial<PersistedPranks>>('moderator_pranks',{});
    return { settings:{ enabled:{...DEFAULTS.enabled,...raw.settings?.enabled},announce:{...DEFAULTS.announce,...raw.settings?.announce} },
      ...(raw.active&&raw.active.endsAt>now?{active:raw.active}:{}), cooldowns:raw.cooldowns||{}, optOutHashes:raw.optOutHashes||[],targetCooldowns:Object.fromEntries(Object.entries(raw.targetCooldowns||{}).filter(([,at])=>at>now-24*60*60_000)),
      oracleUserCooldowns:Object.fromEntries(Object.entries(raw.oracleUserCooldowns||{}).filter(([,at])=>at>now-30_000)),oracleRecent:(raw.oracleRecent||[]).filter(at=>at>now-60_000) };
  }
  private save(value:PersistedPranks):void { this.store.setConfig('moderator_pranks',value); }
  isOptedOut(userId:string):boolean { const hash=createHash('sha256').update(userId).digest('hex');return this.data().optOutHashes.includes(hash); }
  settings():ModeratorPrankSettings { return this.data().settings; }
  snapshot(now=Date.now()):Record<string,unknown> {
    const d=this.data(now); return {settings:d.settings,active:d.active?{kind:d.active.kind,startedAt:d.active.startedAt,endsAt:d.active.endsAt,remainingMs:Math.max(0,d.active.endsAt-now),...(d.active.targetName?{targetName:d.active.targetName}:{})}:null,
      cooldowns:Object.fromEntries(KINDS.map(k=>[k,Math.max(0,(d.cooldowns[k]||0)-now)])),vaultActive:this.vaultActive()};
  }
  configure(input:unknown):ModeratorPrankSettings {
    if(!input||typeof input!=='object')throw new Error('Prank-Einstellungen ungültig.');
    const top=input as Record<string,unknown>;if(Object.keys(top).some(key=>!['enabled','announce'].includes(key)))throw new Error('Prank-Einstellungen enthalten unbekannte Felder.');
    for(const field of ['enabled','announce'] as const){const section=top[field];if(section!==undefined&&(!section||typeof section!=='object'||Array.isArray(section)))throw new Error('Prank-Einstellungen ungültig.');
      if(section&&Object.keys(section).some(key=>!KINDS.includes(key as PrankKind)))throw new Error('Prank-Einstellungen enthalten einen unbekannten Prank.');}
    const row=input as Partial<ModeratorPrankSettings>,current=this.settings();
    for(const kind of KINDS) {
      const enabled=row.enabled?.[kind],announce=row.announce?.[kind];
      if(enabled!==undefined&&typeof enabled!=='boolean')throw new Error('Aktivierung muss Ein oder Aus sein.');
      if(announce!==undefined&&typeof announce!=='boolean')throw new Error('Ankündigung muss Ein oder Aus sein.');
    }
    const settings={enabled:{...current.enabled,...row.enabled},announce:{...current.announce,...row.announce}};
    const d=this.data();d.settings=settings;this.save(d);return settings;
  }
  start(kind:PrankKind,actorId:string,now=Date.now(),target?:{id:string;name:string}):{ok:boolean;message:string;announcement?:string} {
    const d=this.data(now);if(!d.settings.enabled[kind])return {ok:false,message:'Dieser Prank ist ausgeschaltet.'};
    if(d.active)return {ok:false,message:'Es läuft bereits ein Prank. Beende ihn zuerst.'};
    if((d.cooldowns[kind]||0)>now)return {ok:false,message:`Bitte noch ${Math.ceil(((d.cooldowns[kind]||0)-now)/60_000)} Min. warten.`};
    if(kind==='vault-alarm'&&!this.vaultActive())return {ok:false,message:'Der Fehlalarm geht nur während einer laufenden Tresorrunde.'};
    if(this.gamesBusy())return {ok:false,message:'Gerade läuft ein Community-Spiel. Warte bitte bis zum Ende.'};
    if(kind==='accusation'&&(!target||!/^\d{1,30}$/u.test(target.id)||!target.name.trim()))return {ok:false,message:'Wähle zuerst ein gültiges Twitch-Konto aus.'};
    if(kind==='accusation'&&target&&this.isOptedOut(target.id))return {ok:false,message:'Diese Person möchte bei Elio-Verdächtigungen nicht mitmachen.'};
    if(kind==='accusation'&&target){const hash=createHash('sha256').update(target.id).digest('hex');if((d.targetCooldowns?.[hash]||0)>now)return {ok:false,message:'Diese Person wurde in den letzten 24 Stunden schon einmal scherzhaft verdächtigt.'};}
    const duration=kind==='chief'?60_000:kind==='accusation'?45_000:kind==='vault-alarm'?10_000:120_000;
    const cooldown=kind==='chief'?15*60_000:kind==='accusation'?30*60_000:kind==='vault-alarm'?5*60_000:20*60_000;
    d.active={id:randomUUID(),kind,startedAt:now,endsAt:now+duration,...(target?{targetId:target.id,targetName:clean(target.name,32)}:{})};
    if(kind==='oracle'){d.oracleRecent=[];d.oracleUserCooldowns={};}
    if(kind==='accusation'&&target){const hash=createHash('sha256').update(target.id).digest('hex');d.targetCooldowns={...d.targetCooldowns,[hash]:now+24*60*60_000};}
    d.cooldowns[kind]=now+cooldown;this.save(d);
    const announcements:Partial<Record<PrankKind,string>>={chief:'👑 Elio hat für eine Minute die Kontrolle übernommen. Beschwerden bitte ausschließlich in Form von Leckerlis einreichen.',
      accusation:`🐱 Elio verdächtigt @${clean(target?.name||'',32)}, heimlich Katzenfutter stibitzt zu haben. Das ist nur Quatsch! Mit !unschuldig verteidigst du dich oder mit !prankoptout sagst du dauerhaft ab.`,
      'vault-alarm':'🚨 Fehlalarm! Elio hat die Tresorwache übernommen. Am Spielstand ändert sich nichts.',oracle:'🔮 Das unseriöse Orakel ist für zwei Minuten geöffnet: Stelle eine harmlose Frage mit !orakel.'};
    return {ok:true,message:`${label(kind)} gestartet.`,...(d.settings.announce[kind]?{announcement:announcements[kind]}:{})};
  }
  end(now=Date.now()):boolean { const d=this.data(now);if(!d.active)return false;d.cooldowns[d.active.kind]=Math.max(d.cooldowns[d.active.kind]||0,now);delete d.active;this.save(d);return true; }
  tick(now=Date.now()):void { const raw=this.store.config<PersistedPranks>('moderator_pranks',this.empty());if(raw.active&&raw.active.endsAt<=now){delete raw.active;this.save(raw);} }
  private empty():PersistedPranks{return {settings:DEFAULTS,cooldowns:{},optOutHashes:[],targetCooldowns:{}};}
  handle(message:ChatMessage,command:string,args:string[],now=Date.now()):string|undefined {
    if(command==='unschuldig'){
      const d=this.data(now),active=d.active;if(!active||active.kind!=='accusation'||active.targetId!==message.senderUserId)return undefined;
      const hash=createHash('sha256').update(message.senderUserId).digest('hex');if(d.optOutHashes.includes(hash))return '🐱 Elio respektiert deinen Wunsch: Für dich gibt es keine weiteren Verdächtigungen.';
      const text=['Elio hat die Beweise geprüft: Das Futter war nur ein Keks. Freispruch!','Die Pfotenabdrücke gehören Elio selbst. Fall geschlossen!','Der Napf war leer, weil Elio ihn schon bewacht hat. Du bist unschuldig!'][randomInt(3)];
      delete d.active;this.save(d);return `🐱 @${clean(message.senderDisplayName,32)}: ${text}`;
    }
    if(command==='prankoptout'||command==='prankoptin'){
      const d=this.data(now),hash=createHash('sha256').update(message.senderUserId).digest('hex');
      if(command==='prankoptout'&&!d.optOutHashes.includes(hash)&&d.optOutHashes.length>=10_000)return '🐱 Elio kann deinen Wunsch gerade nicht sicher speichern. Bitte wende dich an Jannik oder einen Moderator.';
      if(command==='prankoptout'&&d.active?.kind==='accusation'&&d.active.targetId===message.senderUserId)delete d.active;
      d.optOutHashes=d.optOutHashes.filter(item=>item!==hash);
      if(command==='prankoptout')d.optOutHashes.push(hash);
      this.save(d);return command==='prankoptout'?'🐱 Für dich sind Elio-Verdächtigungen ausgeschaltet. Mit !prankoptin kannst du sie wieder erlauben.':'🐱 Elio darf dich wieder scherzhaft verdächtigen.';
    }
    if(command!=='orakel')return undefined;
    const d=this.data(now);if(!d.settings.enabled.oracle||!d.active||d.active.kind!=='oracle'||d.active.endsAt<=now)return '🔮 Das Orakel schläft gerade.';
    if(args.join(' ').trim().length<3)return '🔮 Stell dem Orakel eine harmlose Frage: !orakel Frage';
    const userHash=createHash('sha256').update(message.senderUserId).digest('hex');if((d.oracleUserCooldowns?.[userHash]||0)>now)return undefined;
    if((d.oracleRecent||[]).length>=5)return undefined;
    d.oracleUserCooldowns={...d.oracleUserCooldowns,[userHash]:now+30_000};d.oracleRecent=[...(d.oracleRecent||[]),now];this.save(d);
    return `${PREFIX} ${ORACLE_ANSWERS[randomInt(ORACLE_ANSWERS.length)]}`;
  }
}
function clean(value:string,max:number):string{return Array.from(value.replace(/[\r\n\t@]/gu,' ').trim()).slice(0,max).join('')||'Community-Mitglied';}
function label(kind:PrankKind):string{return ({chief:'Elio als Stream-Chef',accusation:'Elio-Verdacht', 'vault-alarm':'Tresor-Fehlalarm',oracle:'Orakelphase'} as const)[kind];}
