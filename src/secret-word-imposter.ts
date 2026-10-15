import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig, ChatMessage } from './types.js';
import { FeatureStore } from './feature-store.js';

export type WordImposterPhase='registration'|'hints'|'discussion'|'voting'|'guess'|'results'|'finished'|'canceled';
export interface WordImposterSettings {
  enabled:boolean;minPlayers:number;maxPlayers:number;registrationMs:number;hintMs:number;discussionMs:number;votingMs:number;guessMs:number;
  cooldownMs:number;participationXp:number;winXp:number;allowLastGuess:boolean;
}
export const DEFAULT_WORD_IMPOSTER_SETTINGS:WordImposterSettings={enabled:false,minPlayers:4,maxPlayers:20,registrationMs:120_000,hintMs:30_000,discussionMs:90_000,votingMs:45_000,guessMs:30_000,cooldownMs:600_000,participationXp:5,winXp:20,allowLastGuess:true};
const WORDS=['Abenteuer','Ananas','Astronaut','Badezimmer','Berg','Bibliothek','Brille','Dinosaurier','Drachen','Eiscreme','Fahrrad','Feuerwerk','Gitarre','Gewitter','Kaffee','Kaktus','Kamera','Kaugummi','Kopfhörer','Krokodil','Laterne','Mond','Museum','Pfannkuchen','Regenbogen','Schneemann','Schokolade','Sonnenbrille','Taschenlampe','Wasserfall','Wolke','Zahnbürste'];
const LIVE="phase IN ('registration','hints','discussion','voting','guess','results')";
const clean=(value:string,max=48)=>Array.from(value.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim()).slice(0,max).join('')||'Unbekannt';
const normalized=(value:string)=>value.normalize('NFC').toLocaleLowerCase('de-DE').trim();
type Db=import('better-sqlite3').Database;
type Result={ok:boolean;message:string;status?:number};
const ok=(message:string):Result=>({ok:true,message});
const fail=(message:string,status=409):Result=>({ok:false,message,status});
interface RoundRow{id:string;phase:WordImposterPhase;secret_word:string;imposter_id:string|null;started_at:number;phase_ends_at:number;updated_at:number;min_players:number;max_players:number;turn_index:number;result_json:string|null;}
interface PlayerRow{user_id:string;login:string;display_name:string;role:string;turn_order:number|null;}

/** Separate persisted secret-word game. Public snapshots are deliberately role- and word-free until results. */
export class SecretWordImposter {
  constructor(private readonly store:FeatureStore,private readonly config:AppConfig,private readonly random:(max:number)=>number=randomInt){}

  settings():WordImposterSettings{
    const saved=this.store.config<Partial<WordImposterSettings>>('word_imposter_settings',{});
    return {...DEFAULT_WORD_IMPOSTER_SETTINGS,...saved};
  }
  updateSettings(value:WordImposterSettings):void{
    if(!value||typeof value!=='object')throw new Error('Wortspiel-Einstellungen fehlen.');
    const int=(n:number,min:number,max:number)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
    if(typeof value.enabled!=='boolean'||!int(value.minPlayers,3,20)||!int(value.maxPlayers,value.minPlayers,50)
      ||!int(value.registrationMs,10_000,3_600_000)||!int(value.hintMs,5_000,300_000)||!int(value.discussionMs,10_000,600_000)
      ||!int(value.votingMs,10_000,300_000)||!int(value.guessMs,5_000,120_000)||!int(value.cooldownMs,0,86_400_000)
      ||!int(value.participationXp,0,1000)||!int(value.winXp,0,1000)||typeof value.allowLastGuess!=='boolean')throw new Error('Wortspiel-Einstellungen sind ungültig.');
    this.store.setConfig('word_imposter_settings',value);
  }

  start(actor:string,now=Date.now()):Result{
    const cfg=this.settings();if(!cfg.enabled)return fail('🎭 Das Geheimwort-Spiel ist ausgeschaltet.',403);
    const recent=this.store.miniGameQuery(db=>db.prepare("SELECT updated_at FROM word_imposter_rounds WHERE phase IN ('finished','canceled') ORDER BY updated_at DESC LIMIT 1").get() as {updated_at:number}|undefined);
    if(recent&&now-recent.updated_at<cfg.cooldownMs)return fail('⏳ Das Geheimwort-Spiel hat noch Cooldown.');
    try{return this.store.miniGameTransaction(db=>{
      if(db.prepare(`SELECT 1 FROM word_imposter_rounds WHERE ${LIVE}`).get()||db.prepare("SELECT 1 FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting','results')").get()
        ||db.prepare("SELECT 1 FROM detective_rounds WHERE phase IN ('playing','results')").get()
        ||db.prepare("SELECT 1 FROM quests WHERE status='active'").get()||db.prepare("SELECT 1 FROM polls WHERE status='active' AND ends_at>?").get(now)
        ||db.prepare("SELECT 1 FROM boss_fights WHERE status='active'").get()||db.prepare("SELECT 1 FROM mystery_drops WHERE status IN ('announced','claiming','resolving')").get()
        ||db.prepare("SELECT 1 FROM chaos_wheel_spins WHERE status='active'").get()||db.prepare("SELECT 1 FROM community_vault_rounds WHERE status='active'").get())throw Error('busy');
      const id=randomUUID();db.prepare("INSERT INTO word_imposter_rounds(id,phase,secret_word,started_at,phase_ends_at,updated_at,min_players,max_players) VALUES(?,'registration','',?,?,?,?,?)")
        .run(id,now,now+cfg.registrationMs,now,cfg.minPlayers,cfg.maxPlayers);
      this.store.adminAudit(actor,'word-imposter-start',id,{minPlayers:cfg.minPlayers,maxPlayers:cfg.maxPlayers},now);
      return ok(`🎭 Geheimwort-Imposter: Anmeldung offen. Mit !joinword oder im Portal mitspielen: https://twitch.gater-app.de/community/imposter-word · ${Math.ceil(cfg.registrationMs/1000)} Sekunden.`);
    });}catch{return fail('🎭 Es läuft bereits ein Community-Spiel.');}
  }

  join(user:{userId:string;login:string;displayName:string},now=Date.now()):Result{
    return this.store.miniGameTransaction(db=>{
      const round=db.prepare("SELECT id,max_players FROM word_imposter_rounds WHERE phase='registration' AND phase_ends_at>? ORDER BY started_at DESC LIMIT 1").get(now) as {id:string;max_players:number}|undefined;
      if(!round)return fail('🎭 Gerade ist keine Geheimwort-Anmeldung offen.');
      const count=(db.prepare('SELECT COUNT(*) n FROM word_imposter_players WHERE round_id=?').get(round.id) as {n:number}).n;
      if(count>=round.max_players)return fail('🎭 Die Runde ist bereits voll.');
      const inserted=db.prepare("INSERT OR IGNORE INTO word_imposter_players(round_id,user_id,login,display_name,role,joined_at) VALUES(?,?,?,?,'pending',?)")
        .run(round.id,user.userId,clean(user.login.toLowerCase(),32),clean(user.displayName,48),now).changes;
      return inserted?ok('🎭 Du bist für das Geheimwort-Spiel angemeldet.'):fail('🎭 Du bist bereits in dieser Runde angemeldet.');
    });
  }

  leave(userId:string):Result{
    return this.store.miniGameTransaction(db=>{
      const round=db.prepare("SELECT id FROM word_imposter_rounds WHERE phase='registration' ORDER BY started_at DESC LIMIT 1").get() as {id:string}|undefined;
      if(!round)return fail('🎭 Die Anmeldung ist bereits geschlossen.');
      return db.prepare('DELETE FROM word_imposter_players WHERE round_id=? AND user_id=?').run(round.id,userId).changes?ok('🎭 Du hast die Anmeldung verlassen.'):fail('🎭 Du bist nicht angemeldet.');
    });
  }

  startRoles(actor:string,now=Date.now()):Result{
    return this.store.miniGameTransaction(db=>this.distribute(db,actor,now));
  }
  private distribute(db:Db,actor:string,now:number):Result{
    const round=db.prepare("SELECT id FROM word_imposter_rounds WHERE phase='registration' ORDER BY started_at DESC LIMIT 1").get() as {id:string}|undefined;
    if(!round)return fail('🎭 Keine offene Geheimwort-Anmeldung.');
    const players=db.prepare('SELECT user_id FROM word_imposter_players WHERE round_id=? ORDER BY joined_at,user_id').all(round.id) as Array<{user_id:string}>;
    const minimum=(db.prepare('SELECT min_players FROM word_imposter_rounds WHERE id=?').get(round.id) as {min_players:number}).min_players;
    if(players.length<minimum)return fail(`🎭 Mindestens ${minimum} Teilnehmende werden gebraucht (aktuell ${players.length}).`);
    const cfg=this.settings();
    const imposter=players[this.pick(players.length)]!.user_id,word=WORDS[this.pick(WORDS.length)]!;
    players.forEach((p,index)=>db.prepare("UPDATE word_imposter_players SET role=?,turn_order=? WHERE round_id=? AND user_id=?").run(p.user_id===imposter?'imposter':'player',index,round.id,p.user_id));
    db.prepare("UPDATE word_imposter_rounds SET phase='hints',secret_word=?,imposter_id=?,turn_index=0,phase_ends_at=?,updated_at=? WHERE id=? AND phase='registration'")
      .run(word,imposter,now+cfg.hintMs,now,round.id);
    db.prepare("INSERT INTO word_imposter_hints(round_id,user_id,turn_order,status) SELECT round_id,user_id,turn_order,'pending' FROM word_imposter_players WHERE round_id=?").run(round.id);
    this.store.adminAudit(actor,'word-imposter-distribute',round.id,{players:players.length},now);
    return ok('🎭 Rollen verteilt. Jede Person sieht nur die eigene Rolle im Portal; die Hinweisrunde läuft nacheinander.');
  }

  submitHint(userId:string,value:string,now=Date.now()):Result{
    const hint=value.normalize('NFC').trim();
    if(Array.from(hint).length>40||! /^[\p{L}\p{N}][\p{L}\p{N}'’-]{0,39}$/u.test(hint))return fail('Bitte gib genau ein Hinweiswort mit höchstens 40 Zeichen ein.',400);
    return this.store.miniGameTransaction(db=>{
      const round=this.activeRound(db);if(!round||round.phase!=='hints')return fail('Die Hinweisrunde ist gerade nicht offen.');
      if(round.phase_ends_at<=now){this.advanceHint(db,round,now,true);return fail('Dein Hinweis kam nach dem Zeitlimit; dieser Platz wurde übersprungen.');}
      const player=this.currentPlayer(db,round);if(!player||player.user_id!==userId)return fail('Du bist gerade nicht an der Reihe.',403);
      if(normalized(hint)===normalized(round.secret_word))return fail('Der geheime Begriff darf nicht direkt als Hinweis eingereicht werden.',400);
      const changed=db.prepare("UPDATE word_imposter_hints SET hint=?,status='pending',submitted_at=? WHERE round_id=? AND user_id=? AND status='pending' AND hint IS NULL")
        .run(hint,now,round.id,userId).changes;
      return changed?ok('Hinweis gespeichert. Er wird nach Freigabe öffentlich angezeigt.'):fail('Für diesen Zug wurde bereits ein Hinweis abgegeben.');
    });
  }

  publishHint(actor:string,now=Date.now()):Result{
    return this.store.miniGameTransaction(db=>{
      const round=this.activeRound(db);if(!round||round.phase!=='hints')return fail('Es gibt gerade keinen Hinweis freizugeben.');
      if(round.phase_ends_at<=now){this.advanceHint(db,round,now,true);return fail('Das Hinweiszeitlimit ist abgelaufen; der Zug wurde übersprungen.');}
      const hint=db.prepare("SELECT user_id,hint FROM word_imposter_hints WHERE round_id=? AND turn_order=? AND status='pending' AND hint IS NOT NULL").get(round.id,round.turn_index) as {user_id:string;hint:string}|undefined;
      if(!hint)return fail('Der aktuelle Spieler hat noch keinen Hinweis abgegeben.');
      db.prepare("UPDATE word_imposter_hints SET status='published',published_at=? WHERE round_id=? AND user_id=? AND status='pending'").run(now,round.id,hint.user_id);
      const remaining=(db.prepare('SELECT COUNT(*) n FROM word_imposter_players WHERE round_id=? AND turn_order>?').get(round.id,round.turn_index) as {n:number}).n;
      const next=round.turn_index+1,cfg=this.settings();
      db.prepare("UPDATE word_imposter_rounds SET phase=?,turn_index=?,phase_ends_at=?,updated_at=? WHERE id=? AND phase='hints'")
        .run(remaining?'hints':'discussion',next,now+(remaining?cfg.hintMs:cfg.discussionMs),now,round.id);
      this.store.adminAudit(actor,'word-imposter-publish-hint',round.id,{turn:round.turn_index},now);
      return ok(remaining?'Hinweis veröffentlicht. Der nächste Mitspieler ist an der Reihe.':'Letzten Hinweis veröffentlicht. Die Diskussion läuft jetzt.');
    });
  }

  skipHint(actor:string,now=Date.now()):Result{
    return this.store.miniGameTransaction(db=>{
      const round=this.activeRound(db);if(!round||round.phase!=='hints')return fail('Es gibt gerade keinen Hinweiszug.');
      this.advanceHint(db,round,now,true);this.store.adminAudit(actor,'word-imposter-skip-hint',round.id,{turn:round.turn_index},now);return ok('Hinweiszug übersprungen.');
    });
  }

  extendDiscussion(actor:string,extraMs:number,now=Date.now()):Result{
    if(!Number.isSafeInteger(extraMs)||extraMs<10_000||extraMs>300_000)return fail('Verlängerung muss zwischen 10 und 300 Sekunden liegen.',400);
    return this.store.miniGameTransaction(db=>{const round=this.activeRound(db);if(!round||round.phase!=='discussion')return fail('Die Diskussion läuft gerade nicht.');
      const end=Math.max(round.phase_ends_at,now)+extraMs;db.prepare("UPDATE word_imposter_rounds SET phase_ends_at=?,updated_at=? WHERE id=? AND phase='discussion'").run(end,now,round.id);
      this.store.adminAudit(actor,'word-imposter-extend-discussion',round.id,{extraMs},now);return ok(`Diskussion um ${Math.ceil(extraMs/1000)} Sekunden verlängert.`);});
  }

  beginVote(actor:string,now=Date.now()):Result{
    return this.store.miniGameTransaction(db=>{const round=this.activeRound(db);if(!round||round.phase!=='discussion')return fail('Die Diskussion läuft gerade nicht.');
      const cfg=this.settings();db.prepare("UPDATE word_imposter_rounds SET phase='voting',phase_ends_at=?,updated_at=? WHERE id=? AND phase='discussion'").run(now+cfg.votingMs,now,round.id);
      this.store.adminAudit(actor,'word-imposter-start-vote',round.id,{},now);return ok(`Geheime Abstimmung gestartet. Noch ${Math.ceil(cfg.votingMs/1000)} Sekunden.`);});
  }

  vote(userId:string,targetLogin:string,now=Date.now()):Result{
    const target=targetLogin.replace(/^@/u,'').trim().toLocaleLowerCase('de-DE');if(!/^[a-z0-9_]{1,32}$/u.test(target))return fail('Wähle eine Person aus der Teilnehmerliste.',400);
    return this.store.miniGameTransaction(db=>{const round=this.activeRound(db);if(!round||round.phase!=='voting')return fail('Die geheime Abstimmung ist gerade nicht offen.');
      if(round.phase_ends_at<=now)return fail('Die Abstimmung ist abgelaufen.');
      if(!db.prepare('SELECT 1 FROM word_imposter_players WHERE round_id=? AND user_id=?').get(round.id,userId))return fail('Nur Teilnehmende dürfen abstimmen.',403);
      const candidate=db.prepare('SELECT user_id,display_name FROM word_imposter_players WHERE round_id=? AND lower(login)=lower(?)').get(round.id,target) as {user_id:string;display_name:string}|undefined;
      if(!candidate)return fail('Ziel nicht gefunden; nur Mitspielende sind wählbar.',400);if(candidate.user_id===userId)return fail('Selbstabstimmung ist ausgeschaltet.',400);
      const inserted=db.prepare('INSERT OR IGNORE INTO word_imposter_votes(round_id,voter_id,target_id,voted_at) VALUES(?,?,?,?)').run(round.id,userId,candidate.user_id,now).changes;
      return inserted?ok('Deine geheime Stimme wurde gespeichert.'):fail('Du hast bereits abgestimmt.');});
  }

  resolveVote(actor:string,now=Date.now(),force=false):Result{
    return this.store.miniGameTransaction(db=>{const round=this.activeRound(db);if(!round||round.phase!=='voting')return fail('Es gibt gerade keine offene Abstimmung.');if(!force&&round.phase_ends_at>now)return fail('Die Abstimmungszeit ist noch nicht abgelaufen.');
      const tally=db.prepare('SELECT target_id,COUNT(*) votes FROM word_imposter_votes WHERE round_id=? GROUP BY target_id ORDER BY votes DESC').all(round.id) as Array<{target_id:string;votes:number}>;
      const top=tally[0]?.votes||0,leaders=tally.filter(row=>row.votes===top),tie=leaders.length!==1,caught=!tie&&leaders[0]?.target_id===round.imposter_id;
      const voteResult={caught,tie,votes:tally.reduce((n,row)=>n+row.votes,0),leaderCount:leaders.length};
      if(caught&&this.settings().allowLastGuess){const cfg=this.settings();db.prepare("UPDATE word_imposter_rounds SET phase='guess',phase_ends_at=?,result_json=?,updated_at=? WHERE id=? AND phase='voting'")
        .run(now+cfg.guessMs,JSON.stringify(voteResult),now,round.id);this.store.adminAudit(actor,'word-imposter-vote-resolved',round.id,{caught:true,tie,votes:voteResult.votes},now);return ok('Die Mehrheit hat den Imposter erkannt. Er hat jetzt einen privaten letzten Rateversuch.');}
      this.finishRound(db,round,voteResult,caught,now);this.store.adminAudit(actor,'word-imposter-vote-resolved',round.id,{caught,tie,votes:voteResult.votes},now);
      return ok(tie?'Gleichstand: Der Imposter gewinnt diese Runde. Die Auflösung ist jetzt sichtbar.':caught?'Der Imposter wurde erkannt. Die Auflösung ist jetzt sichtbar.':'Die Community hat den Imposter nicht erkannt. Die Auflösung ist jetzt sichtbar.');});
  }

  guess(userId:string,value:string,now=Date.now()):Result{
    const guess=normalized(value);if(!guess||Array.from(guess).length>50)return fail('Bitte gib einen Begriff mit höchstens 50 Zeichen ein.',400);
    return this.store.miniGameTransaction(db=>{const round=this.activeRound(db);if(!round||round.phase!=='guess')return fail('Es gibt gerade keinen letzten Rateversuch.');
      if(userId!==round.imposter_id)return fail('Nur der Imposter darf den letzten Rateversuch abgeben.',403);
      if(round.phase_ends_at<=now){const prior=round.result_json?JSON.parse(round.result_json) as {caught?:boolean;tie?:boolean;votes?:number}:{};this.finishRound(db,round,{...prior,caught:true,guessCorrect:false},true,now);return fail('Der letzte Rateversuch ist abgelaufen.',409);}
      const prior=round.result_json?JSON.parse(round.result_json) as {caught?:boolean;tie?:boolean;votes?:number}:{};
      this.finishRound(db,round,{...prior,caught:true,guessCorrect:guess===normalized(round.secret_word)},true,now);
      return ok('Dein letzter Rateversuch wurde gewertet. Die Runde ist aufgelöst.');});
  }

  cancel(actor:string,now=Date.now()):Result{
    return this.store.miniGameTransaction(db=>{const round=this.activeRound(db);if(!round)return fail('Keine aktive Geheimwort-Runde.');
      db.prepare(`UPDATE word_imposter_rounds SET phase='canceled',updated_at=? WHERE id=? AND ${LIVE}`).run(now,round.id);
      this.store.adminAudit(actor,'word-imposter-cancel',round.id,{},now);return ok('Geheimwort-Runde abgebrochen.');});
  }

  /** Safe for the community page and OBS: no role, secret, private ballot, or pending hint. */
  snapshot(now=Date.now()):Record<string,unknown>|null{
    return this.store.miniGameQuery(db=>{
      const round=db.prepare(`SELECT * FROM word_imposter_rounds WHERE ${LIVE} OR (phase='finished' AND updated_at>=?) ORDER BY started_at DESC LIMIT 1`).get(now-120_000) as RoundRow|undefined;
      if(!round)return null;
      const players=db.prepare('SELECT user_id,login,display_name,role,turn_order FROM word_imposter_players WHERE round_id=? ORDER BY joined_at,user_id').all(round.id) as PlayerRow[];
      const hints=db.prepare("SELECT h.turn_order,h.hint,p.login,p.display_name FROM word_imposter_hints h JOIN word_imposter_players p ON p.round_id=h.round_id AND p.user_id=h.user_id WHERE h.round_id=? AND h.status='published' ORDER BY h.turn_order").all(round.id) as Array<{turn_order:number;hint:string;login:string;display_name:string}>;
      const voteCount=(db.prepare('SELECT COUNT(*) n FROM word_imposter_votes WHERE round_id=?').get(round.id) as {n:number}).n;
      const current=round.phase==='hints'?players.find(p=>p.turn_order===round.turn_index):undefined;
      let result:Record<string,unknown>|null=null;
      if((round.phase==='results'||round.phase==='finished')&&round.result_json){try{
        const detail=JSON.parse(round.result_json) as {caught?:boolean;tie?:boolean;votes?:number;guessCorrect?:boolean};
        const imposter=players.find(p=>p.user_id===round.imposter_id);
        const wonImposter=!detail.caught||detail.guessCorrect===true;
        const awards=db.prepare("SELECT user_id,xp FROM mini_game_awards WHERE game='word-imposter' AND round_id=?").all(round.id) as Array<{user_id:string;xp:number}>;
        result={word:round.secret_word,imposterName:imposter?.display_name||'Unbekannt',caught:Boolean(detail.caught),tie:Boolean(detail.tie),guessCorrect:detail.guessCorrect??null,
          votes:detail.votes||0,winningSide:wonImposter?'imposter':'community',xpAwarded:awards.reduce((sum,a)=>sum+a.xp,0)};
      }catch{result=null;}}
      return {id:round.id,phase:round.phase,startedAt:round.started_at,endsAt:round.phase_ends_at,minPlayers:round.min_players,maxPlayers:round.max_players,
        players:players.map(p=>({login:p.login,displayName:p.display_name})),playerCount:players.length,votes:voteCount,
        hintTurn:current?{displayName:current.display_name,turn:round.turn_index+1,total:players.length}:null,
        hints:hints.map(h=>({turn:h.turn_order+1,displayName:h.display_name,text:h.hint})),result};
    });
  }

  /** Own role only, bound to a previously validated portal session. */
  privateRole(userId:string):{role:'imposter'}|{role:'player';word:string}|null{
    const row=this.store.miniGameQuery(db=>db.prepare("SELECT p.role,r.secret_word FROM word_imposter_players p JOIN word_imposter_rounds r ON r.id=p.round_id WHERE p.user_id=? AND r.phase IN ('hints','discussion','voting','guess') ORDER BY r.started_at DESC LIMIT 1").get(userId) as {role:string;secret_word:string}|undefined);
    return row?.role==='imposter'?{role:'imposter'}:row?.role==='player'?{role:'player',word:row.secret_word}:null;
  }

  viewerState(userId:string,now=Date.now()):Record<string,unknown>{
    return this.store.miniGameQuery(db=>{
      const round=db.prepare(`SELECT * FROM word_imposter_rounds WHERE ${LIVE} ORDER BY started_at DESC LIMIT 1`).get() as RoundRow|undefined;
      if(!round)return {isParticipant:false,canJoin:false,canLeave:false,isTurn:false,hintSubmitted:false,hasVoted:false,isImposter:false};
      const player=db.prepare('SELECT role,turn_order FROM word_imposter_players WHERE round_id=? AND user_id=?').get(round.id,userId) as {role:string;turn_order:number|null}|undefined;
      const hint=player&&round.phase==='hints'?db.prepare('SELECT hint FROM word_imposter_hints WHERE round_id=? AND user_id=?').get(round.id,userId) as {hint:string|null}|undefined:undefined;
      const count=(db.prepare('SELECT COUNT(*) n FROM word_imposter_players WHERE round_id=?').get(round.id) as {n:number}).n;
      const hasVoted=round.phase==='voting'&&Boolean(db.prepare('SELECT 1 FROM word_imposter_votes WHERE round_id=? AND voter_id=?').get(round.id,userId));
      return {isParticipant:Boolean(player),canJoin:round.phase==='registration'&&round.phase_ends_at>now&&!player&&count<round.max_players,
        canLeave:round.phase==='registration'&&Boolean(player),isTurn:round.phase==='hints'&&player?.turn_order===round.turn_index,
        hintSubmitted:Boolean(hint?.hint),hasVoted,isImposter:player?.role==='imposter'};
    });
  }

  moderationSnapshot():Record<string,unknown>{
    const publicState=this.snapshot();
    const pending=this.store.miniGameQuery(db=>db.prepare("SELECT p.display_name displayName,h.hint FROM word_imposter_hints h JOIN word_imposter_players p ON p.round_id=h.round_id AND p.user_id=h.user_id JOIN word_imposter_rounds r ON r.id=h.round_id WHERE r.phase='hints' AND h.turn_order=r.turn_index AND h.status='pending' AND h.hint IS NOT NULL ORDER BY r.started_at DESC LIMIT 1").get() as {displayName:string;hint:string}|undefined);
    return {public:publicState,pendingHint:pending||null};
  }

  handle(message:ChatMessage,command:string,now=Date.now()):string|undefined{
    if(!['startwordimposter','joinword','leaveword','wordimposter'].includes(command))return undefined;
    const admin=message.senderUserId===this.config.broadcasterUserId||this.config.authorizedModeratorIds.includes(message.senderUserId)||message.isModerator===true;
    if(command==='startwordimposter'){if(!admin)return '⛔ Nur Jannik oder autorisierte Mods dürfen das Geheimwort-Spiel starten.';return this.start(message.senderUserId,now).message;}
    if(command==='joinword')return this.join({userId:message.senderUserId,login:message.senderLogin,displayName:message.senderDisplayName},now).message;
    if(command==='leaveword')return this.leave(message.senderUserId).message;
    const state=this.snapshot(now) as {phase?:string;playerCount?:number;endsAt?:number}|null;
    return state?`🎭 Geheimwort-Imposter: ${state.phase} · ${state.playerCount} Mitspielende · ${Math.max(0,Math.ceil(((state.endsAt||now)-now)/1000))} Sekunden.`:'🎭 Keine Geheimwort-Runde aktiv. Jannik oder Mods: !startwordimposter.';
  }

  tickMessages(now=Date.now()):Array<{message:string;category:'imposter'}>{
    const round=this.store.miniGameQuery(db=>db.prepare(`SELECT * FROM word_imposter_rounds WHERE ${LIVE} ORDER BY started_at DESC LIMIT 1`).get() as RoundRow|undefined);
    if(!round)return this.finishOldResult(now);
    if(round.phase==='registration'&&round.phase_ends_at<=now){
      const info=this.store.miniGameQuery(db=>({count:(db.prepare('SELECT COUNT(*) n FROM word_imposter_players WHERE round_id=?').get(round.id) as {n:number}).n,minimum:(db.prepare('SELECT min_players FROM word_imposter_rounds WHERE id=?').get(round.id) as {min_players:number}).min_players}));
      if(info.count<info.minimum){this.store.miniGameQuery(db=>db.prepare("UPDATE word_imposter_rounds SET phase='canceled',updated_at=? WHERE id=? AND phase='registration'").run(now,round.id));return[{message:'🎭 Zu wenige Teilnehmende; die Geheimwort-Anmeldung ist abgelaufen.',category:'imposter'}];}
      const result=this.startRoles('timer',now);return[{message:result.message,category:'imposter'}];
    }
    if(round.phase==='hints'&&round.phase_ends_at<=now){this.store.miniGameTransaction(db=>this.advanceHint(db,round,now,true));return[{message:'🎭 Ein Hinweiszeitlimit ist abgelaufen; der Zug wurde übersprungen.',category:'imposter'}];}
    if(round.phase==='discussion'&&round.phase_ends_at<=now){const result=this.beginVote('timer',now);return[{message:`🎭 ${result.message}`,category:'imposter'}];}
    if(round.phase==='voting'&&round.phase_ends_at<=now){const result=this.resolveVote('timer',now);return[{message:`🎭 ${result.message}`,category:'imposter'}];}
    if(round.phase==='guess'&&round.phase_ends_at<=now){const result=this.finishAfterGuessTimeout(now);return[{message:result,category:'imposter'}];}
    if(round.phase==='results'&&round.phase_ends_at<=now){this.store.miniGameQuery(db=>db.prepare("UPDATE word_imposter_rounds SET phase='finished' WHERE id=? AND phase='results'").run(round.id));}
    return this.finishOldResult(now);
  }

  private finishAfterGuessTimeout(now:number):string{
    return this.store.miniGameTransaction(db=>{const round=this.activeRound(db);if(!round||round.phase!=='guess')return '🎭 Der letzte Rateversuch wurde bereits beendet.';
      const prior=round.result_json?JSON.parse(round.result_json) as {caught?:boolean;tie?:boolean;votes?:number}:{};this.finishRound(db,round,{...prior,caught:true,guessCorrect:false},true,now);return '🎭 Der letzte Rateversuch ist abgelaufen; die Auflösung ist jetzt sichtbar.';});
  }
  private finishOldResult(_now:number):Array<{message:string;category:'imposter'}>{return [];}
  private finishRound(db:Db,round:RoundRow,detail:Record<string,unknown>,wasCaught:boolean,now:number):void{
    db.prepare("UPDATE word_imposter_rounds SET phase='results',phase_ends_at=?,result_json=?,updated_at=? WHERE id=? AND phase IN ('voting','guess')").run(now+120_000,JSON.stringify(detail),now,round.id);
    const players=db.prepare('SELECT user_id,display_name,role FROM word_imposter_players WHERE round_id=?').all(round.id) as Array<{user_id:string;display_name:string;role:string}>;
    const imposterWon=!wasCaught||detail.guessCorrect===true,cfg=this.settings();
    for(const player of players){
      const won=player.role==='imposter'?imposterWon:!imposterWon,xp=won?cfg.winXp:cfg.participationXp,event=`mini:word-imposter:${round.id}:${player.user_id}`;
      if(db.prepare("INSERT OR IGNORE INTO mini_game_awards(event_id,game,round_id,user_id,xp,created_at) VALUES(?,'word-imposter',?,?,?,?)").run(event,round.id,player.user_id,xp,now).changes){
        this.store.awardXp(event,player.user_id,player.display_name,xp,`mini-game:word-imposter:${won?'win':'participation'}`,now,50);
      }
    }
  }
  private activeRound(db:Db):RoundRow|undefined{return db.prepare(`SELECT * FROM word_imposter_rounds WHERE ${LIVE} ORDER BY started_at DESC LIMIT 1`).get() as RoundRow|undefined;}
  private currentPlayer(db:Db,round:RoundRow):PlayerRow|undefined{return db.prepare('SELECT user_id,login,display_name,role,turn_order FROM word_imposter_players WHERE round_id=? AND turn_order=?').get(round.id,round.turn_index) as PlayerRow|undefined;}
  private advanceHint(db:Db,round:RoundRow,now:number,skip:boolean):void{
    const current=this.currentPlayer(db,round);if(skip&&current)db.prepare("UPDATE word_imposter_hints SET hint=NULL,status='skipped',published_at=? WHERE round_id=? AND user_id=? AND status='pending'").run(now,round.id,current.user_id);
    const remaining=(db.prepare('SELECT COUNT(*) n FROM word_imposter_players WHERE round_id=? AND turn_order>?').get(round.id,round.turn_index) as {n:number}).n,next=round.turn_index+1,cfg=this.settings();
    db.prepare("UPDATE word_imposter_rounds SET phase=?,turn_index=?,phase_ends_at=?,updated_at=? WHERE id=? AND phase='hints'").run(remaining?'hints':'discussion',next,now+(remaining?cfg.hintMs:cfg.discussionMs),now,round.id);
  }
  private pick(max:number):number{const value=this.random(max);return Number.isInteger(value)&&value>=0&&value<max?value:0;}
}
