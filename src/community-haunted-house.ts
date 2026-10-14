import type BetterSqlite3 from 'better-sqlite3';
import { FeatureStore } from './feature-store.js';

export const HAUNTED_HOUSE_GOAL=100;
export const HAUNTED_HOUSE_ROOMS=[
  {id:'hall',name:'Die knarrende Eingangshalle',threshold:1,decoration:'🕯️ Ein flackernder Kronleuchter',surprise:'Im Spiegel winkt eine kleine Pfote zurück.'},
  {id:'pumpkin-room',name:'Die Kürbiskammer',threshold:25,decoration:'🎃 Leuchtende Kürbislaternen',surprise:'Einer der Kürbisse trägt Elios Hexenhut.'},
  {id:'attic',name:'Der verzauberte Dachboden',threshold:HAUNTED_HOUSE_GOAL,decoration:'🌙 Ein Sternenfenster und ein Geister-Mobile',surprise:'Elio bewacht hier einen geheimen Vorrat an Leckerlis.'},
] as const;

export interface HauntedHouseSnapshot {
  active:boolean;seasonYear:number|null;progress:number;goal:number;contributors:number;completed:boolean;
  rooms:Array<{id:string;name:string;threshold:number;decoration:string;surprise:string;unlocked:boolean}>;
  personal:{visits:number;achievements:string[]}|null;
}

interface ActiveSeason {id:string;year:number;startedAt:number;}

/** Adds one communal lantern for an already accepted Halloween play; it never changes event points or XP. */
export class CommunityHauntedHouse {
  constructor(private readonly store:FeatureStore){}

  recordAcceptedPlay(eventId:string,userId:string,now:number):{progress:number;justCompleted:boolean}|undefined{
    return this.store.miniGameTransaction(db=>{
      const season=this.activeSeason(db,now);if(!season)return undefined;
      db.prepare('INSERT OR IGNORE INTO haunted_house_seasons(season_id,season_year,started_at,last_contribution_at) VALUES(?,?,?,?)')
        .run(season.id,season.year,season.startedAt,now);
      const inserted=db.prepare('INSERT OR IGNORE INTO haunted_house_contributions(event_id,season_id,user_id,contributed_at) VALUES(?,?,?,?)')
        .run(eventId,season.id,userId,now);
      const row=db.prepare('SELECT COUNT(*) AS progress,COUNT(DISTINCT user_id) AS contributors FROM haunted_house_contributions WHERE season_id=?').get(season.id) as {progress:number;contributors:number};
      if(!inserted.changes)return {progress:row.progress,justCompleted:false};
      db.prepare('UPDATE haunted_house_seasons SET last_contribution_at=? WHERE season_id=?').run(now,season.id);
      this.awardPersonalBadges(db,userId,now);
      if(row.progress>=HAUNTED_HOUSE_GOAL){
        const users=db.prepare('SELECT DISTINCT user_id FROM haunted_house_contributions WHERE season_id=?').all(season.id) as Array<{user_id:string}>;
        const add=db.prepare('INSERT OR IGNORE INTO community_world_badges(user_id,badge_id,unlocked_at) VALUES(?,?,?)');
        for(const user of users)add.run(user.user_id,'haunted_house_crew',now);
      }
      return {progress:row.progress,justCompleted:inserted.changes===1&&row.progress===HAUNTED_HOUSE_GOAL};
    });
  }

  snapshot(userId:string|undefined,now:number):HauntedHouseSnapshot{
    const event=this.store.event('halloween'),legacyActive=this.store.miniGameQuery(db=>Boolean((db.prepare('SELECT active FROM game_state WHERE id=1').get() as {active:number}|undefined)?.active));
    const active=Boolean(event?.active&&legacyActive&&(!event.startAt||now>=event.startAt)&&(!event.endAt||now<event.endAt));
    const current=active&&event?this.seasonFor(event,now):undefined;
    const season=current||this.store.miniGameQuery(db=>{
      const row=db.prepare('SELECT season_id AS id,season_year AS year,started_at AS startedAt FROM haunted_house_seasons ORDER BY last_contribution_at DESC LIMIT 1').get() as ActiveSeason|undefined;
      return row;
    });
    if(!season)return {active,seasonYear:null,progress:0,goal:HAUNTED_HOUSE_GOAL,contributors:0,completed:false,rooms:HAUNTED_HOUSE_ROOMS.map(room=>({...room,unlocked:false})),personal:userId?{visits:0,achievements:[]}:null};
    const aggregate=this.store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) AS progress,COUNT(DISTINCT user_id) AS contributors FROM haunted_house_contributions WHERE season_id=?').get(season.id) as {progress:number;contributors:number});
    const personal=userId?this.store.miniGameQuery(db=>{
      const visits=(db.prepare('SELECT COUNT(*) AS n FROM haunted_house_contributions WHERE user_id=?').get(userId) as {n:number}).n;
      const badges=db.prepare("SELECT badge_id FROM community_world_badges WHERE user_id=? AND badge_id LIKE 'haunted_%'").all(userId) as Array<{badge_id:string}>;
      return {visits,achievements:badges.map(x=>x.badge_id)};
    }):null;
    return {active,seasonYear:season.year,progress:aggregate.progress,goal:HAUNTED_HOUSE_GOAL,contributors:aggregate.contributors,
      completed:aggregate.progress>=HAUNTED_HOUSE_GOAL,rooms:HAUNTED_HOUSE_ROOMS.map(room=>({...room,unlocked:aggregate.progress>=room.threshold})),personal};
  }

  private activeSeason(db:BetterSqlite3.Database,now:number):ActiveSeason|undefined{
    const event=db.prepare("SELECT start_at AS startAt,end_at AS endAt,timezone,active FROM seasonal_events WHERE id='halloween'").get() as
      {startAt:number|null;endAt:number|null;timezone:string;active:number}|undefined;
    const game=db.prepare('SELECT active FROM game_state WHERE id=1').get() as {active:number}|undefined;
    if(!event||!event.active||!game?.active||(event.startAt&&now<event.startAt)||(event.endAt&&now>=event.endAt))return undefined;
    const basis=event.startAt??now,year=Number(new Intl.DateTimeFormat('en',{timeZone:event.timezone,year:'numeric'}).format(basis));
    return {id:event.startAt?`halloween:${event.startAt}`:`halloween:${year}`,year,startedAt:event.startAt??now};
  }

  private seasonFor(event:NonNullable<ReturnType<FeatureStore['event']>>,now:number):ActiveSeason{
    const basis=event.startAt??now,year=Number(new Intl.DateTimeFormat('en',{timeZone:event.timezone,year:'numeric'}).format(basis));
    return {id:event.startAt?`halloween:${event.startAt}`:`halloween:${year}`,year,startedAt:event.startAt??now};
  }

  private awardPersonalBadges(db:BetterSqlite3.Database,userId:string,now:number):void{
    const visits=(db.prepare('SELECT COUNT(*) AS n FROM haunted_house_contributions WHERE user_id=?').get(userId) as {n:number}).n;
    const add=db.prepare('INSERT OR IGNORE INTO community_world_badges(user_id,badge_id,unlocked_at) VALUES(?,?,?)');
    if(visits>=1)add.run(userId,'haunted_visitor',now);
    if(visits>=5)add.run(userId,'haunted_scout',now);
  }
}
