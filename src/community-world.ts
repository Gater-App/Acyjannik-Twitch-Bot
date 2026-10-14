import { FeatureStore } from './feature-store.js';

export interface WorldMission {
  id:string; cadence:'daily'|'weekly'; title:string; description:string; progress:number; target:number;
  rewardXp:number; completed:boolean; claimed:boolean; periodKey:string;
}
export interface WorldBadge {id:string;name:string;description:string;rarity:'common'|'rare'|'epic';emoji:string;unlockedAt:number;}

const BADGES=[
  {id:'elio_friend',name:'Elios bester Freund',description:'Führe fünf Elio-Aktionen seit Start der Community-Welt aus.',rarity:'common' as const,emoji:'🐱'},
  {id:'quest_spark',name:'Quest-Funken',description:'Reiche eine Community-Quest ein, die das System angenommen hat.',rarity:'common' as const,emoji:'📜'},
  {id:'community_player',name:'Teamplayer',description:'Erhalte eine belegte Belohnung aus einem Community-Spiel.',rarity:'rare' as const,emoji:'🤝'},
  {id:'xp_collector',name:'XP-Sammler',description:'Sammle seit Start der Community-Welt 100 XP.',rarity:'epic' as const,emoji:'⭐'},
  {id:'haunted_visitor',name:'Erster Spukhaus-Besuch',description:'Trage während der Halloween-Saison mit einer gültigen Runde bei.',rarity:'common' as const,emoji:'🕯️'},
  {id:'haunted_scout',name:'Mitternachts-Entdecker',description:'Trage mit fünf gültigen Halloween-Runden zum Spukhaus bei.',rarity:'rare' as const,emoji:'🔎'},
  {id:'haunted_house_crew',name:'Geisterhaus-Crew',description:'Hilf der Community, das gemeinsame Spukhaus-Ziel zu erreichen.',rarity:'epic' as const,emoji:'🏚️'},
];
const BERLIN_DATE=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
function dayKey(now:number):string{const parts=Object.fromEntries(BERLIN_DATE.formatToParts(now).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;}
function weekKey(now:number):string{const localDate=dayKey(now),d=new Date(`${localDate}T00:00:00.000Z`),day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);return `week-${d.toISOString().slice(0,10)}`;}
function berlinMidnight(key:string):number{
  const utcGuess=Date.parse(`${key}T00:00:00.000Z`),parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(utcGuess).map(part=>[part.type,part.value]));
  const localAsUtc=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
  return utcGuess-(localAsUtc-utcGuess);
}
function dayStart(key:string):number{return berlinMidnight(key);}
function weekStart(key:string):number{return berlinMidnight(key.slice(5));}

/** Viewer-facing progression uses only persisted actions after this module's launch timestamp. */
export class CommunityWorld {
  constructor(private readonly store:FeatureStore){}

  snapshot(userId:string,displayName:string,now:number,options:{petEnabled:boolean;questsEnabled:boolean;gamesEnabled?:boolean}):{missions:WorldMission[];badges:WorldBadge[];newlyUnlocked:WorldBadge[]} {
    const startedAt=this.startedAt();
    const badges=this.unlockEligible(userId,now,startedAt);
    const daily=dayKey(now),weekly=weekKey(now),dailyFrom=Math.max(dayStart(daily),startedAt),weeklyFrom=Math.max(weekStart(weekly),startedAt);
    const missions:WorldMission[]=[];
    if(options.petEnabled){
      missions.push(this.mission(userId,'daily','visit_elio','Gib Elio Aufmerksamkeit','Füttere Elio oder spiel mit ihm einmal.',10,1,
        this.count('SELECT COUNT(*) n FROM community_pet_interactions WHERE user_id=? AND created_at>=?',userId,dailyFrom),daily,now));
      missions.push(this.mission(userId,'weekly','play_with_elio','Elios Spielkamerad','Unternimm drei Pflegeaktionen mit Elio.',25,3,
        this.count('SELECT COUNT(*) n FROM community_pet_interactions WHERE user_id=? AND created_at>=?',userId,weeklyFrom),weekly,now));
    }
    if(options.questsEnabled){
      missions.push(this.mission(userId,'daily','share_quest','Eine Idee für die Community','Reiche eine Quest-Idee ein. Sie zählt, sobald das System sie angenommen hat.',10,1,
        this.count("SELECT COUNT(*) n FROM quests WHERE submitter_user_id=? AND submitted_at>=? AND status NOT IN ('rejected','failed','canceled')",userId,dailyFrom),daily,now));
      missions.push(this.mission(userId,'weekly','share_two_quests','Ideenbringer','Reiche zwei Quest-Ideen ein, die das System annimmt.',25,2,
        this.count("SELECT COUNT(*) n FROM quests WHERE submitter_user_id=? AND submitted_at>=? AND status NOT IN ('rejected','failed','canceled')",userId,weeklyFrom),weekly,now));
    }
    if(options.gamesEnabled!==false)missions.push(this.mission(userId,'weekly','play_community_game','Gemeinsam spielen','Erhalte eine XP-Belohnung aus einem Community-Spiel.',30,1,
      this.count("SELECT COUNT(*) n FROM mini_game_awards WHERE user_id=? AND created_at>=?",userId,weeklyFrom),weekly,now));
    const earned=this.store.miniGameQuery(db=>db.prepare('SELECT badge_id,unlocked_at FROM community_world_badges WHERE user_id=? ORDER BY unlocked_at DESC').all(userId) as Array<{badge_id:string;unlocked_at:number}>);
    const owned=new Map(earned.map(x=>[x.badge_id,x.unlocked_at]));
    return {missions,badges:BADGES.filter(b=>owned.has(b.id)).map(b=>({...b,unlockedAt:owned.get(b.id)!})).sort((a,b)=>b.unlockedAt-a.unlockedAt),newlyUnlocked:badges};
  }

  claim(userId:string,displayName:string,missionId:string,now:number,options:{petEnabled:boolean;questsEnabled:boolean;gamesEnabled?:boolean}):{ok:true;rewardXp:number}|{ok:false;reason:'unavailable'|'incomplete'|'claimed'} {
    const state=this.snapshot(userId,displayName,now,options),mission=state.missions.find(x=>x.id===missionId);
    if(!mission)return {ok:false,reason:'unavailable'};
    if(mission.claimed)return {ok:false,reason:'claimed'};
    if(!mission.completed)return {ok:false,reason:'incomplete'};
    return this.store.miniGameTransaction(db=>{
      const inserted=db.prepare('INSERT OR IGNORE INTO community_world_mission_claims(user_id,mission_id,period_key,claimed_at,reward_xp) VALUES(?,?,?,?,?)')
        .run(userId,mission.id,mission.periodKey,now,mission.rewardXp);
      if(!inserted.changes)return {ok:false as const,reason:'claimed' as const};
      const granted=this.store.awardXp(`community-world:mission:${userId}:${mission.id}:${mission.periodKey}`,userId,displayName,mission.rewardXp,'community-world:mission',now);
      return {ok:true as const,rewardXp:granted};
    });
  }

  private mission(userId:string,cadence:'daily'|'weekly',id:string,title:string,description:string,rewardXp:number,target:number,progress:number,periodKey:string,now:number):WorldMission{
    const claimed=Boolean(this.store.miniGameQuery(db=>db.prepare('SELECT 1 FROM community_world_mission_claims WHERE user_id=? AND mission_id=? AND period_key=?').get(userId,id,periodKey)));
    return {id,cadence,title,description,progress:Math.min(target,progress),target,rewardXp,completed:progress>=target,claimed,periodKey};
  }
  private count(sql:string,...args:Array<string|number>):number{return this.store.miniGameQuery(db=>(db.prepare(sql).get(...args) as {n:number}).n);}
  private startedAt():number{return this.store.miniGameQuery(db=>{const row=db.prepare("SELECT value FROM feature_config WHERE key='community_world_started_at'").get() as {value:string}|undefined;return Number(row?.value)||Date.now();});}
  private unlockEligible(userId:string,now:number,startedAt:number):WorldBadge[]{
    return this.store.miniGameTransaction(db=>{
      const pet=this.count('SELECT COUNT(*) n FROM community_pet_interactions WHERE user_id=? AND created_at>=?',userId,startedAt)>=5;
      const quest=this.count("SELECT COUNT(*) n FROM quests WHERE submitter_user_id=? AND submitted_at>=? AND status NOT IN ('rejected','failed','canceled')",userId,startedAt)>=1;
      const game=this.count('SELECT COUNT(*) n FROM mini_game_awards WHERE user_id=? AND created_at>=?',userId,startedAt)>=1;
      const xp=this.count("SELECT COALESCE(SUM(amount),0) n FROM xp_ledger WHERE user_id=? AND amount>0 AND reason<>'admin-adjust' AND created_at>=?",userId,startedAt)>=100;
      const candidates=[pet&&'elio_friend',quest&&'quest_spark',game&&'community_player',xp&&'xp_collector'].filter((x):x is string=>typeof x==='string');
      const unlocked:WorldBadge[]=[];
      for(const id of candidates){const badge=BADGES.find(b=>b.id===id)!;if(db.prepare('INSERT OR IGNORE INTO community_world_badges(user_id,badge_id,unlocked_at) VALUES(?,?,?)').run(userId,id,now).changes){unlocked.push({...badge,unlockedAt:now});}}
      return unlocked;
    });
  }
}
