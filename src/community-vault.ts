import { randomInt, randomUUID } from 'node:crypto';
import type { ChatMessage } from './types.js';
import { FeatureStore } from './feature-store.js';
import type { OutboundChatMessage } from './chat-message-format.js';
import { communityConflictMessage, findActiveCommunityEventConflict } from './community-event-conflicts.js';

export interface CommunityVaultSettings {
  enabled: boolean; autoStart: boolean; durationMinutes: number; minActiveViewers: number;
  cooldownMinutes: number; participantXp: number; solverBonusXp: number;
}
export interface CommunityVaultHistoryItem {
  status:'opened'|'expired'|'canceled'|'active'; startedAt:number; endedAt:number; attempts:number;
  winnerName:string|null; awardedParticipants:number; xpAwarded:number; resultCode:string|null;
}
export const DEFAULT_COMMUNITY_VAULT_SETTINGS: CommunityVaultSettings = {
  enabled:false, autoStart:false, durationMinutes:3, minActiveViewers:3, cooldownMinutes:30, participantXp:5, solverBonusXp:0,
};
const clampInt=(value:unknown,fallback:number,min:number,max:number)=>Number.isInteger(value)?Math.min(max,Math.max(min,Number(value))):fallback;
export function normalizeVaultSettings(value:unknown):CommunityVaultSettings {
  const raw=value&&typeof value==='object'?value as Partial<CommunityVaultSettings>:{};
  return {enabled:raw.enabled===true,autoStart:raw.autoStart===true,durationMinutes:clampInt(raw.durationMinutes,3,1,10),
    minActiveViewers:clampInt(raw.minActiveViewers,3,3,30),cooldownMinutes:clampInt(raw.cooldownMinutes,30,10,180),
    participantXp:clampInt(raw.participantXp,5,0,20),solverBonusXp:clampInt(raw.solverBonusXp,0,0,20)};
}
interface RoundRow {id:string;secret_code:string;status:string;started_at:number;ends_at:number;attempts_count:number;is_auto:number;
  last_public_hint:string|null;last_public_hint_at:number|null;winner_name:string|null;updated_at:number;announcement_sent:number;}

/** Persisted shared code game. Guess strings are deliberately never stored. */
export class CommunityVault {
  private readonly activeViewers=new Map<string,{at:number;name:string}>();
  private readonly seenText=new Map<string,number>();
  constructor(private readonly store:FeatureStore,private readonly botUserId=''){}

  settings():CommunityVaultSettings{return normalizeVaultSettings(this.store.config('community_vault_settings',DEFAULT_COMMUNITY_VAULT_SETTINGS));}
  isActive(now=Date.now()):boolean{return Boolean(this.store.miniGameQuery(db=>db.prepare("SELECT 1 FROM community_vault_rounds WHERE status='active' AND ends_at>? LIMIT 1").get(now)));}
  cooldownRemainingMs(now=Date.now()):number {
    const previous=this.store.miniGameQuery(db=>db.prepare('SELECT started_at FROM community_vault_rounds ORDER BY started_at DESC LIMIT 1').get()) as {started_at:number}|undefined;
    return previous?Math.max(0,this.settings().cooldownMinutes*60_000-(now-previous.started_at)):0;
  }
  updateSettings(value:unknown):CommunityVaultSettings {
    const current=this.settings(),raw=value&&typeof value==='object'?value as Partial<CommunityVaultSettings>:{};
    const next=normalizeVaultSettings({...current,...raw});this.store.setConfig('community_vault_settings',next);return next;
  }
  observeActivity(message:ChatMessage,now=Date.now()):void {
    if((!this.settings().enabled&&!this.store.config<Partial<{wheelEnabled:boolean}>>('arcade_settings',{}).wheelEnabled)
      ||message.senderUserId===this.botUserId||message.senderUserId===message.broadcasterUserId||isRecognizedBot(message.senderLogin))return;
    const text=message.message.trim().replace(/\s+/gu,' ');
    if(!text||text.length>500)return;
    this.store.recordRecentChatActivity(message.senderUserId,cleanName(message.senderDisplayName),message.senderLogin.toLowerCase(),now);
    if(text.startsWith('!')||Array.from(text).length<3||text.length>300)return;
    const fingerprint=text.toLocaleLowerCase();if((this.seenText.get(fingerprint)||0)>now-30_000)return;
    this.seenText.set(fingerprint,now);this.activeViewers.set(message.senderUserId,{at:now,name:cleanName(message.senderDisplayName)});
    for(const [key,v] of this.activeViewers)if(v.at<now-5*60_000)this.activeViewers.delete(key);
    for(const [key,at] of this.seenText)if(at<now-60_000)this.seenText.delete(key);
  }
  activeViewerCount(now=Date.now()):number {
    for(const [key,v] of this.activeViewers)if(v.at<now-5*60_000)this.activeViewers.delete(key);
    return this.activeViewers.size;
  }
  autoStartReady(now:number,activeViewers:number,busy:boolean,lastMajorEventAt:number):boolean {
    const cfg=this.settings();if(!cfg.enabled||!cfg.autoStart||busy||this.store.miniGameQuery(db=>Boolean(findActiveCommunityEventConflict(db)))||activeViewers<cfg.minActiveViewers||now-lastMajorEventAt<5*60_000)return false;
    return this.store.miniGameQuery(db=>{
      const active=db.prepare("SELECT 1 FROM community_vault_rounds WHERE status='active'").get();if(active)return false;
      const previous=db.prepare("SELECT started_at,is_auto FROM community_vault_rounds ORDER BY started_at DESC LIMIT 1").get() as {started_at:number;is_auto:number}|undefined;
      if(previous&&now-previous.started_at<cfg.cooldownMinutes*60_000)return false;
      const lastAuto=db.prepare("SELECT started_at FROM community_vault_rounds WHERE is_auto=1 ORDER BY started_at DESC LIMIT 1").get() as {started_at:number}|undefined;
      return !lastAuto||now-lastAuto.started_at>=60*60_000;
    });
  }
  startManual(now=Date.now()):{ok:boolean;message:string} {return this.start(now,false);}
  startAutomatic(now=Date.now()):{ok:boolean;message:string} {return this.start(now,true);}
  private start(now:number,automatic:boolean):{ok:boolean;message:string} {
    const cfg=this.settings();if(!cfg.enabled)return {ok:false,message:'Der Community-Tresor ist ausgeschaltet.'};
    const secret=generateCode(),id=randomUUID();
    const created=this.store.miniGameTransaction(db=>{
      if(db.prepare("SELECT 1 FROM community_vault_rounds WHERE status='active'").get())return {ok:false,reason:'Der Community-Tresor läuft bereits.'};
      const conflict=findActiveCommunityEventConflict(db);if(conflict)return {ok:false,reason:communityConflictMessage(conflict)};
      const previous=db.prepare("SELECT started_at FROM community_vault_rounds ORDER BY started_at DESC LIMIT 1").get() as {started_at:number}|undefined;
      if(previous&&now-previous.started_at<cfg.cooldownMinutes*60_000)return {ok:false,reason:`Die Tresor-Wartezeit läuft noch ${Math.ceil((cfg.cooldownMinutes*60_000-(now-previous.started_at))/60_000)} Min.`};
      if(automatic){const lastAuto=db.prepare("SELECT started_at FROM community_vault_rounds WHERE is_auto=1 ORDER BY started_at DESC LIMIT 1").get() as {started_at:number}|undefined;
        if(lastAuto&&now-lastAuto.started_at<60*60_000)return {ok:false,reason:`Die automatische Tresor-Wartezeit läuft noch ${Math.ceil((60*60_000-(now-lastAuto.started_at))/60_000)} Min.`};}
      db.prepare(`INSERT INTO community_vault_rounds(id,secret_code,status,started_at,ends_at,is_auto,updated_at)
        VALUES(?,?,'active',?,?,?,?)`).run(id,secret,now,now+cfg.durationMinutes*60_000,automatic?1:0,now);return {ok:true as const};
    });
    if(!created.ok)return {ok:false,message:`Der Tresor kann gerade nicht starten: ${created.reason}`};
    const participantReward=cfg.participantXp>0?` Bei geknacktem Code: ab zwei eigenen Tipps bis zu ${cfg.participantXp} XP Teilnahmebelohnung; das Tageslimit gilt.`:' Für diese Runde gibt es keine Teilnahme-XP.';
    const solverReward=cfg.solverBonusXp>0?` Finder-Bonus: bis zu ${cfg.solverBonusXp} XP ab zwei eigenen Tipps; das Tageslimit gilt.`:'';
    return {ok:true,message:`🔐 COMMUNITY-TRESOR GEÖFFNET! Ein geheimer dreistelliger Code wartet. Rate mit !code XXX. XXX ist ein Platzhalter: Ersetze ihn durch drei selbst gewählte Ziffern. ⏱️ ${cfg.durationMinutes} Minuten. Pro Person: 3 Sekunden Abstand, höchstens 20 Tipps. Der erste richtige Tipp öffnet den Tresor.${participantReward}${solverReward}`};
  }
  cancel(now=Date.now()):boolean {
    return this.store.miniGameTransaction(db=>{const row=db.prepare("SELECT id FROM community_vault_rounds WHERE status='active'").get() as {id:string}|undefined;if(!row)return false;
      const changed=db.prepare("UPDATE community_vault_rounds SET status='canceled',updated_at=?,announcement_sent=1 WHERE id=? AND status='active'").run(now,row.id).changes;
      if(changed)db.prepare('DELETE FROM community_vault_attempts WHERE round_id=?').run(row.id);return Boolean(changed);});
  }
  guess(message:ChatMessage,args:string[],now=Date.now()):{recognized:boolean;privateHint?:string} {
    if(args.length!==1||!/^\d{3}$/u.test(args[0]||''))return {recognized:true,privateHint:'🔐 Bitte rate genau drei Ziffern: !code XXX. Ersetze XXX durch deine drei Ziffern.'};
    if(message.senderUserId===this.botUserId||message.senderUserId===message.broadcasterUserId)return {recognized:true};
    return this.store.miniGameTransaction(db=>{
      const round=db.prepare("SELECT * FROM community_vault_rounds WHERE status='active' ORDER BY started_at DESC LIMIT 1").get() as RoundRow|undefined;
      if(!round)return {recognized:true,privateHint:'Gerade ist kein Tresor offen.'};
      if(round.ends_at<=now){db.prepare("UPDATE community_vault_rounds SET status='expired',result_code=secret_code,updated_at=? WHERE id=? AND status='active'").run(now,round.id);
        db.prepare('DELETE FROM community_vault_attempts WHERE round_id=?').run(round.id);
        return {recognized:true,privateHint:'Die Zeit ist abgelaufen. Diese Runde zählt nicht mehr; der Bot veröffentlicht gleich die Auflösung.'};}
      const last=db.prepare('SELECT MAX(submitted_at) at FROM community_vault_attempts WHERE round_id=? AND user_id=?').get(round.id,message.senderUserId) as {at:number|null};
      if(last.at!==null&&now-last.at<3_000){const seconds=Math.max(1,Math.ceil((3_000-(now-last.at))/1_000));return {recognized:true,privateHint:`⏱️ Warte noch ${seconds} ${seconds===1?'Sekunde':'Sekunden'}, bevor du wieder rätst.`};}
      const attempts=db.prepare('SELECT COUNT(*) n FROM community_vault_attempts WHERE round_id=? AND user_id=?').get(round.id,message.senderUserId) as {n:number};
      if(attempts.n>=20)return {recognized:true,privateHint:'Du hast das Rundenlimit von 20 Versuchen erreicht.'};
      const clue=scoreGuess(round.secret_code,args[0]!);
      const inserted=db.prepare(`INSERT OR IGNORE INTO community_vault_attempts(event_id,round_id,user_id,display_name,exact_count,misplaced_count,submitted_at) VALUES(?,?,?,?,?,?,?)`)
        .run(message.eventId,round.id,message.senderUserId,cleanName(message.senderDisplayName),clue.exact,clue.misplaced,now);
      if(!inserted.changes)return {recognized:true};
      db.prepare('UPDATE community_vault_rounds SET attempts_count=attempts_count+1,updated_at=? WHERE id=? AND status=\'active\'').run(now,round.id);
      if(args[0]===round.secret_code){
        const opened=db.prepare("UPDATE community_vault_rounds SET status='opened',winner_user_id=?,winner_name=?,updated_at=? WHERE id=? AND status='active'").run(message.senderUserId,cleanName(message.senderDisplayName),now,round.id);
        const rewards=opened.changes?this.awardRound(db,round.id,round.secret_code,message.senderUserId,cleanName(message.senderDisplayName),now):{participantXp:0,solverXp:0};
        const total=rewards.participantXp+rewards.solverXp;
        return {recognized:true,privateHint:`🎉 Tresor geöffnet! Deine tatsächliche Auszahlung: +${total} XP${total===0?' (für dich wurde kein XP-Spielraum frei).':''}`};
      }
      const total=(db.prepare('SELECT attempts_count FROM community_vault_rounds WHERE id=?').get(round.id) as {attempts_count:number}).attempts_count;
      const personal=(db.prepare('SELECT COUNT(*) n FROM community_vault_attempts WHERE round_id=? AND user_id=?').get(round.id,message.senderUserId) as {n:number}).n;
      const eligibility=personal>=2?'Du erfüllst die Mindestteilnahme für Teilnahme-XP, falls jemand den Code knackt; das Tageslimit gilt.':'Noch ein gültiger Tipp nach dem Cooldown erfüllt die Mindestteilnahme für Teilnahme-XP, falls jemand den Code knackt.';
      return {recognized:true,privateHint:formatGuessFeedback(message.senderDisplayName,clue.exact,clue.misplaced,total,eligibility)};
    });
  }
  private awardRound(db:import('better-sqlite3').Database,roundId:string,code:string,winnerId:string,winnerName:string,now:number):{participantXp:number;solverXp:number} {
    const cfg=this.settings(),cap=Number(this.store.config<{dailyGameCap?:number}>('xp_settings',{dailyGameCap:100}).dailyGameCap??100);
    let participantXp=0,solverXp=0;
    const participants=db.prepare(`SELECT user_id,MAX(display_name) display_name,COUNT(*) attempts FROM community_vault_attempts WHERE round_id=? GROUP BY user_id HAVING COUNT(*)>=2`).all(roundId) as Array<{user_id:string;display_name:string;attempts:number}>;
    const winnerAttempts=db.prepare('SELECT COUNT(*) n FROM community_vault_attempts WHERE round_id=? AND user_id=?').get(roundId,winnerId) as {n:number};
    for(const p of participants){const claim=db.prepare("INSERT OR IGNORE INTO community_vault_awards(round_id,user_id,award_type,xp) VALUES(?,?,'participant',0)").run(roundId,p.user_id);
      if(claim.changes&&cfg.participantXp>0){const actual=this.store.awardXp(`vault:${roundId}:${p.user_id}:participant`,p.user_id,p.display_name,cfg.participantXp,'bonus:community-vault',now,cap);db.prepare("UPDATE community_vault_awards SET xp=? WHERE round_id=? AND user_id=? AND award_type='participant'").run(actual,roundId,p.user_id);if(p.user_id===winnerId)participantXp=actual;}}
    if(cfg.solverBonusXp>0&&winnerAttempts.n>=2){const claim=db.prepare("INSERT OR IGNORE INTO community_vault_awards(round_id,user_id,award_type,xp) VALUES(?,?,'solver',0)").run(roundId,winnerId);
      if(claim.changes){solverXp=this.store.awardXp(`vault:${roundId}:${winnerId}:solver`,winnerId,winnerName,cfg.solverBonusXp,'bonus:community-vault-solver',now,cap);db.prepare("UPDATE community_vault_awards SET xp=? WHERE round_id=? AND user_id=? AND award_type='solver'").run(solverXp,roundId,winnerId);}}
    // Keep no guess history or personal clues after settlement.
    db.prepare('DELETE FROM community_vault_attempts WHERE round_id=?').run(roundId);
    db.prepare('UPDATE community_vault_rounds SET result_code=? WHERE id=?').run(code,roundId);
    return {participantXp,solverXp};
  }
  tickMessages(now=Date.now()):OutboundChatMessage[] {
    return this.store.miniGameTransaction(db=>{
      db.prepare("UPDATE community_vault_rounds SET status='expired',updated_at=? WHERE status='active' AND ends_at<=?").run(now,now);
      const expired=db.prepare("SELECT id,secret_code FROM community_vault_rounds WHERE status='expired' AND announcement_sent=0 ORDER BY updated_at DESC LIMIT 1").get() as {id:string;secret_code:string}|undefined;
      if(expired){db.prepare('UPDATE community_vault_rounds SET result_code=?,announcement_sent=1 WHERE id=?').run(expired.secret_code,expired.id);db.prepare('DELETE FROM community_vault_attempts WHERE round_id=?').run(expired.id);
        return [{message:`⏰ Die Tresor-Zeit ist abgelaufen. Der Code war ${expired.secret_code}. Es wurden keine XP vergeben.`,category:'vault'}];}
      const opened=db.prepare("SELECT id,winner_name,attempts_count FROM community_vault_rounds WHERE status='opened' AND announcement_sent=0 ORDER BY updated_at DESC LIMIT 1").get() as {id:string;winner_name:string;attempts_count:number}|undefined;
      if(opened){db.prepare('UPDATE community_vault_rounds SET announcement_sent=1 WHERE id=?').run(opened.id);const awards=db.prepare('SELECT COUNT(DISTINCT user_id) participants,COALESCE(SUM(xp),0) xp FROM community_vault_awards WHERE round_id=?').get(opened.id) as {participants:number;xp:number};const participants=awards.participants===1?'1 qualifizierte Person':`${awards.participants} qualifizierte Personen`;return [{message:`🎉 Der Community-Tresor ist offen! @${opened.winner_name} hat den Code geknackt. ${opened.attempts_count} Tipps · ${participants} · ${awards.xp} XP tatsächlich ausgezahlt.`,category:'vault'}];}
      const round=db.prepare("SELECT id,attempts_count,last_public_hint,last_public_hint_at FROM community_vault_rounds WHERE status='active' ORDER BY started_at DESC LIMIT 1").get() as {id:string;attempts_count:number;last_public_hint:string|null;last_public_hint_at:number|null}|undefined;
      if(round&&round.attempts_count>=5&&round.attempts_count%5===0&&(!round.last_public_hint_at||now-round.last_public_hint_at>=30_000)){
        const best=db.prepare('SELECT exact_count,misplaced_count FROM community_vault_attempts WHERE round_id=? ORDER BY exact_count DESC,misplaced_count DESC LIMIT 1').get(round.id) as {exact_count:number;misplaced_count:number}|undefined;
        const hint=best?`${best.exact_count} richtige Stelle(n), ${best.misplaced_count} weitere Ziffer(n) enthalten, aber falsch positioniert`:'Noch kein Hinweis';
        if(best&&hint!==round.last_public_hint){db.prepare('UPDATE community_vault_rounds SET last_public_hint=?,last_public_hint_at=?,updated_at=? WHERE id=?').run(hint,now,now,round.id);
          return [{message:`Gemeinsamer Hinweis nach ${round.attempts_count} Versuchen: ${hint}.`,category:'vault'}];}
      }
      return [];
    });
  }
  publicSnapshot(now=Date.now()):Record<string,unknown>{return this.store.widgetSnapshot('vault',now);}
  history(limit=10):CommunityVaultHistoryItem[]{
    const rows=this.store.miniGameQuery(db=>db.prepare(`SELECT r.status,r.started_at,r.updated_at,r.attempts_count,r.winner_name,r.result_code,
      COUNT(DISTINCT a.user_id) awarded_participants,COALESCE(SUM(a.xp),0) xp_awarded
      FROM community_vault_rounds r LEFT JOIN community_vault_awards a ON a.round_id=r.id
      GROUP BY r.id ORDER BY r.started_at DESC LIMIT ?`).all(Math.max(1,Math.min(20,Math.trunc(limit)))) as Array<{
        status:'opened'|'expired'|'canceled'|'active';started_at:number;updated_at:number;attempts_count:number;winner_name:string|null;result_code:string|null;awarded_participants:number;xp_awarded:number;
      }>);
    return rows.map(r=>({status:r.status,startedAt:r.started_at,endedAt:r.updated_at,attempts:r.attempts_count,winnerName:r.winner_name,
      awardedParticipants:r.awarded_participants,xpAwarded:r.xp_awarded,resultCode:r.status==='active'?null:r.result_code}));
  }
  personalHint(userId:string):Record<string,unknown>|null {
    return this.store.miniGameQuery(db=>{const round=db.prepare("SELECT id FROM community_vault_rounds WHERE status='active' ORDER BY started_at DESC LIMIT 1").get() as {id:string}|undefined;if(!round)return null;
      const row=db.prepare('SELECT exact_count,misplaced_count,submitted_at FROM community_vault_attempts WHERE round_id=? AND user_id=? ORDER BY submitted_at DESC LIMIT 1').get(round.id,userId) as {exact_count:number;misplaced_count:number;submitted_at:number}|undefined;
      return row?{exact:row.exact_count,misplaced:row.misplaced_count,submittedAt:row.submitted_at}:null;});
  }
}
export function scoreGuess(secret:string,guess:string):{exact:number;misplaced:number}{
  let exact=0,contained=0;const counts=new Map<string,number>();for(const digit of secret)counts.set(digit,(counts.get(digit)||0)+1);
  for(let i=0;i<3;i++)if(secret[i]===guess[i])exact++;
  for(const digit of guess){const n=counts.get(digit)||0;if(n>0){contained++;counts.set(digit,n-1);}}
  return {exact,misplaced:contained-exact};
}
/** Chat-visible feedback; each code digit is counted at most once. */
export function formatGuessFeedback(displayName:string,exact:number,misplaced:number,total:number,eligibility:string):string {
  const absent=Math.max(0,3-exact-misplaced),name=cleanName(displayName);
  return `🔎 ${name}: Dein Tipp wurde geprüft! ✅ ${countText(exact,'Ziffer steht','Ziffern stehen')} an der richtigen Stelle. 🔄 ${countText(misplaced,'weitere Ziffer ist','weitere Ziffern sind')} im Code, aber falsch positioniert. ❌ ${countText(absent,'Ziffer kommt','Ziffern kommen')} nicht im Code vor. ${countText(total,'Tipp insgesamt','Tipps insgesamt')}. ${eligibility}`;
}
function countText(count:number,singular:string,plural:string):string{return `${count} ${count===1?singular:plural}`;}
function generateCode():string {const digits=Array.from({length:10},(_,i)=>String(i));for(let i=digits.length-1;i>0;i--){const j=randomInt(i+1);[digits[i],digits[j]]=[digits[j]!,digits[i]!];}return digits.slice(0,3).join('');}
function cleanName(name:string):string{return name.replace(/[^\p{L}\p{N}_-]/gu,'').slice(0,32)||'Zuschauer';}
const KNOWN_BOT_LOGINS=new Set(['nightbot','streamelements','streamlabs','moobot','fossabot','wizebot','commanderroot','sery_bot','serybot']);
function isRecognizedBot(login:string):boolean{return KNOWN_BOT_LOGINS.has(login.trim().toLowerCase());}
