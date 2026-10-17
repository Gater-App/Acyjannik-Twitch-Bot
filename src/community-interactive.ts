import { randomInt, randomUUID } from 'node:crypto';
import { FeatureStore } from './feature-store.js';

export type InteractiveEventKind='battle'|'mystery_case'|'elio_rescue'|'secret_portal'|'game_night';
export type InteractivePlatform='twitch'|'discord';
export interface InteractiveSettings {
  battleEnabled:boolean;secretEventsEnabled:boolean;autoSecretEventsEnabled:boolean;gameNightEnabled:boolean;
  elio2Enabled:boolean;chaosWheel2Enabled:boolean;personalityEnabled:boolean;
  battleDurationMs:number;battleCooldownMs:number;battleActionCooldownMs:number;battleMaxPointsPerUser:number;
  secretEventDurationMs:number;secretRewardXp:number;gameNightTimezone:string;
}
const DEFAULTS:InteractiveSettings={battleEnabled:false,secretEventsEnabled:false,autoSecretEventsEnabled:false,gameNightEnabled:false,elio2Enabled:false,chaosWheel2Enabled:false,personalityEnabled:false,battleDurationMs:600_000,battleCooldownMs:3_600_000,battleActionCooldownMs:30_000,battleMaxPointsPerUser:10,secretEventDurationMs:90_000,secretRewardXp:0,gameNightTimezone:'Europe/Berlin'};
const EVENT_KINDS=new Set<InteractiveEventKind>(['battle','mystery_case','elio_rescue','secret_portal','game_night']);
const safeName=(value:string)=>Array.from(value.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim()).slice(0,80).join('')||'Community-Mitglied';

export interface InteractiveEvent {id:string;kind:InteractiveEventKind;status:'scheduled'|'open'|'completed'|'canceled';title:string;description:string;startsAt:number;endsAt:number|null;settings:Record<string,unknown>;participants:number;waitlist:number;points?:{twitch:number;discord:number};result?:string;}
export interface InteractiveResult {ok:boolean;message:string;event?:InteractiveEvent;status?:'joined'|'waitlist'|'withdrawn';duplicate?:boolean;points?:number;}

/** Cross-platform event state lives beside Twitch XP, account links and the existing SQLite community store. */
export class CommunityInteractive {
  constructor(private readonly store:FeatureStore,private readonly chooseOutcome:(exclusiveMax:number)=>number=(max)=>randomInt(max)){}
  settings():InteractiveSettings{return {...DEFAULTS,...this.store.config<Partial<InteractiveSettings>>('community_interactive_settings',DEFAULTS)};}
  updateSettings(value:Partial<InteractiveSettings>):InteractiveSettings{
    const current=this.settings(),next={...current,...value};
    for(const key of ['battleEnabled','secretEventsEnabled','autoSecretEventsEnabled','gameNightEnabled','elio2Enabled','chaosWheel2Enabled','personalityEnabled'] as const)if(typeof next[key]!=='boolean')throw new Error('Feature-Schalter müssen Ein oder Aus sein.');
    for(const [key,min,max] of [['battleDurationMs',60_000,3_600_000],['battleCooldownMs',60_000,86_400_000],['battleActionCooldownMs',5_000,600_000],['battleMaxPointsPerUser',1,100],['secretEventDurationMs',15_000,900_000]] as const)if(!Number.isInteger(next[key])||next[key]<min||next[key]>max)throw new Error('Event-Limits liegen außerhalb des erlaubten Bereichs.');
    if(!Number.isInteger(next.secretRewardXp)||next.secretRewardXp<0||next.secretRewardXp>20)throw new Error('Geheime Event-Belohnungen müssen zwischen 0 und 20 XP liegen.');
    try{new Intl.DateTimeFormat('de-DE',{timeZone:next.gameNightTimezone});}catch{throw new Error('Die Game-Night-Zeitzone ist ungültig.');}
    if(next.autoSecretEventsEnabled&&!next.secretEventsEnabled)throw new Error('Automatische Überraschungs-Events benötigen zuerst die manuelle Event-Freigabe.');
    this.store.setConfig('community_interactive_settings',next);return next;
  }
  startBattle(actorId:string,now=Date.now()):InteractiveResult{
    const settings=this.settings();if(!settings.battleEnabled)return {ok:false,message:'Twitch-vs-Discord ist im Dashboard ausgeschaltet.'};
    const last=this.store.miniGameQuery(db=>db.prepare("SELECT created_at at FROM community_interactive_events WHERE kind='battle' ORDER BY created_at DESC LIMIT 1").get() as {at:number}|undefined);
    if(last&&now-last.at<settings.battleCooldownMs)return {ok:false,message:'Der nächste Community-Battle braucht noch eine kurze Pause.'};
    const id=randomUUID(),created=this.store.miniGameTransaction(db=>{const active=db.prepare("SELECT 1 FROM community_interactive_events WHERE kind='battle' AND status IN ('open','scheduled') LIMIT 1").get();if(active)return false;db.prepare("INSERT INTO community_interactive_events(id,kind,status,title,description,starts_at,ends_at,settings_json,created_by,created_at,updated_at) VALUES(?,'battle','open','ACY BATTLE · Twitch vs. Discord','',?,?,?, ?,?,?)").run(id,now,now+settings.battleDurationMs,JSON.stringify({maxPointsPerUser:settings.battleMaxPointsPerUser,actionCooldownMs:settings.battleActionCooldownMs}),actorId,now,now);return true;});
    if(!created)return {ok:false,message:'Es läuft bereits ein Community-Battle.'};
    return {ok:true,message:'ACY BATTLE gestartet.',event:this.get(id,now)!};
  }
  createSecretEvent(kind:Extract<InteractiveEventKind,'mystery_case'|'elio_rescue'|'secret_portal'>,actorId:string,input:{title:string;description?:string;durationMs?:number},now=Date.now()):InteractiveResult{
    const settings=this.settings();if(!settings.secretEventsEnabled)return {ok:false,message:'Geheime Community-Events sind im Dashboard ausgeschaltet.'};
    if(!EVENT_KINDS.has(kind))return {ok:false,message:'Eventtyp ungültig.'};
    const title=input.title.trim();if(title.length<3||title.length>120)throw new Error('Der Eventtitel muss zwischen 3 und 120 Zeichen lang sein.');
    const description=(input.description||'').trim();if(description.length>1000)throw new Error('Die Eventbeschreibung darf höchstens 1000 Zeichen lang sein.');
    const duration=input.durationMs??settings.secretEventDurationMs;if(!Number.isInteger(duration)||duration<15_000||duration>900_000)throw new Error('Die Eventdauer muss zwischen 15 Sekunden und 15 Minuten liegen.');
    const id=randomUUID();this.store.miniGameTransaction(db=>{const active=db.prepare("SELECT 1 FROM community_interactive_events WHERE kind IN ('mystery_case','elio_rescue','secret_portal') AND status='open' LIMIT 1").get();if(active)throw new Error('Es läuft bereits ein geheimes Community-Event.');db.prepare('INSERT INTO community_interactive_events(id,kind,status,title,description,starts_at,ends_at,settings_json,created_by,created_at,updated_at) VALUES(?,?,\'open\',?,?,?,?,?,?,?,?)').run(id,kind,title,description,now,now+duration,JSON.stringify({durationMs:duration,rewardXp:settings.secretRewardXp}),actorId,now,now);});
    return {ok:true,message:'Geheimes Community-Event gestartet.',event:this.get(id,now)!};
  }
  createGameNight(actorId:string,input:{title:string;game:string;description?:string;localStart:string;capacity:number;waitlist:boolean;registrationClosesAt?:number|null},now=Date.now()):InteractiveResult{
    if(!this.settings().gameNightEnabled)return {ok:false,message:'Game Night ist im Dashboard ausgeschaltet.'};
    const title=input.title.trim(),game=input.game.trim(),description=(input.description||'').trim();
    if(title.length<3||title.length>120||game.length<1||game.length>80||description.length>1000)throw new Error('Titel, Spiel oder Beschreibung sind ungültig.');
    if(!Number.isInteger(input.capacity)||input.capacity<2||input.capacity>500)throw new Error('Die maximale Teilnehmerzahl muss zwischen 2 und 500 liegen.');
    const startsAt=localTimeToEpoch(input.localStart,this.settings().gameNightTimezone);if(startsAt<now+5*60_000||startsAt>now+366*86_400_000)throw new Error('Der Spieleabend muss mindestens 5 Minuten und höchstens ein Jahr in der Zukunft liegen.');
    const closes=input.registrationClosesAt??startsAt;if(!Number.isFinite(closes)||closes>startsAt||closes<now)throw new Error('Der Anmeldeschluss muss zwischen jetzt und dem Start liegen.');
    const id=randomUUID();this.store.miniGameTransaction(db=>db.prepare("INSERT INTO community_interactive_events(id,kind,status,title,description,starts_at,ends_at,settings_json,created_by,created_at,updated_at) VALUES(?,'game_night','scheduled',?,?,?,?,?,?,?,?)").run(id,`${title} · ${game}`,description,startsAt,closes,JSON.stringify({game,capacity:input.capacity,waitlist:input.waitlist===true,timezone:this.settings().gameNightTimezone,localStart:input.localStart}),actorId,now,now));
    return {ok:true,message:'Game Night wurde erstellt.',event:this.get(id,now)!};
  }
  join(eventId:string,platform:InteractivePlatform,userId:string,displayName:string,team?:InteractivePlatform,now=Date.now()):InteractiveResult{
    const eventKind=this.kind(eventId);if(!eventKind||!EVENT_KINDS.has(eventKind))return {ok:false,message:'Dieses Community-Event wurde nicht gefunden.'};
    if(!['twitch','discord'].includes(platform)||!userId||userId.length>30)return {ok:false,message:'Teilnahme-ID ungültig.'};
    return this.store.miniGameTransaction(db=>{
      const row=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(eventId) as EventRow|undefined;if(!row)return {ok:false,message:'Dieses Community-Event wurde nicht gefunden.'};
      this.expireIfNeeded(db,row,now);const current=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(eventId) as EventRow;
      if(!this.isEnabled(current.kind))return {ok:false,message:'Diese Community-Aktion ist derzeit ausgeschaltet.'};
      const startable=current.kind==='game_night'&&current.status==='scheduled';
      if(!startable&&current.status!=='open')return {ok:false,message:'Die Teilnahme ist bereits beendet.'};
      if(current.kind==='game_night'&&current.ends_at!==null&&now>=current.ends_at)return {ok:false,message:'Der Anmeldeschluss ist erreicht.'};
      if(current.kind==='battle'&&current.ends_at!==null&&now>=current.ends_at)return {ok:false,message:'Der Battle ist beendet.'};
      const identity=this.identity(db,platform,userId),aliases=this.identityCandidates(db,platform,userId);const existing=this.findParticipant(db,eventId,aliases) as {identity_key:string;team:InteractivePlatform|null;status:string}|undefined;
      if(existing){if(current.kind==='battle'&&existing.team!==platform)return {ok:false,message:'Verknüpfte Konten können nur für ein Team Punkte sammeln.'};if(existing.status==='withdrawn')return {ok:false,message:'Deine Teilnahme wurde bereits beendet.'};return {ok:true,message:existing.status==='waitlist'?'Du stehst bereits auf der Warteliste.':'Deine Teilnahme ist bereits gespeichert.',status:existing.status as 'joined'|'waitlist',duplicate:true,event:this.get(eventId,now)!};}
      const eventSettings=parseSettings(current.settings_json);let status:'joined'|'waitlist'='joined';
      if(current.kind==='game_night'){
        const occupied=(db.prepare("SELECT COUNT(*) n FROM community_interactive_participants WHERE event_id=? AND status='joined'").get(eventId) as {n:number}).n;
        if(occupied>=Number(eventSettings.capacity||0)){if(eventSettings.waitlist!==true)return {ok:false,message:'Alle Plätze für diesen Spieleabend sind belegt.'};status='waitlist';}
      }
      const selectedTeam=current.kind==='battle'?platform:null;
      if(current.kind==='battle'&&!['twitch','discord'].includes(String(selectedTeam)))return {ok:false,message:'Battle-Team ungültig.'};
      db.prepare('INSERT INTO community_interactive_participants(event_id,identity_key,platform,platform_user_id,display_name,team,status,joined_at) VALUES(?,?,?,?,?,?,?,?)').run(eventId,identity,platform,userId,safeName(displayName),selectedTeam,status,now);
      if(startable)db.prepare("UPDATE community_interactive_events SET status='open',updated_at=? WHERE id=? AND status='scheduled'").run(now,eventId);
      return {ok:true,message:status==='waitlist'?'Du bist auf der Warteliste.':'Du bist dabei!',status,event:this.get(eventId,now)!};
    });
  }
  contribute(eventId:string,actionEventId:string,platform:InteractivePlatform,userId:string,now=Date.now()):InteractiveResult{
    if(!actionEventId||actionEventId.length>100)return {ok:false,message:'Event-ID ungültig.'};
    return this.store.miniGameTransaction(db=>{
      const row=db.prepare('SELECT * FROM community_interactive_events WHERE id=? AND kind=\'battle\'').get(eventId) as EventRow|undefined;if(!row)return {ok:false,message:'Dieser Battle wurde nicht gefunden.'};
      this.expireIfNeeded(db,row,now);const event=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(eventId) as EventRow;if(event.status!=='open'||!this.settings().battleEnabled)return {ok:false,message:'Der Battle nimmt gerade keine Punkte mehr an.'};
      const aliases=this.identityCandidates(db,platform,userId),participant=this.findParticipant(db,eventId,aliases) as ParticipantRow|undefined;
      if(!participant||participant.status!=='joined')return {ok:false,message:'Melde dich zuerst über Twitch oder Discord bei einem Team an.'};
      if(participant.team!==platform&&!this.isLinkedIdentity(db,platform,userId))return {ok:false,message:'Teilnahme und Punkte müssen von derselben Plattform kommen.'};
      if(db.prepare('SELECT 1 FROM community_interactive_actions WHERE action_event_id=?').get(actionEventId))return {ok:true,message:'Diese Aktion wurde bereits gezählt.',duplicate:true,points:0,event:this.get(eventId,now)!};
      const settings=this.settings();if(participant.last_action_at!==null&&now-participant.last_action_at<settings.battleActionCooldownMs)return {ok:false,message:'Bitte warte kurz, bevor du weitere Battle-Punkte sammelst.'};
      if(participant.points>=settings.battleMaxPointsPerUser)return {ok:false,message:'Dein persönliches Battle-Punktelimit ist erreicht.'};
      db.prepare('INSERT INTO community_interactive_actions(action_event_id,event_id,identity_key,kind,points,created_at) VALUES(?,?,?,\'battle-action\',1,?)').run(actionEventId,eventId,participant.identity_key,now);
      db.prepare('UPDATE community_interactive_participants SET points=points+1,last_action_at=? WHERE event_id=? AND identity_key=?').run(now,eventId,participant.identity_key);
      return {ok:true,message:'Ein Battle-Punkt wurde gezählt.',points:1,event:this.get(eventId,now)!};
    });
  }
  leave(eventId:string,platform:InteractivePlatform,userId:string,now=Date.now()):InteractiveResult{
    return this.store.miniGameTransaction(db=>{
      const row=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(eventId) as EventRow|undefined;
      if(!row||row.kind!=='game_night')return {ok:false,message:'Game Night nicht gefunden.'};
      this.expireIfNeeded(db,row,now);const current=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(eventId) as EventRow;
      if(!['scheduled','open'].includes(current.status)||current.ends_at!==null&&now>=current.ends_at)return {ok:false,message:'Die Anmeldefrist für diesen Spieleabend ist vorbei.'};
      const aliases=this.identityCandidates(db,platform,userId),person=this.findParticipant(db,eventId,aliases) as ParticipantRow|undefined;
      if(!person||!['joined','waitlist'].includes(person.status))return {ok:false,message:'Du bist für diesen Spieleabend nicht angemeldet.'};
      db.prepare("UPDATE community_interactive_participants SET status='withdrawn' WHERE event_id=? AND identity_key=?").run(eventId,person.identity_key);
      if(person.status==='joined'){const next=db.prepare("SELECT identity_key FROM community_interactive_participants WHERE event_id=? AND status='waitlist' ORDER BY joined_at LIMIT 1").get(eventId) as {identity_key:string}|undefined;if(next)db.prepare("UPDATE community_interactive_participants SET status='joined' WHERE event_id=? AND identity_key=? AND status='waitlist'").run(eventId,next.identity_key);}
      return {ok:true,message:person.status==='joined'?'Du wurdest abgemeldet. Der nächste Wartelistenplatz rückt nach.':'Du wurdest von der Warteliste entfernt.',status:'withdrawn' as const,event:this.get(eventId,now)!};
    });
  }
  cancel(eventId:string,actorId:string,now=Date.now()):boolean{return this.store.miniGameTransaction(db=>db.prepare("UPDATE community_interactive_events SET status='canceled',updated_at=? WHERE id=? AND status IN ('scheduled','open')").run(now,eventId).changes===1);}
  finish(eventId:string,actorId:string,now=Date.now()):boolean{return this.store.miniGameTransaction(db=>{const row=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(eventId) as EventRow|undefined;if(!row||!['scheduled','open'].includes(row.status))return false;if(['mystery_case','elio_rescue','secret_portal'].includes(row.kind)){this.resolveSecretEvent(db,row,now);return true;}return db.prepare("UPDATE community_interactive_events SET status='completed',ends_at=COALESCE(ends_at,?),updated_at=? WHERE id=? AND status IN ('scheduled','open')").run(now,now,eventId).changes===1;});}
  active(kind?:InteractiveEventKind,now=Date.now()):InteractiveEvent[]{return this.store.miniGameQuery(db=>{const rows=db.prepare(`SELECT * FROM community_interactive_events WHERE status IN ('scheduled','open')${kind?' AND kind=?':''} ORDER BY starts_at LIMIT 50`).all(...(kind?[kind]:[])) as EventRow[];return rows.map(row=>{this.expireIfNeeded(db,row,now);return this.readEvent(db,row.id,now);}).filter((event):event is InteractiveEvent=>Boolean(event));});}
  history(limit=25,now=Date.now()):InteractiveEvent[]{return this.store.miniGameQuery(db=>(db.prepare("SELECT id FROM community_interactive_events WHERE status IN ('completed','canceled') ORDER BY updated_at DESC LIMIT ?").all(Math.max(1,Math.min(100,limit))) as Array<{id:string}>).map(row=>this.readEvent(db,row.id,now)).filter((event):event is InteractiveEvent=>Boolean(event)));}
  get(id:string,now=Date.now()):InteractiveEvent|undefined{return this.store.miniGameQuery(db=>this.readEvent(db,id,now));}
  private kind(id:string):InteractiveEventKind|undefined{return this.store.miniGameQuery(db=>{const row=db.prepare('SELECT kind FROM community_interactive_events WHERE id=?').get(id) as {kind:InteractiveEventKind}|undefined;return row?.kind;});}
  private isEnabled(kind:InteractiveEventKind):boolean{return kind==='battle'?this.settings().battleEnabled:kind==='game_night'?this.settings().gameNightEnabled:this.settings().secretEventsEnabled;}
  private identity(db:import('better-sqlite3').Database,platform:InteractivePlatform,userId:string):string{const twitchId=platform==='discord'?(db.prepare('SELECT twitch_user_id id FROM community_account_links WHERE discord_user_id=?').get(userId) as {id:string}|undefined)?.id:userId;return twitchId?`twitch:${twitchId}`:`${platform}:${userId}`;}
  private identityCandidates(db:import('better-sqlite3').Database,platform:InteractivePlatform,userId:string):string[]{const candidates=[this.identity(db,platform,userId),`${platform}:${userId}`];if(platform==='discord'){const link=db.prepare('SELECT twitch_user_id id FROM community_account_links WHERE discord_user_id=?').get(userId) as {id:string}|undefined;if(link)candidates.push(`twitch:${link.id}`);}else{const link=db.prepare('SELECT discord_user_id id FROM community_account_links WHERE twitch_user_id=?').get(userId) as {id:string}|undefined;if(link)candidates.push(`discord:${link.id}`);}return [...new Set(candidates)];}
  private findParticipant(db:import('better-sqlite3').Database,eventId:string,identities:string[]):ParticipantRow|undefined{return db.prepare(`SELECT identity_key,team,status,points,last_action_at FROM community_interactive_participants WHERE event_id=? AND identity_key IN (${identities.map(()=>'?').join(',')}) LIMIT 1`).get(eventId,...identities) as ParticipantRow|undefined;}
  private isLinkedIdentity(db:import('better-sqlite3').Database,platform:InteractivePlatform,userId:string):boolean{return platform==='discord'?Boolean(db.prepare('SELECT 1 FROM community_account_links WHERE discord_user_id=?').get(userId)):Boolean(db.prepare('SELECT 1 FROM community_account_links WHERE twitch_user_id=?').get(userId));}
  private expireIfNeeded(db:import('better-sqlite3').Database,row:EventRow,now:number):void{if(row.status!=='open'||row.ends_at===null||now<row.ends_at)return;if(['mystery_case','elio_rescue','secret_portal'].includes(row.kind))this.resolveSecretEvent(db,row,now);else db.prepare("UPDATE community_interactive_events SET status='completed',updated_at=? WHERE id=? AND status='open'").run(now,row.id);}
  private resolveSecretEvent(db:import('better-sqlite3').Database,row:EventRow,now:number):void{
    if(row.status!=='open')return;
    const participants=db.prepare("SELECT identity_key,display_name FROM community_interactive_participants WHERE event_id=? AND status='joined' ORDER BY joined_at").all(row.id) as Array<{identity_key:string;display_name:string}>;
    const settings=parseSettings(row.settings_json),rewardXp=Math.max(0,Math.min(20,Number(settings.rewardXp)||0));
    const outcome=this.chooseOutcome(3);let result='Der Koffer war leer – aber der gemeinsame Fund zählt trotzdem als Abenteuer.';
    if(outcome===0&&rewardXp>0&&participants.length){const winner=participants[this.chooseOutcome(participants.length)]!;if(winner.identity_key.startsWith('twitch:')){const userId=winner.identity_key.slice(7);const awarded=this.store.awardXp(`secret-event:${row.id}:${winner.identity_key}`,userId,winner.display_name,rewardXp,'bonus:secret-event',now,10);result=awarded?`🎁 ${winner.display_name} gewinnt ${awarded} Community-XP aus dem geheimen Event.`:'🎁 Ein kleiner XP-Gewinn wurde gezogen; das tägliche Bonuslimit war bereits erreicht.';}else result='🎁 Ein kleiner XP-Gewinn wurde gezogen; dafür ist ein verknüpftes Twitch-Konto erforderlich.';}
    else if(outcome===1&&rewardXp>0&&participants.length){let paid=0;for(const person of participants){if(!person.identity_key.startsWith('twitch:'))continue;paid+=this.store.awardXp(`secret-event:${row.id}:${person.identity_key}`,person.identity_key.slice(7),person.display_name,rewardXp,'bonus:secret-event',now,10);}result=paid?`🎉 Der Community-Jackpot ist offen: ${paid} berechtigte Mitglieder erhielten jeweils bis zu ${rewardXp} XP.`:'🎉 Der Community-Jackpot wurde gezogen; verknüpfte Konten waren nicht verfügbar.';}
    else if(outcome===2){const arcade=this.store.config<{petEnabled?:boolean}>('arcade_settings',{});if(arcade.petEnabled){db.prepare('UPDATE community_pet SET hunger=MAX(0,hunger-10),happiness=MIN(100,happiness+5),energy=MIN(100,energy+5),animation=\'happy\',updated_at=? WHERE id=1').run(now);result='🐱 Elio hat einen besonderen Snack bekommen: Sättigung, Stimmung und Energie wurden verbessert.';}else result='🐱 Elio hat einen besonderen Snack gefunden; seine Pflege ist derzeit pausiert.';}
    const updated={...settings,result,outcome:outcome===0?'small_xp':outcome===1?'community_jackpot':'elio_snack'};
    db.prepare("UPDATE community_interactive_events SET status='completed',ends_at=COALESCE(ends_at,?),settings_json=?,updated_at=? WHERE id=? AND status='open'").run(now,JSON.stringify(updated),now,row.id);
  }
  private readEvent(db:import('better-sqlite3').Database,id:string,now:number):InteractiveEvent|undefined{const row=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(id) as EventRow|undefined;if(!row)return;this.expireIfNeeded(db,row,now);const current=db.prepare('SELECT * FROM community_interactive_events WHERE id=?').get(id) as EventRow;const settings=parseSettings(current.settings_json),stats=db.prepare("SELECT SUM(status='joined') participants,SUM(status='waitlist') waitlist,SUM(CASE WHEN team='twitch' THEN points ELSE 0 END) twitch,SUM(CASE WHEN team='discord' THEN points ELSE 0 END) discord FROM community_interactive_participants WHERE event_id=?").get(id) as {participants:number|null;waitlist:number|null;twitch:number|null;discord:number|null};return {id:current.id,kind:current.kind,status:current.status,title:current.title,description:current.description,startsAt:current.starts_at,endsAt:current.ends_at,settings,participants:stats.participants||0,waitlist:stats.waitlist||0,...(current.kind==='battle'?{points:{twitch:stats.twitch||0,discord:stats.discord||0}}:{}),...(typeof settings.result==='string'?{result:settings.result}:{})};}
}
interface EventRow{id:string;kind:InteractiveEventKind;status:'scheduled'|'open'|'completed'|'canceled';title:string;description:string;starts_at:number;ends_at:number|null;settings_json:string;created_by:string;created_at:number;updated_at:number;}
interface ParticipantRow{identity_key:string;team:InteractivePlatform|null;status:string;points:number;last_action_at:number|null;}
function parseSettings(value:string):Record<string,unknown>{try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'?parsed:{}}catch{return {};}}
export function localTimeToEpoch(value:string,timeZone='Europe/Berlin'):number{
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);if(!match)throw new Error('Bitte Datum und Uhrzeit im lokalen Format JJJJ-MM-TT HH:MM angeben.');
  const target=match.slice(1).map(Number),[year,month,day,hour,minute]=target as [number,number,number,number,number];
  if(month<1||month>12||day<1||day>31||hour>23||minute>59)throw new Error('Datum oder Uhrzeit ungültig.');
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),matches:number[]=[];
  const targetUtc=Date.UTC(year,month-1,day,hour,minute);
  for(let offset=-14*60;offset<=14*60;offset+=15){const epoch=targetUtc-offset*60_000,parts=Object.fromEntries(formatter.formatToParts(epoch).map(part=>[part.type,part.value]));if(Number(parts.year)===year&&Number(parts.month)===month&&Number(parts.day)===day&&Number(parts.hour)===hour&&Number(parts.minute)===minute)matches.push(epoch);}
  if(matches.length!==1)throw new Error(matches.length?'Diese lokale Uhrzeit ist wegen der Zeitumstellung doppeldeutig. Bitte wähle eine andere Uhrzeit.':'Diese lokale Uhrzeit existiert wegen der Zeitumstellung nicht. Bitte wähle eine andere Uhrzeit.');
  return matches[0]!;
}
