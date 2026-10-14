import { randomUUID } from 'node:crypto';
import type { FeatureStore } from './feature-store.js';

export interface VipSettings {enabled:boolean;loungeEnabled:boolean;elioEnabled:boolean;chaosEnabled:boolean;challengesEnabled:boolean;achievementsEnabled:boolean;requestsPerVipPerStream:number;globalCooldownMinutes:number;challengeCooldownHours:number;}
export const DEFAULT_VIP_SETTINGS:VipSettings={enabled:false,loungeEnabled:false,elioEnabled:false,chaosEnabled:false,challengesEnabled:false,achievementsEnabled:false,requestsPerVipPerStream:1,globalCooldownMinutes:10,challengeCooldownHours:168};
export type VipChaosAction='elio-crown'|'oracle'|'vault-alarm';
const ACHIEVEMENTS:Record<string,{name:string;description:string;emoji:string}>={acy_vip:{name:'ACY VIP',description:'Für einen offiziell verifizierten Twitch-VIP.',emoji:'👑'},royal_cat_friend:{name:'Königlicher Katzenfreund',description:'Fünf gültige Elio-Spielaktionen als VIP.',emoji:'🐱'},vip_chaos_starter:{name:'VIP-Chaos-Stifter',description:'Eine freigegebene VIP-Aktion wurde ausgeführt.',emoji:'🎡'},royal_questgiver:{name:'Königlicher Questgeber',description:'Eine VIP-Challenge wurde von der Moderation freigegeben.',emoji:'🎮'}};
export class VipExperience {
  constructor(private readonly store:FeatureStore){}
  settings():VipSettings{return {...DEFAULT_VIP_SETTINGS,...this.store.config<Partial<VipSettings>>('vip_experience_settings',{})};}
  updateSettings(input:unknown):VipSettings{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('VIP-Einstellungen sind ungültig.');
    const raw=input as Record<string,unknown>,allowed=new Set(Object.keys(DEFAULT_VIP_SETTINGS));if(Object.keys(raw).some(k=>!allowed.has(k)))throw new Error('VIP-Einstellungen enthalten unbekannte Felder.');
    const current=this.settings(),next={...current};for(const key of ['enabled','loungeEnabled','elioEnabled','chaosEnabled','challengesEnabled','achievementsEnabled'] as const){if(raw[key]!==undefined){if(typeof raw[key]!=='boolean')throw new Error('VIP-Schalter müssen Ein oder Aus sein.');next[key]=raw[key] as boolean;}}
    for(const [key,min,max] of [['requestsPerVipPerStream',1,1],['globalCooldownMinutes',1,240],['challengeCooldownHours',24,720]] as const){if(raw[key]!==undefined){const n=Number(raw[key]);if(!Number.isInteger(n)||n<min||n>max)throw new Error('VIP-Limits liegen außerhalb des erlaubten Bereichs.');(next as unknown as Record<string,unknown>)[key]=n;}}
    this.store.setConfig('vip_experience_settings',next);return next;
  }
  pendingRequests(limit=50):Array<Record<string,unknown>>{return this.store.miniGameQuery(db=>db.prepare("SELECT id,stream_id streamId,user_id userId,display_name displayName,action,status,created_at createdAt FROM vip_chaos_requests WHERE status IN ('pending','processing') ORDER BY created_at LIMIT ?").all(Math.max(1,Math.min(100,limit))) as Array<Record<string,unknown>>);}
  requestChaos(userId:string,displayName:string,streamId:string,action:VipChaosAction,now=Date.now()):{ok:boolean;id?:string;reason?:string}{
    if(!/^\d{1,30}$/u.test(userId)||!streamId||!['elio-crown','oracle','vault-alarm'].includes(action))return {ok:false,reason:'Ungültige Anfrage.'};
    const s=this.settings();if(!s.enabled||!s.loungeEnabled||!s.chaosEnabled)return {ok:false,reason:'VIP-Chaos ist gerade deaktiviert.'};
    const id=randomUUID();return this.store.miniGameTransaction(db=>{
      const active=db.prepare("SELECT 1 FROM vip_chaos_requests WHERE status IN ('pending','processing') LIMIT 1").get();if(active)return {ok:false,reason:'Es wartet bereits eine VIP-Chaos-Anfrage auf die Moderation.'};
      const last=db.prepare("SELECT created_at createdAt FROM vip_chaos_requests WHERE status IN ('processing','approved') ORDER BY created_at DESC LIMIT 1").get() as {createdAt:number}|undefined;
      if(last&&now-last.createdAt<s.globalCooldownMinutes*60_000)return {ok:false,reason:`Der globale VIP-Cooldown läuft noch ${Math.ceil((s.globalCooldownMinutes*60_000-(now-last.createdAt))/60_000)} Min.`};
      try{db.prepare("INSERT INTO vip_chaos_requests(id,stream_id,user_id,display_name,action,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(id,streamId,userId,String(displayName).slice(0,32),action,now);}
      catch{return {ok:false,reason:'Du hast für diesen Stream bereits eine VIP-Chaos-Anfrage gestellt.'};}
      return {ok:true,id};
    });
  }
  decideRequest(id:string,actorId:string,approve:boolean,now=Date.now()):Record<string,unknown>|undefined{
    return this.store.miniGameTransaction(db=>{
      const request=db.prepare("SELECT id,stream_id streamId,user_id userId,display_name displayName,action,status FROM vip_chaos_requests WHERE id=?").get(id) as Record<string,unknown>|undefined;
      if(!request||request.status!=='pending')return undefined;
      const changed=db.prepare("UPDATE vip_chaos_requests SET status=?,decided_by=?,decided_at=? WHERE id=? AND status='pending'").run(approve?'processing':'rejected',actorId,now,id).changes;
      return changed?request:undefined;
    });
  }
  finishRequest(id:string,success:boolean,now=Date.now()):void{this.store.miniGameTransaction(db=>db.prepare("UPDATE vip_chaos_requests SET status=?,executed_at=? WHERE id=? AND status='processing'").run(success?'approved':'failed',success?now:null,id));}
  recentRequests(userId:string,limit=10):Array<Record<string,unknown>>{return this.store.miniGameQuery(db=>db.prepare('SELECT id,action,status,created_at createdAt,decided_at decidedAt FROM vip_chaos_requests WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(userId,Math.max(1,Math.min(20,limit))) as Array<Record<string,unknown>>);}
  submitChallenge(userId:string,questId:string,now=Date.now()):boolean{return this.store.miniGameTransaction(db=>{const settings=this.settings();if(!settings.enabled||!settings.challengesEnabled)return false;const recent=db.prepare('SELECT created_at createdAt FROM vip_challenges WHERE submitter_user_id=? ORDER BY created_at DESC LIMIT 1').get(userId) as {createdAt:number}|undefined;if(recent&&now-recent.createdAt<settings.challengeCooldownHours*3_600_000)return false;db.prepare('INSERT INTO vip_challenges(quest_id,submitter_user_id,created_at) VALUES(?,?,?)').run(questId,userId,now);return true;});}
  canSubmitChallenge(userId:string,now=Date.now()):boolean{const s=this.settings();if(!s.enabled||!s.challengesEnabled)return false;const last=this.store.miniGameQuery(db=>db.prepare('SELECT created_at createdAt FROM vip_challenges WHERE submitter_user_id=? ORDER BY created_at DESC LIMIT 1').get(userId) as {createdAt:number}|undefined);return !last||now-last.createdAt>=s.challengeCooldownHours*3_600_000;}
  challengeRows(limit=50):Array<Record<string,unknown>>{return this.store.miniGameQuery(db=>db.prepare(`SELECT v.quest_id questId,v.submitter_user_id submitterUserId,v.created_at createdAt,v.featured_until featuredUntil,q.title,q.status,q.display_name displayName FROM vip_challenges v LEFT JOIN quests q ON q.id=v.quest_id ORDER BY v.created_at DESC LIMIT ?`).all(Math.max(1,Math.min(100,limit))) as Array<Record<string,unknown>>);}
  challengeForQuest(questId:string):{submitterUserId:string}|undefined{return this.store.miniGameQuery(db=>db.prepare('SELECT submitter_user_id submitterUserId FROM vip_challenges WHERE quest_id=?').get(questId) as {submitterUserId:string}|undefined);}
  featureChallenge(questId:string,actorId:string,until:number,now=Date.now()):boolean{return this.store.miniGameTransaction(db=>{const updated=db.prepare("UPDATE vip_challenges SET featured_until=? WHERE quest_id=? AND EXISTS(SELECT 1 FROM quests WHERE id=? AND status='approved')").run(until,questId,questId).changes;if(updated)this.store.adminAudit(actorId,'vip-challenge-feature',questId,{until},now);return updated>0;});}
  awardAchievement(userId:string,id:string,now=Date.now()):boolean{if(!ACHIEVEMENTS[id])return false;return this.store.miniGameTransaction(db=>db.prepare('INSERT OR IGNORE INTO vip_achievements(user_id,achievement_id,earned_at) VALUES(?,?,?)').run(userId,id,now).changes>0);}
  achievements(userId:string):Array<{id:string;name:string;description:string;emoji:string;earnedAt:number}>{return this.store.miniGameQuery(db=>(db.prepare('SELECT achievement_id achievementId,earned_at earnedAt FROM vip_achievements WHERE user_id=? ORDER BY earned_at DESC').all(userId) as Array<{achievementId:string;earnedAt:number}>).flatMap(row=>{const a=ACHIEVEMENTS[row.achievementId];return a?[{id:row.achievementId,...a,earnedAt:row.earnedAt}]:[]}));}
  asyncRecordState(userId:string):{requests:Array<Record<string,unknown>>;achievements:Array<{id:string;name:string;description:string;emoji:string;earnedAt:number}>;challengeCount:number}{return {requests:this.recentRequests(userId),achievements:this.achievements(userId),challengeCount:this.store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM vip_challenges WHERE submitter_user_id=?').get(userId) as {n:number}).n)};}
  recordPetPlay(userId:string,eventId:string,now=Date.now()):boolean{const count=this.store.miniGameTransaction(db=>{db.prepare('INSERT OR IGNORE INTO vip_pet_interactions(event_id,user_id,created_at) VALUES(?,?,?)').run(eventId,userId,now);return (db.prepare('SELECT COUNT(*) n FROM vip_pet_interactions WHERE user_id=?').get(userId) as {n:number}).n;});if(count<5)return false;return this.awardAchievement(userId,'royal_cat_friend',now);}
  recordChaosAchievement(userId:string,now=Date.now()):boolean{return this.awardAchievement(userId,'vip_chaos_starter',now);}
  recordQuestAchievement(userId:string,now=Date.now()):boolean{return this.awardAchievement(userId,'royal_questgiver',now);}
  static badgeDefinition(id:string){return ACHIEVEMENTS[id]?{id,...ACHIEVEMENTS[id]}:undefined;}
}
