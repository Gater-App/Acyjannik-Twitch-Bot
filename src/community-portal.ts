import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig, ChatMessage } from './types.js';
import { CommunityFeatures, levelForXp, xpAtLevel } from './community-features.js';
import { CommunityArcade } from './community-arcade.js';
import { FeatureStore } from './feature-store.js';
import { RateLimitBuckets, setRateLimitHeaders, trustedClientAddress } from './request-limits.js';

const VIEWER_SESSION_MS=12*60*60_000;
const OAUTH_STATE_MS=10*60_000;
const COOKIE='community_viewer';
const STATE_COOKIE='community_oauth_state';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const clean=(value:string,max=80)=>Array.from(value.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim()).slice(0,max).join('');
const escapeHtml=(value:unknown)=>String(value??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const cookie=(req:IncomingMessage,name:string)=>{
  const raw=req.headers.cookie||'';for(const part of raw.split(';')){const [key,...rest]=part.trim().split('=');if(key===name)return rest.join('=');}return '';
};

interface ViewerSession {userId:string;login:string;displayName:string;profileImageUrl:string|null;csrfToken:string;expiresAt:number;}
interface HelixViewer {id:string;login:string;display_name:string;profile_image_url?:string;}

/** Independent viewer-facing portal; all writes pass through the existing game and community services. */
export class ViewerCommunityPortal {
  private readonly publicOrigin:string;
  private readonly secureCookies:boolean;
  private readonly clientId:string;
  private readonly clientSecret:string;
  private readonly rates=new RateLimitBuckets();
  private readonly cleanupTimer:NodeJS.Timeout;

  constructor(private readonly store:FeatureStore,private readonly features:CommunityFeatures,private readonly config:AppConfig,
    private readonly fetchImpl:typeof fetch=fetch){
    this.publicOrigin=new URL(config.redirectUri).origin;
    this.secureCookies=new URL(config.redirectUri).protocol==='https:';
    this.clientId=config.clientId;this.clientSecret=config.clientSecret;
    this.cleanupTimer=setInterval(()=>this.store.deleteExpiredViewerData(Date.now()),60_000);this.cleanupTimer.unref();
  }

  stop():void{clearInterval(this.cleanupTimer);}

  handles(pathname:string):boolean{return pathname==='/community'||pathname.startsWith('/community/');}

  async handle(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
    const path=url.pathname;
    if(path==='/community/login'&&req.method==='GET'){this.loginPage(res);return true;}
    if(path==='/community/login/twitch'&&req.method==='GET'){
      if(this.rejectRateLimit(res,this.rates.consume('viewer-oauth-start',trustedClientAddress(req),20,10*60_000),'Zu viele Anmeldeversuche. Bitte später erneut versuchen.'))return true;
      this.login(res);return true;
    }
    if(path==='/community/logout'&&req.method==='POST'){this.logout(req,res);return true;}
    if(path==='/community/api/state'&&req.method==='GET'){
      const session=this.session(req),identity=session?.userId||trustedClientAddress(req);
      const decision=this.rates.consume(session?'viewer-read':'viewer-public-read',identity,session?240:60,60_000);
      if(this.rejectRateLimit(res,decision,'Die Community wird gerade zu häufig abgefragt. Bitte kurz warten.'))return true;
      this.sendJson(res,200,this.state(req));return true;
    }
    if(path.startsWith('/community/api/')){
      if(req.method!=='POST'){this.sendJson(res,405,{error:'Nur sichere Aktionen sind erlaubt.'});return true;}
      const session=this.session(req);if(!session){this.sendJson(res,401,{error:'Bitte melde dich mit Twitch an.'});return true;}
      if(!this.validCsrf(req,session)){this.sendJson(res,403,{error:'Sicherheitsprüfung fehlgeschlagen. Bitte lade die Seite neu.'});return true;}
      if(this.rejectRateLimit(res,this.rates.consume('viewer-write',session.userId,30,60_000),'Du bist gerade sehr aktiv. Bitte warte kurz.'))return true;
      const body=await this.readBody(req);if(!body){this.sendJson(res,400,{error:'Die Eingabe konnte nicht gelesen werden.'});return true;}
      await this.action(path,body,session,res);return true;
    }
    if(path==='/community/datenschutz'){this.privacyPage(res);return true;}
    if(path==='/community'||path==='/community/'||path==='/community/imposter'||path==='/community/quests'||path==='/community/profile'){
      this.page(res,path);return true;
    }
    this.sendJson(res,404,{error:'Nicht gefunden.'});return true;
  }

  /** Handles the registered dashboard OAuth callback only when its one-time state belongs to a viewer login. */
  async handleOAuthCallback(url:URL,req:IncomingMessage,res:ServerResponse):Promise<boolean>{
    const state=url.searchParams.get('state')||'';
    if(!/^[a-f0-9]{48}$/u.test(state)||!this.store.viewerOAuthStateExists(hash(state)))return false;
    const clearState=this.cookieHeader(STATE_COOKIE,'/',0),sameBrowser=cookie(req,STATE_COOKIE)===state,validState=this.store.consumeViewerOAuthState(hash(state),Date.now());
    if(!sameBrowser||!validState){
      res.setHeader('Set-Cookie',clearState);this.sendJson(res,400,{error:'Die Twitch-Anmeldung ist abgelaufen. Bitte versuche es erneut.'});return true;
    }
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    if(url.searchParams.has('error')){res.setHeader('Set-Cookie',clearState);this.sendJson(res,400,{error:'Die Twitch-Anmeldung wurde abgebrochen.'});return true;}
    const code=url.searchParams.get('code')||'';if(!code){res.setHeader('Set-Cookie',clearState);this.sendJson(res,400,{error:'Twitch hat keinen Anmeldecode geliefert.'});return true;}
    try{
      const tokenResponse=await this.fetchImpl('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,code,grant_type:'authorization_code',redirect_uri:this.config.redirectUri})});
      if(!tokenResponse.ok)throw new Error('code exchange');
      const token=await tokenResponse.json() as {access_token?:string};if(!token.access_token)throw new Error('missing token');
      const validation=await this.fetchImpl('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${token.access_token}`}});
      if(!validation.ok)throw new Error('invalid token');
      const identity=await validation.json() as {client_id?:string;user_id?:string};
      if(identity.client_id!==this.clientId||!identity.user_id)throw new Error('wrong client');
      const profileResponse=await this.fetchImpl('https://api.twitch.tv/helix/users',{headers:{'Client-Id':this.clientId,Authorization:`Bearer ${token.access_token}`}});
      if(!profileResponse.ok)throw new Error('profile');
      const profile=(await profileResponse.json() as {data?:HelixViewer[]}).data?.[0];
      if(!profile||profile.id!==identity.user_id||!/^[a-z0-9_]{1,25}$/iu.test(profile.login))throw new Error('identity mismatch');
      const now=Date.now(),rawSession=randomBytes(32).toString('base64url'),csrfToken=randomBytes(32).toString('base64url');
      const image=profile.profile_image_url&&/^https:\/\/static-cdn\.jtvnw\.net\//u.test(profile.profile_image_url)?profile.profile_image_url:null;
      this.store.createViewerSession({sessionHash:hash(rawSession),userId:profile.id,login:profile.login,displayName:clean(profile.display_name,32)||profile.login,
        profileImageUrl:image,csrfToken,createdAt:now,expiresAt:now+VIEWER_SESSION_MS});
      res.setHeader('Set-Cookie',[clearState,this.cookieHeader(COOKIE,'/community',VIEWER_SESSION_MS/1000,rawSession)]);
      res.statusCode=303;res.setHeader('Location','/community');res.end();
    }catch{
      res.setHeader('Set-Cookie',clearState);this.sendJson(res,401,{error:'Twitch konnte dein Konto nicht bestätigen. Bitte versuche es erneut.'});
    }
    return true;
  }

  private loginPage(res:ServerResponse):void{
    const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',`default-src 'self'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twitch-Anmeldung · ACY Community</title><style nonce="${nonce}">:root{color-scheme:dark;font:16px/1.55 system-ui;background:#11131b;color:#eee}body{margin:0;padding:24px;background:radial-gradient(ellipse at 80% 0,#34234c,transparent 35%),#11131b}.box{max-width:680px;margin:5vh auto;background:#1b1d29;border:1px solid #383447;border-radius:18px;padding:24px}h1{margin-top:0}p,li{color:#c1bfd0}.button{display:inline-block;background:#7650b8;color:white;text-decoration:none;border-radius:11px;padding:11px 16px;font-weight:700}a:not(.button){color:#c3a4ff}@media(max-width:520px){body{padding:12px}.box{padding:18px}}</style><main class="box"><h1>Mit Twitch anmelden</h1><p>Damit du mitspielen und deine eigenen Werte sehen kannst, bestätigen wir deinen Twitch-Namen direkt bei Twitch. Es werden keine besonderen Twitch-Berechtigungen angefragt.</p><ul><li>Für deine Sitzung speichern wir Twitch-ID, Namen und – falls verfügbar – Profilbild.</li><li>Die Sitzung endet nach 12 Stunden; Abmelden löscht sie sofort.</li><li>Spielteilnahmen und Punkte bleiben in den bestehenden Community-Spielständen und werden nicht durch Abmelden gelöscht.</li><li>Deine geheime Imposter-Rolle ist nur für dein eigenes angemeldetes Konto sichtbar.</li></ul><p><a href="/community/datenschutz">Datenschutz und Datenlebenszyklus</a></p><a class="button" href="/community/login/twitch">Weiter zu Twitch</a> <a href="/community">Zurück</a></main></html>`);
  }

  private privacyPage(res:ServerResponse):void{
    const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',`default-src 'self'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Datenschutz · ACY Community</title><style nonce="${nonce}">:root{color-scheme:dark;font:16px/1.6 system-ui;background:#11131b;color:#eee}body{margin:0;padding:20px;background:radial-gradient(ellipse at 80% 0,#34234c,transparent 35%),#11131b}.box{max-width:760px;margin:4vh auto;background:#1b1d29;border:1px solid #383447;border-radius:18px;padding:26px}p,li{color:#c1bfd0}h1,h2{color:#f4efff}a{color:#c3a4ff}</style><main class="box"><h1>Datenschutz im Community-Portal</h1><p>Die Anmeldung ist freiwillig und ordnet deine Teilnahme deinem Twitch-Konto zu.</p><h2>Welche Daten anfallen</h2><ul><li>Twitch-Konto-ID, Login, Anzeigename und optional öffentliches Profilbild. OAuth-Code und Zugriffstoken werden nur während der Anmeldung verarbeitet und nicht gespeichert.</li><li>Eine zufällige, gehashte Sitzungskennung und ein CSRF-Schutzwert. Die Sitzung endet nach 12 Stunden; Abmelden löscht sie sofort.</li><li>Spielteilnahmen, Quests, Abstimmungen und Punkte werden in den bestehenden Community-Systemen gespeichert. Es gibt keine zweite Punkteverwaltung.</li></ul><h2>Geheime Rollen</h2><p>Eine Imposter-Rolle wird nur an das angemeldete eigene Twitch-Konto ausgeliefert. Öffentliche Listen enthalten keine Twitch-IDs, Stimmen oder Rollen.</p><h2>Aufbewahrung und Löschung</h2><p>Abgelaufene Sitzungen und OAuth-States werden regelmäßig entfernt. Logout löscht die Portal-Sitzung, aber nicht bereits entstandene Spielteilnahmen, Quests oder Punkte. Für die Löschung solcher Spieldaten wende dich an Jannick oder die Moderation.</p><p>Diese technische Beschreibung ersetzt keine rechtliche Prüfung oder vollständigen Datenschutzhinweise des Kanalbetreibers.</p><p><a href="/community">Zur Community</a> · <a href="/community/login">Anmeldung</a></p></main></html>`);
  }

  private login(res:ServerResponse):void{
    const state=randomBytes(24).toString('hex'),now=Date.now();this.store.createViewerOAuthState(hash(state),now+OAUTH_STATE_MS,now);
    const auth=new URL('https://id.twitch.tv/oauth2/authorize');auth.searchParams.set('client_id',this.clientId);auth.searchParams.set('redirect_uri',this.config.redirectUri);
    auth.searchParams.set('response_type','code');auth.searchParams.set('scope','');auth.searchParams.set('state',state);
    res.statusCode=302;res.setHeader('Cache-Control','no-store');res.setHeader('Set-Cookie',this.cookieHeader(STATE_COOKIE,'/',600,state));res.setHeader('Location',auth.toString());res.end();
  }

  private logout(req:IncomingMessage,res:ServerResponse):void{
    const session=this.session(req);if(!session){res.setHeader('Set-Cookie',this.cookieHeader(COOKIE,'/community',0));this.sendJson(res,200,{ok:true});return;}
    if(!this.validCsrf(req,session)){this.sendJson(res,403,{error:'Sicherheitsprüfung fehlgeschlagen.'});return;}
    const raw=cookie(req,COOKIE);if(raw)this.store.deleteViewerSession(hash(raw));res.setHeader('Set-Cookie',this.cookieHeader(COOKIE,'/community',0));this.sendJson(res,200,{ok:true});
  }

  private state(req:IncomingMessage):Record<string,unknown>{
    this.store.deleteExpiredViewerData(Date.now());
    const session=this.session(req),now=Date.now(),features=this.features.helpAvailability(),event=this.store.activeEvent();
    const xpTop=this.store.xpTop(10).map((x,index)=>({rank:index+1,name:x.displayName,xp:x.xp}));
    const imposter=this.imposterView(session?.userId,now),detective=this.detectiveView(now);
    const dropView=this.dropView(session?.userId,now),wheelView=this.wheelView(now),vaultView=this.features.vault.publicSnapshot(now);
    const vaultHint=session?this.features.vault.personalHint(session.userId):null;
    const petRaw=this.features.arcade.snapshot('pet',now) as {visible?:boolean;pet?:Record<string,unknown>};
    const modules=this.store.config<Record<string,boolean>>('modules',{});
    const eventEnabled=Boolean(event&&features.events&&(event.id==='halloween'||modules.events!==false));
    const activeEvent=eventEnabled&&event?{id:event.id,name:event.name,emoji:event.emoji,currency:event.currency,command:event.command,
      points:session?this.store.score(event.id,session.userId):null,top:this.store.eventTop(event.id,5).map((p,i)=>({rank:i+1,name:p.displayName,points:p.pumpkins}))}:null;
    const xpSettings=this.store.config<{levelBase?:number}>('xp_settings',{levelBase:100}),base=Math.max(1,xpSettings.levelBase||100);
    const xp= session?this.store.xp(session.userId).xp:null,level=xp===null?null:levelForXp(xp,base),floor=level===null?0:xpAtLevel(level,base),next=level===null?0:xpAtLevel(level+1,base);
    const activeQuest=this.store.activeQuest();
    const questSettings=this.store.config<{enabled?:boolean;chatEnabled?:boolean}>('quest_settings',{});
    const data:Record<string,unknown>={authenticated:Boolean(session),viewer:session?{displayName:session.displayName,login:session.login,profileImageUrl:session.profileImageUrl,csrfToken:session.csrfToken}:null,
      public:{channel:this.config.channelLogin,leaderboard:xpTop,imposter,detective,drop:dropView,vault:vaultView.visible?vaultView.vault:null,
        wheel:wheelView,
        activeQuest:activeQuest?{title:activeQuest.title,game:activeQuest.game,status:activeQuest.status}:null,
        questsEnabled:modules.quests!==false&&questSettings.enabled!==false&&questSettings.chatEnabled!==false,
        approvedQuests:this.store.approvedQuests(20).map(q=>({title:q.title,game:q.game})),
        pet:petRaw.visible?petRaw.pet:null,petEnabled:features.pet,petPaused:Boolean(petRaw.pet?.paused),dropEnabled:features.drops,imposterEnabled:features.imposter,
        detectiveEnabled:features.detective,activeEvent,events:(features.seasonalEvents||[]).filter(e=>e.active).map(e=>({name:e.name,emoji:this.store.event(e.id)?.emoji||'✨'}))},
      personal:session?{xp,level,rank:this.store.xpRank(session.userId)||null,vaultHint,progress:xp===null||level===null?null:{current:xp-floor,needed:Math.max(1,next-floor)},eventPoints:activeEvent?.id?this.store.score(activeEvent.id,session.userId):null,
        quests:this.store.questsBySubmitter(session.userId,20).map(q=>({title:q.title,status:q.status,submittedAt:q.submittedAt,updatedAt:q.updatedAt})),
        petAction:this.features.arcade.petPortalStatus(session.userId,now),
        hasImposterRole:imposter?.participant===true,petEnabled:features.pet,dropEnabled:features.drops}:null};
    return data;
  }

  private imposterView(userId:string|undefined,now:number):Record<string,unknown>|null{
    const cfg=this.features.miniGames.settings().imposter;
    const row=this.store.miniGameQuery(db=>db.prepare(`SELECT id,phase,started_at,phase_ends_at,imposter_id,rule_text,result_json,updated_at FROM imposter_rounds
      WHERE phase IN ('registration','role_distribution','playing','voting','results') OR (phase='finished' AND updated_at>=?) ORDER BY started_at DESC LIMIT 1`).get(now-120_000) as
      {id:string;phase:string;started_at:number;phase_ends_at:number|null;imposter_id:string|null;rule_text:string|null;result_json:string|null;updated_at:number}|undefined);
    if(!row)return null;
    const players=this.store.miniGameQuery(db=>db.prepare('SELECT user_id,display_name,role FROM imposter_players WHERE round_id=? ORDER BY joined_at').all(row.id) as Array<{user_id:string;display_name:string;role:string}>);
    const participant=Boolean(userId&&players.some(p=>p.user_id===userId));
    const myPlayer=userId?players.find(p=>p.user_id===userId):undefined;
    const voteCount=this.store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM imposter_votes WHERE round_id=?').get(row.id) as {n:number}).n);
    const myVote=userId?this.store.miniGameQuery(db=>db.prepare('SELECT p.display_name FROM imposter_votes v JOIN imposter_players p ON p.round_id=v.round_id AND p.user_id=v.target_id WHERE v.round_id=? AND v.voter_id=?').get(row.id,userId) as {display_name:string}|undefined):undefined;
    const awards=this.store.miniGameQuery(db=>db.prepare('SELECT user_id,xp FROM mini_game_awards WHERE round_id=? AND game=\'imposter\'').all(row.id) as Array<{user_id:string;xp:number}>);
    let result:Record<string,unknown>|null=null;
    if(row.result_json){try{const parsed=JSON.parse(row.result_json) as {caught?:boolean;neutral?:boolean;rule?:string;votes?:number};
      const imposterName=players.find(p=>p.user_id===row.imposter_id)?.display_name||'Unbekannt';
      result={imposterName,caught:parsed.caught===true,neutral:parsed.neutral===true,rule:clean(parsed.rule||row.rule_text||'',240),votes:parsed.votes||voteCount,
        winners:parsed.neutral?[]:players.filter(p=>parsed.caught?p.role!=='imposter':p.role==='imposter').map(p=>p.display_name),
        xpAwarded:awards.reduce((sum,a)=>sum+a.xp,0),myXp:userId?awards.find(a=>a.user_id===userId)?.xp||0:null};
    }catch{result=null;}}
    const role=(userId&&myPlayer&&['playing','voting'].includes(row.phase))?this.features.miniGames.roleFor(userId):undefined;
    return {phase:row.phase,startedAt:row.started_at,endsAt:row.phase_ends_at,players:players.map(p=>({displayName:p.display_name})),playerCount:players.length,
      minPlayers:cfg.minPlayers,maxPlayers:cfg.maxPlayers,votes:voteCount,participant,canJoin:row.phase==='registration'&&!participant&&players.length<cfg.maxPlayers,
      canLeave:row.phase==='registration'&&participant,myVote:myVote?.display_name||null,candidates:row.phase==='voting'&&participant?players.filter(p=>!cfg.noSelfVote||p.user_id!==userId).map(p=>p.display_name):[],
      role:role?(role.role==='imposter'?{kind:'imposter'}:{kind:'player',rule:role.rule}):null,result};
  }

  private detectiveView(now:number):Record<string,unknown>|null{
    return this.store.miniGameQuery(db=>{
      const row=db.prepare(`SELECT r.id,r.phase,r.ends_at,r.result_json,q.text FROM detective_rounds r JOIN detective_quotes q ON q.id=r.quote_id
        WHERE r.phase IN ('playing','results') OR (r.phase='finished' AND r.updated_at>=?) ORDER BY r.started_at DESC LIMIT 1`).get(now-120_000) as
        {id:string;phase:string;ends_at:number;result_json:string|null;text:string}|undefined;
      if(!row)return null;let result:Record<string,unknown>|null=null;
      if(row.result_json)try{const parsed=JSON.parse(row.result_json) as {authorName?:string;winners?:Array<{displayName?:string}>};result={authorName:clean(parsed.authorName||'Unbekannt',32),winnerCount:Array.isArray(parsed.winners)?parsed.winners.length:0,winners:(parsed.winners||[]).map(w=>clean(w.displayName||'',32)).filter(Boolean)};}catch{/* malformed historical result stays private */}
      return {phase:row.phase,endsAt:row.ends_at,text:row.phase==='playing'?row.text:null,guesses:(db.prepare('SELECT COUNT(*) n FROM detective_guesses WHERE round_id=?').get(row.id) as {n:number}).n,result};
    });
  }

  private dropView(userId:string|undefined,now:number):Record<string,unknown>|null{
    if(!this.features.arcade.settings().dropsEnabled)return null;
    return this.store.miniGameQuery(db=>{
      const row=db.prepare("SELECT id,status,ends_at,resolved_at,result_json FROM mystery_drops WHERE status IN ('announced','claiming','resolving') OR (status='completed' AND resolved_at>=?) ORDER BY created_at DESC LIMIT 1").get(now-120_000) as
        {id:string;status:string;ends_at:number;resolved_at:number|null;result_json:string|null}|undefined;
      if(!row)return null;
      const participants=(db.prepare('SELECT COUNT(*) n FROM mystery_claims WHERE drop_id=?').get(row.id) as {n:number}).n;
      const participated=Boolean(userId&&db.prepare('SELECT 1 FROM mystery_claims WHERE drop_id=? AND user_id=?').get(row.id,userId));
      let result:unknown=null;if(row.result_json)try{result=JSON.parse(row.result_json) as unknown;}catch{/* malformed legacy result is not echoed */}
      return {status:row.status,endsAt:row.ends_at,participants,participated,result};
    });
  }

  private wheelView(now:number):Record<string,unknown>|null{
    if(!this.features.arcade.settings().wheelEnabled)return null;
    return this.store.miniGameQuery(db=>{
      const row=db.prepare("SELECT title,status,created_at,ends_at,resolved_at FROM chaos_wheel_spins WHERE status IN ('active','completed') ORDER BY created_at DESC LIMIT 1").get() as
        {title:string;status:string;created_at:number;ends_at:number|null;resolved_at:number|null}|undefined;
      if(!row||row.status!=='active'&&now-(row.resolved_at??row.created_at)>120_000)return null;
      return {title:clean(row.title,100),status:row.status,createdAt:row.created_at,endsAt:row.ends_at};
    });
  }

  private async action(path:string,body:Record<string,unknown>,session:ViewerSession,res:ServerResponse):Promise<void>{
    const now=Date.now(),message:ChatMessage={eventId:`viewer:${randomUUID()}`,messageId:`viewer:${randomUUID()}`,broadcasterUserId:this.config.broadcasterUserId,
      senderUserId:session.userId,senderLogin:session.login,senderDisplayName:session.displayName,message:'',sentAt:now,isModerator:false};
    try{
      let replies:unknown[]|string|undefined;
      if(path==='/community/api/imposter/join')replies=[this.features.miniGames.handle({...message,message:'!joinimposter'},'joinimposter',[],now)];
      else if(path==='/community/api/imposter/leave')replies=[this.features.miniGames.handle({...message,message:'!leaveimposter'},'leaveimposter',[],now)];
      else if(path==='/community/api/imposter/vote'){
        const target=typeof body.target==='string'?clean(body.target,48):'';if(!target){this.sendJson(res,400,{error:'Wähle eine Person aus der Teilnehmerliste.'});return;}
        replies=[this.features.miniGames.handle({...message,message:`!sus ${target}`},'sus',[target],now)];
      }else if(path==='/community/api/quest'){
        const title=typeof body.title==='string'?clean(body.title,240):'';if(title.length<8){this.sendJson(res,400,{error:'Bitte beschreibe die Quest mit mindestens 8 Zeichen.'});return;}
        replies=await this.features.handle({...message,message:`!quest ${title}`},'quest',[title],now);
      }else if(path==='/community/api/pet'){
        const kind=body.kind==='play'?'play':body.kind==='feed'?'feed':'';if(!kind){this.sendJson(res,400,{error:'Diese Katzenaktion gibt es nicht.'});return;}
        const result=this.features.arcade.interactFromPortal({...message,message:`!${kind}`},kind,now);
        if(!result.ok){this.sendJson(res,409,{ok:false,error:result.message,remainingMs:result.remainingMs});return;}
        const pet=this.features.arcade.pet();
        this.sendJson(res,200,{ok:true,message:result.message,changes:result.changes,leveledUp:result.leveledUp,remainingMs:result.remainingMs,pet});return;
      }else if(path==='/community/api/drop/claim')replies=await this.features.handle({...message,message:'!claim'},'claim',[],now);
      else if(path==='/community/api/event'){
        const active=this.store.activeEvent(),availability=this.features.helpAvailability();if(!active||!availability.events||!this.validEvent(active.id,now)){this.sendJson(res,409,{error:'Gerade läuft kein mitmachbares Saison-Event.'});return;}
        replies=await this.features.handle({...message,message:`!${active.command}`},active.command,[],now);
      }else{this.sendJson(res,404,{error:'Diese Aktion gibt es nicht.'});return;}
      const text=typeof replies==='string'?replies:Array.isArray(replies)?replies.map(r=>typeof r==='string'?r:(r as {message?:string}|null)?.message||'').filter(Boolean).join(' '):'';
      this.sendJson(res,200,{ok:true,message:text||'Aktion wurde verarbeitet.'});
    }catch(error){this.sendJson(res,400,{error:error instanceof Error?clean(error.message,180):'Die Aktion konnte nicht ausgeführt werden.'});}
  }

  private validEvent(id:string,now:number):boolean{const e=this.store.event(id);return Boolean(e?.active&&(!e.startAt||e.startAt<=now)&&(!e.endAt||e.endAt>now));}
  private session(req:IncomingMessage):ViewerSession|undefined{const raw=cookie(req,COOKIE);return raw?this.store.viewerSession(hash(raw),Date.now()):undefined;}
  private validCsrf(req:IncomingMessage,s:ViewerSession):boolean{
    const supplied=req.headers['x-csrf-token'];if(typeof supplied!=='string'||supplied!==s.csrfToken)return false;
    const origin=req.headers.origin;if(origin&&origin!==this.publicOrigin)return false;
    return true;
  }
  private rejectRateLimit(res:ServerResponse,decision:{allowed:boolean;retryAfterSeconds:number},message:string):boolean{
    if(decision.allowed)return false;setRateLimitHeaders(res,decision.retryAfterSeconds);
    this.sendJson(res,429,{error:message,retryAfterSeconds:decision.retryAfterSeconds});return true;
  }
  private async readBody(req:IncomingMessage):Promise<Record<string,unknown>|undefined>{
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>12_000)return undefined;}
    try{const value=JSON.parse(raw) as unknown;return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}catch{return undefined;}
  }
  private cookieHeader(name:string,path:string,maxAge:number,value=''):string{
    const suffix=this.secureCookies?'; Secure':'';return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0,Math.floor(maxAge))}${suffix}`;
  }
  private sendJson(res:ServerResponse,status:number,value:unknown):void{res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(value));}

  private page(res:ServerResponse,path:string):void{
    const nonce=randomBytes(18).toString('base64');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' https://static-cdn.jtvnw.net; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');
    const pollGuard=`<script nonce="${nonce}">(()=>{const original=window.fetch.bind(window),cache=new Map(),flights=new Map(),retryUntil=new Map();window.fetch=async(input,init={})=>{const method=(init.method||'GET').toUpperCase(),url=new URL(typeof input==='string'?input:input.url,location.href);if(method!=='GET'||url.origin!==location.origin||url.pathname!=='/community/api/state'){const response=await original(input,init);if(method==='POST'&&url.origin===location.origin&&url.pathname.startsWith('/community/api/')&&response.ok)cache.delete(new URL('/community/api/state',location.origin).href);return response}const key=url.href,now=Date.now(),retry=retryUntil.get(key)||0;if(retry>now)return new Response(JSON.stringify({error:'Kurz pausiert'}),{status:429,headers:{'Retry-After':String(Math.ceil((retry-now)/1000)),'Content-Type':'application/json'}});const cached=cache.get(key);if(cached&&now-cached.at<8000)return cached.response.clone();if(flights.has(key))return(await flights.get(key)).clone();const task=(async()=>{const r=await original(input,init);if(r.status===429){const seconds=Math.min(60,Math.max(1,Number(r.headers.get('Retry-After'))||5));retryUntil.set(key,Date.now()+seconds*1000)}else if(r.ok)cache.set(key,{at:Date.now(),response:r.clone()});return r})();flights.set(key,task);try{return(await task).clone()}finally{flights.delete(key)}}})()</script>`;
    const html=renderCommunityPage(path,nonce).replace('</head>',`${pollGuard}</head>`).replace('refresh();setInterval(refresh,4000)','refresh();setInterval(refresh,12000);setInterval(updatePetControls,1000);document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh()})');
    res.end(html);
  }
}

export function renderCommunityPage(path='/community',nonce='preview'):string{
  const active=path==='/community/imposter'?'imposter':path==='/community/quests'?'quests':path==='/community/profile'?'profile':'home';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#11131b"><title>ACY Community · ${active==='imposter'?'Imposter':active==='quests'?'Quests':active==='profile'?'Mein Profil':'Zusammen spielen'}</title><style nonce="${nonce}">
:root{color-scheme:dark;font:16px/1.45 system-ui,-apple-system,sans-serif;background:#11131b;color:#f3f2f8;--muted:#aaaabd;--line:#303142;--panel:#1b1d29;--purple:#a77bfa;--purple2:#6c45b0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 85% -8%,#36264f 0,transparent 34%),#11131b}a{color:inherit;text-decoration:none}button,input,textarea{font:inherit;color:inherit}button,.button{border:1px solid #624993;background:#6c45b0;border-radius:12px;padding:11px 15px;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.secondary{background:#242432;border-color:#38394b}.danger{background:#3b2830;border-color:#68404f}.shell{max-width:1160px;margin:auto;padding:0 22px}.top{height:72px;border-bottom:1px solid #292a38;background:#11131beF;position:sticky;top:0;z-index:5;backdrop-filter:blur(14px)}.topin{height:100%;display:flex;align-items:center;justify-content:space-between;gap:14px}.brand{font-weight:850;letter-spacing:.03em}.brand span{color:var(--purple)}nav{display:flex;gap:8px}nav a{color:#c7c5d2;padding:9px 12px;border-radius:10px}nav a.active,nav a:hover{background:#292139;color:#fff}.profile{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.9rem}.profile img{width:32px;height:32px;border-radius:50%}.main{padding:28px 0 60px}.hero{padding:24px 26px;border:1px solid #463760;border-radius:20px;background:linear-gradient(120deg,#26203a,#1b1d29 70%);margin-bottom:18px}.hero h1{font-size:clamp(1.55rem,3vw,2.25rem);line-height:1.15;margin:0 0 8px}.hero p,.muted{color:var(--muted);margin:0}.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}.card{grid-column:span 6;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;min-width:0}.card.wide{grid-column:span 12}.card.third{grid-column:span 4}.card h2,.card h3{font-size:1.05rem;margin:0 0 10px}.big{font-size:2rem;font-weight:800;color:#e6d8ff}.badge{display:inline-block;color:#e7d8ff;background:#302342;border:1px solid #493565;border-radius:999px;padding:4px 9px;font-size:.82rem}.list{display:grid;gap:8px}.item{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 12px;border:1px solid #303142;border-radius:12px;background:#171923}.avatar{width:42px;height:42px;border-radius:50%;background:#343347;object-fit:cover}.person{display:flex;align-items:center;gap:10px;min-width:0}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.notice{min-height:25px;color:#d7c0ff;margin:8px 0}.hidden{display:none!important}.role{padding:16px;border:1px solid #765aa7;border-radius:14px;background:#251f34}.meter{height:9px;border-radius:99px;background:#313241;overflow:hidden;margin:8px 0}.meter i{display:block;height:100%;background:linear-gradient(90deg,#8055cf,#c49fff)}.form{display:grid;gap:10px}.form textarea{width:100%;min-height:95px;resize:vertical;border:1px solid #414255;background:#12131c;border-radius:12px;padding:12px}.pill{display:inline-flex;gap:7px;align-items:center;padding:7px 10px;border-radius:99px;background:#252331;color:#ded5ef}.rules{color:var(--muted);padding-left:20px}.section{margin-top:14px}.footer{padding:20px 0;color:var(--muted);font-size:.86rem;border-top:1px solid #292a38;margin-top:30px}.pet-action-status{min-height:24px;margin:8px 0;color:#d7c0ff}.pet-action-feed{animation:pet-feed .55s ease}.pet-action-play{animation:pet-play .7s ease}.pet-level-up{animation:pet-level .9s ease}@keyframes pet-feed{50%{transform:translateY(-3px);border-color:#bb91ff}}@keyframes pet-play{50%{transform:scale(1.015);border-color:#bb91ff}}@keyframes pet-level{35%{box-shadow:0 0 0 4px #a77bfa55,0 0 24px #a77bfa99}}@media(prefers-reduced-motion:reduce){.pet-action-feed,.pet-action-play,.pet-level-up{animation:none}}@media(max-width:760px){.shell{padding:0 13px}.top{height:auto}.topin{min-height:62px;flex-wrap:wrap;padding:8px 0}.top nav{order:3;width:100%;overflow-x:auto}.top nav a{white-space:nowrap;font-size:.9rem;padding:8px 10px}.profile{font-size:.8rem}.main{padding-top:16px}.hero{padding:20px}.card,.card.third{grid-column:span 12;padding:15px}.grid{gap:10px}.item{align-items:flex-start}.item button{flex:0 0 auto}}
</style></head><body><header class="top"><div class="shell topin"><a class="brand" href="/community">ACY <span>COMMUNITY</span></a><nav aria-label="Community"><a href="/community" class="${active==='home'?'active':''}">Start</a><a href="/community/imposter" class="${active==='imposter'?'active':''}">Imposter</a><a href="/community/quests" class="${active==='quests'?'active':''}">Quests</a><a href="/community/profile" class="${active==='profile'?'active':''}">Mein Fortschritt</a></nav><div class="profile" id="identity"><a class="button" href="/community/login">Mit Twitch anmelden</a></div></div></header><main class="shell main"><p class="notice" id="notice" role="status" aria-live="polite"></p>
<section data-page="home" class="${active==='home'?'':'hidden'}"><div class="hero"><h1>Schön, dass du da bist 👋</h1><p>Spiel mit der Community, sammle XP und verfolge, was gerade im Stream läuft.</p></div><div class="grid"><article class="card wide"><h2>Gerade in der Community</h2><div id="live-games" class="list"><p class="muted">Wird geladen …</p></div></article><article class="card" id="home-profile"><h2>Dein Fortschritt</h2><p class="muted">Melde dich mit Twitch an, um XP, Level und Rang zu sehen.</p></article><article class="card"><h2>Aktuelles Saison-Event</h2><div id="season"><p class="muted">Gerade ist kein Saison-Event aktiv.</p></div></article><article class="card" id="pet-card"><h2>Elio 🐱</h2><div id="pet"><p class="muted">Wird geladen …</p></div></article><article class="card"><h2>XP-Rangliste</h2><div id="leaderboard" class="list"></div></article><article class="card"><h2>Mystery Drop</h2><div id="drop"><p class="muted">Gerade läuft kein Drop.</p></div></article></div></section>
<section data-page="imposter" class="${active==='imposter'?'':'hidden'}"><div class="hero"><h1>Chat-Imposter 🎭</h1><p>Eine Person kennt die geheime Regel nicht. Spielt gemeinsam im Twitch-Chat und findet sie heraus.</p></div><div class="grid"><article class="card wide"><h2 id="imposter-phase">Runde wird geladen …</h2><p class="muted" id="imposter-countdown"></p><div id="my-role" class="section"></div><div id="imposter-actions" class="actions"></div><p class="notice" id="imposter-message"></p></article><article class="card wide"><h2>Teilnehmende <span class="badge" id="player-count">0</span></h2><p class="muted" id="player-hint"></p><div id="players" class="list"></div></article><article class="card wide hidden" id="voting"><h2>Wen verdächtigst du?</h2><p class="muted">Deine Stimme bleibt bis zur Auflösung geheim.</p><div id="candidates" class="actions"></div></article><article class="card wide hidden" id="imposter-result"><h2>Auflösung</h2><div id="result-content"></div></article></div></section>
<section data-page="quests" class="${active==='quests'?'':'hidden'}"><div class="hero"><h1>Community-Quests 📜</h1><p>Schlag eine faire Aufgabe vor. Jannick oder ein Mod prüft sie, bevor sie öffentlich wird.</p></div><div class="grid"><article class="card"><h2>Quest vorschlagen</h2><form id="quest-form" class="form"><textarea name="title" minlength="8" maxlength="180" placeholder="Zum Beispiel: Schaffe eine Runde ohne Schaden …" required></textarea><button type="submit">Vorschlag einreichen</button></form><p class="muted">Dein Vorschlag ist zunächst nur für dich und das Team sichtbar.</p></article><article class="card"><h2>Deine Vorschläge</h2><div id="my-quests" class="list"></div></article><article class="card wide"><h2>Freigegebene und aktive Quest</h2><div id="approved-quests" class="list"></div></article></div></section>
<section data-page="profile" class="${active==='profile'?'':'hidden'}"><div class="hero"><h1>Mein Fortschritt ✨</h1><p>Deine Spielstände stammen aus demselben XP- und Saisonkonto wie im Twitch-Chat.</p></div><div class="grid"><article class="card" id="profile-stats"><h2>Dein Profil</h2><p class="muted">Melde dich mit Twitch an, um deine Werte zu sehen.</p></article><article class="card"><h2>XP-Rangliste</h2><div id="profile-leaderboard" class="list"></div></article><article class="card wide"><h2>Deine Saisonpunkte</h2><div id="profile-season"></div></article></div></section>
<footer class="footer">Deine Anmeldung dient der Teilnahme und Anzeige deiner Community-Spielstände. Sie gewährt keine Adminrechte. <a href="/hilfe">Befehle und Spielregeln</a>.</footer></main><script nonce="${nonce}">(()=>{const notice=document.querySelector('#notice');let state=null,petCooldownUntil=0,petBusy=false;const text=(n,v)=>{if(n)n.textContent=v??''};const esc=v=>String(v??'');async function post(path,body={}){if(!state?.authenticated)throw Error('Melde dich zuerst mit Twitch an.');const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.viewer.csrfToken},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Aktion fehlgeschlagen.');text(notice,d.message||'Gespeichert.');await refresh()}function cardLine(name,value){const row=document.createElement('div');row.className='item';const a=document.createElement('span'),b=document.createElement('strong');a.textContent=name;b.textContent=value;row.append(a,b);return row}function renderList(node,items,render){if(!node)return;node.replaceChildren();if(!items?.length){const p=document.createElement('p');p.className='muted';p.textContent='Noch nichts vorhanden.';node.append(p);return}for(const item of items)node.append(render(item))}function button(label,action,kind='secondary'){const b=document.createElement('button');b.type='button';b.textContent=label;b.className=kind;b.onclick=async()=>{b.disabled=true;try{await action()}catch(e){text(notice,e.message)}finally{b.disabled=false}};return b}function updatePetControls(){const status=document.querySelector('#pet-cooldown'),remaining=Math.max(0,petCooldownUntil-Date.now()),locked=petBusy||!state?.public?.petEnabled||state?.public?.petPaused||remaining>0;for(const b of document.querySelectorAll('[data-pet-action]'))b.disabled=Boolean(locked);if(status)status.textContent=state?.public?.petPaused?'Elio macht gerade Pflegepause.':!state?.public?.petEnabled?'Die Katzenpflege ist derzeit ausgeschaltet.':remaining>0?'Nächste Pflegeaktion in '+Math.ceil(remaining/1000)+' Sekunden.':'Du kannst Elio füttern oder mit ihm spielen.'}async function runPetAction(kind){if(petBusy)return;petBusy=true;updatePetControls();const before=Number(state?.public?.pet?.level||0);try{const r=await fetch('/community/api/pet',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.viewer.csrfToken},body:JSON.stringify({kind})}),d=await r.json().catch(()=>({}));if(!r.ok){if(Number(d.remainingMs)>0)petCooldownUntil=Date.now()+Number(d.remainingMs);await refresh();const line=document.querySelector('#pet-action-status');if(line)line.textContent=d.error||'Elio konnte gerade nicht versorgt werden.';return}petCooldownUntil=Date.now()+Number(d.remainingMs||0);await refresh();const line=document.querySelector('#pet-action-status'),change=d.changes||{},delta=(label,value)=>value?label+' '+(value>0?'+':'')+value:'',parts=[delta('Sättigung',change.hunger),delta('Zufriedenheit',change.happiness),delta('Energie',change.energy),delta('Elio-XP',change.xp)].filter(Boolean);if(line)line.textContent=(kind==='feed'?'Elio wurde gefüttert. ':'Elio hatte eine Spielrunde. ')+(parts.length?parts.join(' · '):'')+(d.leveledUp?' · Elio ist ein Level aufgestiegen!':'');const card=document.querySelector('#pet-card'),animation=d.leveledUp?'pet-level-up':kind==='feed'?'pet-action-feed':'pet-action-play';card.classList.remove('pet-level-up','pet-action-feed','pet-action-play');void card.offsetWidth;card.classList.add(animation);setTimeout(()=>card.classList.remove(animation),1000)}catch{const line=document.querySelector('#pet-action-status');if(line)line.textContent='Die Verbindung ist fehlgeschlagen. Bitte versuche es erneut.'}finally{petBusy=false;updatePetControls()}}function render(state){const id=document.querySelector('#identity');id.replaceChildren();if(state.authenticated){const viewer=state.viewer;if(viewer.profileImageUrl){const img=document.createElement('img');img.src=viewer.profileImageUrl;img.alt='';id.append(img)}const label=document.createElement('span');label.textContent=viewer.displayName;id.append(label);id.append(button('Abmelden',async()=>{const r=await fetch('/community/logout',{method:'POST',headers:{'X-CSRF-Token':viewer.csrfToken}});if(!r.ok)throw Error('Abmeldung fehlgeschlagen.');location.reload()},'secondary'))}else{const a=document.createElement('a');a.href='/community/login';a.className='button';a.textContent='Mit Twitch anmelden';id.append(a)}const d=state.public,p=state.personal;
const live=document.querySelector('#live-games');live.replaceChildren();const games=[];if(d.imposter)games.push(['🎭 Chat-Imposter',d.imposter.phase+' · '+d.imposter.playerCount+' Mitspielende']);if(d.detective)games.push(['🕵️ Chat-Detektiv',d.detective.phase==='playing'?'Raten läuft':'Auflösung']);if(d.drop?.status&&['announced','claiming','resolving'].includes(d.drop.status))games.push(['🎁 Mystery Drop',d.drop.participants+' dabei · '+Math.max(0,Math.ceil((d.drop.endsAt-Date.now())/1000))+' Sek.']);if(d.activeQuest)games.push(['📜 Community-Quest',d.activeQuest.title]);if(d.wheel?.status==='active')games.push(['🎡 Chaos Wheel',d.wheel.title]);if(d.vault?.status==='active')games.push(['🔐 Community-Tresor',Math.max(0,Math.ceil((d.vault.endsAt-Date.now())/1000))+' Sek. · '+d.vault.attempts+' Versuche']);if(p?.vaultHint)games.push(['Dein letzter Tresor-Hinweis',p.vaultHint.exact+' richtige Stellen · '+p.vaultHint.misplaced+' weitere Ziffern falsch positioniert']);if(!games.length){const z=document.createElement('p');z.className='muted';z.textContent='Gerade läuft kein Community-Spiel.';live.append(z)}else for(const [name,value] of games)live.append(cardLine(name,value));
const hp=document.querySelector('#home-profile');if(p){hp.replaceChildren();const h=document.createElement('h2');h.textContent='Dein Fortschritt';hp.append(h,cardLine('XP / Level',p.xp+' XP · Level '+p.level),cardLine('Rang',p.rank?'#'+p.rank:'Noch nicht gelistet'));const meter=document.createElement('div');meter.className='meter';const fill=document.createElement('i');fill.style.width=p.progress?Math.min(100,Math.round(p.progress.current/p.progress.needed*100))+'%':'0%';meter.append(fill);hp.append(meter)}
const season=document.querySelector('#season');season.replaceChildren();if(d.activeEvent){const h=document.createElement('p');h.textContent=d.activeEvent.emoji+' '+d.activeEvent.name+(p?' · Du hast '+(p.eventPoints||0)+' '+d.activeEvent.currency:'');season.append(h);if(p&&state.authenticated)season.append(button('Mitmachen',()=>post('/community/api/event'),'secondary'));if(d.activeEvent.top?.length){const ol=document.createElement('ol');for(const x of d.activeEvent.top){const li=document.createElement('li');li.textContent=x.name+' · '+x.points+' '+d.activeEvent.currency;ol.append(li)}season.append(ol)}}else{const z=document.createElement('p');z.className='muted';z.textContent='Gerade ist kein Saison-Event aktiv.';season.append(z)}
const pet=document.querySelector('#pet');pet.replaceChildren();petCooldownUntil=Date.now()+Number(p?.petAction?.remainingMs||0);if(d.pet){pet.append(cardLine(d.pet.name+' · '+d.pet.stageLabel,'Level '+d.pet.level),cardLine('Hunger',d.pet.hunger+'%'),cardLine('Energie',d.pet.energy+'%'),cardLine('Zufriedenheit',d.pet.happiness+'%'));if(state.authenticated){const line=document.createElement('p');line.id='pet-action-status';line.className='pet-action-status';line.setAttribute('role','status');line.setAttribute('aria-live','polite');line.textContent=d.petPaused?'Elio macht gerade Pflegepause.':p?.petAction?.remainingMs>0?'Deine letzte Aktion ist noch in der Wartezeit.':'';const cooldown=document.createElement('p');cooldown.id='pet-cooldown';cooldown.className='muted';const actions=document.createElement('div');actions.className='actions';const feed=button('Füttern',()=>{}),play=button('Mit Elio spielen',()=>{});feed.dataset.petAction='feed';play.dataset.petAction='play';feed.onclick=()=>runPetAction('feed');play.onclick=()=>runPetAction('play');actions.append(feed,play);pet.append(line,cooldown,actions)}}else{const z=document.createElement('p');z.className='muted';z.textContent=d.petEnabled?'Elio macht gerade Pflegepause.':'Die Katzenpflege ist derzeit ausgeschaltet.';pet.append(z)}updatePetControls()
renderList(document.querySelector('#leaderboard'),d.leaderboard,x=>cardLine('#'+x.rank+' '+x.name,x.xp+' XP'));renderList(document.querySelector('#profile-leaderboard'),d.leaderboard,x=>cardLine('#'+x.rank+' '+x.name,x.xp+' XP'));
const drop=document.querySelector('#drop');drop.replaceChildren();if(d.drop&&['announced','claiming','resolving'].includes(d.drop.status)){drop.append(cardLine('Teilnehmende',String(d.drop.participants)),cardLine('Noch',Math.max(0,Math.ceil((d.drop.endsAt-Date.now())/1000))+' Sek.'));if(state.authenticated){if(d.drop.participated){const p=document.createElement('p');p.className='pill';p.textContent='Du bist dabei 🎉';drop.append(p)}else drop.append(button('Am Drop teilnehmen',()=>post('/community/api/drop/claim')))}}else if(d.drop?.status==='completed'&&d.drop.result){drop.append(cardLine('Ergebnis',d.drop.result.participants+' Teilnehmende'));const z=document.createElement('p');z.className='muted';z.textContent=d.drop.result.participants?'Belohnung: '+d.drop.result.rewardXp+' XP pro Person.':'Diesmal hat niemand teilgenommen.';drop.append(z)}else{const z=document.createElement('p');z.className='muted';z.textContent='Gerade läuft kein Drop.';drop.append(z)}
const game=d.imposter;const phaseNames={registration:'Anmeldung läuft',role_distribution:'Rollen werden verteilt',playing:'Diskussion im Twitch-Chat',voting:'Abstimmung',results:'Auflösung',finished:'Runde beendet',canceled:'Runde abgebrochen'};text(document.querySelector('#imposter-phase'),game?'🎭 '+(phaseNames[game.phase]||'Runde aktiv'):'Noch keine Runde aktiv');text(document.querySelector('#imposter-countdown'),game?.endsAt?'Noch '+Math.max(0,Math.ceil((game.endsAt-Date.now())/1000))+' Sekunden · '+game.playerCount+' von '+game.maxPlayers+' Mitspielenden':'Jannick oder Mods starten die Runde im Stream.');text(document.querySelector('#player-count'),game?.playerCount||0);text(document.querySelector('#player-hint'),game?'Mindestens '+game.minPlayers+' Mitspielende werden benötigt.':'Sobald die Anmeldung startet, erscheinen hier alle Mitspielenden.');renderList(document.querySelector('#players'),game?.players,x=>cardLine(x.displayName,'Dabei'));const roleNode=document.querySelector('#my-role');roleNode.replaceChildren();if(game?.role){const role=document.createElement('div');role.className='role';role.textContent=game.role.kind==='imposter'?'Du bist der IMPOSTER! Beobachte den Chat und falle nicht auf.':'Deine geheime Regel: '+game.role.rule;roleNode.append(role)}else if(game?.participant&&['registration','role_distribution'].includes(game.phase)){roleNode.append(document.createTextNode('Du bist angemeldet. Deine Rolle erscheint hier, sobald die Runde startet.'))}
const acts=document.querySelector('#imposter-actions');acts.replaceChildren();if(!state.authenticated){const a=document.createElement('a');a.href='/community/login';a.className='button';a.textContent='Mit Twitch anmelden zum Mitspielen';acts.append(a)}else if(game?.canJoin)acts.append(button('Jetzt mitspielen',()=>post('/community/api/imposter/join')));else if(game?.canLeave)acts.append(button('Abmelden',()=>post('/community/api/imposter/leave'),'secondary'));else if(!game)acts.append(document.createTextNode('Warte, bis Jannick die Anmeldung öffnet.'));
const voting=document.querySelector('#voting');voting.classList.toggle('hidden',game?.phase!=='voting');const candidates=document.querySelector('#candidates');candidates.replaceChildren();if(game?.phase==='voting')for(const name of game.candidates)candidates.append(button(name===game.myVote?'Deine Stimme: '+name:'Für '+name,()=>post('/community/api/imposter/vote',{target:name}),name===game.myVote?'':'secondary'));
const result=document.querySelector('#imposter-result');result.classList.toggle('hidden',!game?.result);if(game?.result){const node=document.querySelector('#result-content');node.replaceChildren(cardLine('Imposter',game.result.imposterName),cardLine('Geheime Regel',game.result.rule),cardLine('Stimmen',game.result.votes+' abgegeben'));const p=document.createElement('p');p.textContent=game.result.neutral?'Die Runde endete unentschieden.':game.result.caught?'Die Community hat den Imposter enttarnt!':'Der Imposter hat die Runde gewonnen.';node.append(p);if(game.result.winners?.length)node.append(cardLine('Gewinner',game.result.winners.join(', ')));if(game.result.myXp!==null)node.append(cardLine('Deine gutgeschriebenen XP',game.result.myXp+' XP'));node.append(cardLine('Insgesamt gutgeschrieben',game.result.xpAwarded+' XP'))}
const questEnabled=d.questsEnabled;document.querySelector('#quest-form').classList.toggle('hidden',!state.authenticated||!questEnabled);renderList(document.querySelector('#my-quests'),p?.quests,x=>cardLine(x.title,x.status));const approved=document.querySelector('#approved-quests');approved.replaceChildren();if(d.activeQuest)approved.append(cardLine(d.activeQuest.title,'Läuft gerade'));for(const q of d.approvedQuests||[])approved.append(cardLine(q.title,q.game||'Freigegeben'));if(!d.activeQuest&&!(d.approvedQuests||[]).length){const z=document.createElement('p');z.className='muted';z.textContent=questEnabled?'Noch keine Community-Quest freigegeben.':'Quest-Vorschläge sind derzeit pausiert.';approved.append(z)}
const prof=document.querySelector('#profile-stats');if(p){prof.replaceChildren();const h=document.createElement('h2');h.textContent='Dein Profil';prof.append(h,cardLine('Gesamt-XP',p.xp+' XP'),cardLine('Level',''+p.level),cardLine('Rang',p.rank?'#'+p.rank:'Noch nicht gelistet'),cardLine('Saisonpunkte',p.eventPoints===null?'—':String(p.eventPoints)))} }
async function refresh(){try{const r=await fetch('/community/api/state',{cache:'no-store'});if(!r.ok)throw Error();state=await r.json();render(state)}catch{text(notice,'Die Community-Seite kann gerade nicht aktualisiert werden.')}}document.querySelector('#quest-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;try{await post('/community/api/quest',{title:new FormData(form).get('title')});form.reset()}catch(err){text(notice,err.message)}};refresh();setInterval(refresh,4000);})();</script></body></html>`;
}
