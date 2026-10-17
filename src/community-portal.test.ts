import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { CommunityFeatures } from './community-features.js';
import { ViewerCommunityPortal, renderCommunityPage } from './community-portal.js';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';
import { testConfig } from './test-config.js';

async function port():Promise<number>{const s=net.createServer();await new Promise<void>((resolve,reject)=>s.once('error',reject).listen(0,'127.0.0.1',resolve));const n=(s.address() as net.AddressInfo).port;await new Promise<void>(resolve=>s.close(()=>resolve()));return n;}
function chat(userId:string,login:string,name:string,text:string):import('./types.js').ChatMessage{return {eventId:`evt-${userId}-${Date.now()}-${Math.random()}`,messageId:`msg-${userId}`,broadcasterUserId:'broadcaster-1',senderUserId:userId,senderLogin:login,senderDisplayName:name,message:text,sentAt:Date.now(),isModerator:false};}
function cookies(response:Response):string[]{const h=response.headers as Headers&{getSetCookie?:()=>string[]};return h.getSetCookie?.()||[response.headers.get('set-cookie')||''];}

test('Community portal serves an independent mobile-first shell and keeps private APIs read-only without login',async()=>{
  const html=renderCommunityPage('/community/imposter','test-nonce');
  assert.match(html,/Chat-Imposter/);assert.match(html,/Jetzt mitspielen/);assert.match(html,/Stimmen mit <strong>!sus @Name<\/strong> im Twitch-Chat sind öffentlich/u);assert.match(html,/@media\(max-width:760px\)/);assert.match(html,/name="viewport"/);
  assert.doesNotMatch(html,/dashboard\/api|community_admin|Twitch-ID/u);
  const scripts=[...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/gu)];assert.equal(scripts.length,1);for(const [,script] of scripts)new vm.Script(script||'');
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'community-public-')),database=path.join(directory,'state.sqlite'),db=new FeatureStore(database);
  const p=await port();process.env.TWITCH_CLIENT_ID='portal-client';process.env.TWITCH_CLIENT_SECRET='portal-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(p);
  const cfg=testConfig({clientId:'portal-client',clientSecret:'portal-secret',redirectUri:'https://bot.example.test/dashboard/oauth/callback'}),features=new CommunityFeatures(db,cfg),portal=new ViewerCommunityPortal(db,features,cfg,fetch);
  const dashboard=new DashboardServer(db,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetch,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  try{assert.equal(await dashboard.start(),true);const base=`http://127.0.0.1:${p}`;
    for(const page of ['/community','/community/imposter','/community/quests','/community/profile','/community/ideen','/community/login','/community/datenschutz']){const r=await fetch(base+page);assert.equal(r.status,200,page);assert.equal(r.headers.get('cache-control'),'no-store');if(page==='/community'){const html=await r.text();assert.match(html,/community\/api\/state/u);assert.match(html,/now-cached\.at<8000/u);assert.match(html,/setInterval\(refresh,12000\)/u);assert.doesNotMatch(html,/setInterval\(refresh,4000\)/u)}if(page==='/community/ideen'){const html=await r.text();assert.match(html,/Community-Ideen/u);assert.match(html,/!idee DEIN VORSCHLAG/u);assert.match(html,/community\/api\/ideas/u)}}
    const pub=await fetch(base+'/community/api/state');assert.equal(pub.status,200);const publicState=await pub.json() as {authenticated:boolean;personal?:unknown;public:{leaderboard:Array<{name:string;rank:number}>}};assert.equal(publicState.authenticated,false);assert.equal(publicState.personal,null);
    const abuseBurst=await Promise.all(Array.from({length:65},()=>fetch(base+'/community/api/state')));const limited=abuseBurst.find(r=>r.status===429);assert.ok(limited,'anonyme Missbrauchslast wird weiterhin begrenzt');assert.ok(Number(limited.headers.get('Retry-After'))>=1,'429 liefert Retry-After');
    const denied=await fetch(base+'/community/api/imposter/join',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,401);
    assert.equal((await fetch(base+'/community/api/ideas')).status,200,'freigegebene Ideen können öffentlich gelesen werden');
    assert.equal((await fetch(base+'/community/api/ideas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Nicht angemeldete Idee'})})).status,401,'Einreichungen erfordern Twitch-Session');
    assert.equal((await fetch(base+'/dashboard/api/ideas')).status,401,'Viewer-Route gewährt keine Moderationsrechte');
    const admin=await fetch(base+'/dashboard',{redirect:'manual'});assert.equal(admin.status,302,'viewer route does not grant admin access');
  }finally{await dashboard.stop();db.close();process.env=env;fs.rmSync(directory,{recursive:true,force:true});}
});

test('Viewer OAuth is state-bound, session-backed and shares Imposter registration, role, vote and XP with Twitch chat',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'community-e2e-')),database=path.join(directory,'state.sqlite'),store=new FeatureStore(database),p=await port();
  process.env.TWITCH_CLIENT_ID='portal-client';process.env.TWITCH_CLIENT_SECRET='portal-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(p);
  const cfg=testConfig({clientId:'portal-client',clientSecret:'portal-secret',redirectUri:'https://bot.example.test/dashboard/oauth/callback'}),features=new CommunityFeatures(store,cfg);
  features.miniGames.updateSettings({...features.miniGames.settings(),enabled:true,imposter:{...features.miniGames.settings().imposter,minPlayers:3,maxPlayers:8,registrationMs:600_000,playMs:600_000,votingMs:300_000,cooldownMs:0}});
  features.arcade.updateSettings({...features.arcade.settings(),petEnabled:true,dropsEnabled:true});
  let validatedUser='viewer-secret-id';let tokenExchangeCalls=0;
  const fetchImpl:typeof fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/oauth2/token')){tokenExchangeCalls++;return Response.json({access_token:'short-lived-viewer-token'});}if(url.endsWith('/oauth2/validate')){assert.equal(new Headers(init?.headers).get('Authorization'),'OAuth short-lived-viewer-token');return Response.json({client_id:'portal-client',user_id:validatedUser});}if(url.endsWith('/helix/users'))return Response.json({data:[{id:validatedUser,login:'viewer_name',display_name:'Viewer Name',profile_image_url:'https://static-cdn.jtvnw.net/avatar.png'}]});throw new Error(`Unexpected Twitch endpoint ${url}`);};
  const portal=new ViewerCommunityPortal(store,features,cfg,fetchImpl),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  try{assert.equal(await dashboard.start(),true);const base=`http://127.0.0.1:${p}`;
    features.miniGames.startImposter('broadcaster-1');
    const login=await fetch(base+'/community/login/twitch',{redirect:'manual'});assert.equal(login.status,302);const auth=new URL(login.headers.get('location')||'');assert.equal(auth.searchParams.get('scope'),'');assert.equal(auth.searchParams.get('redirect_uri'),cfg.redirectUri);
    const state=auth.searchParams.get('state')||'',stateCookie=cookies(login).find(x=>x.startsWith('community_oauth_state='))?.split(';')[0]||'';assert.ok(stateCookie);
    const mismatch=await fetch(`${base}/dashboard/oauth/callback?code=fake&state=${state}`,{headers:{cookie:'community_oauth_state=wrong'},redirect:'manual'});assert.equal(mismatch.status,400);assert.equal(tokenExchangeCalls,0);
    const login2=await fetch(base+'/community/login/twitch',{redirect:'manual'}),auth2=new URL(login2.headers.get('location')||''),state2=auth2.searchParams.get('state')||'',stateCookie2=cookies(login2).find(x=>x.startsWith('community_oauth_state='))?.split(';')[0]||'';
    const callback=await fetch(`${base}/dashboard/oauth/callback?code=authorized&state=${state2}`,{headers:{cookie:stateCookie2},redirect:'manual'});assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/community');
    const viewerCookie=cookies(callback).find(x=>x.startsWith('community_viewer='))?.split(';')[0]||'';assert.ok(viewerCookie);assert.match(cookies(callback).find(x=>x.startsWith('community_viewer='))||'',/HttpOnly; SameSite=Lax; Max-Age=43200; Secure/u);
    const stateResponse=await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}});const stateJson=await stateResponse.json() as any;assert.equal(stateJson.authenticated,true);assert.equal(stateJson.viewer.displayName,'Viewer Name');assert.equal(JSON.stringify(stateJson).includes('viewer-secret-id'),false);assert.equal(JSON.stringify(stateJson).includes('short-lived-viewer-token'),false);
    const viewerTabs=await Promise.all(Array.from({length:4},()=>Array.from({length:35},()=>fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}}))).flat());assert.equal(viewerTabs.length,140);assert.ok(viewerTabs.every(r=>r.status===200),'vier parallele Viewer-Tabs bleiben innerhalb des nutzerbezogenen Leselimits');
    const csrf=stateJson.viewer.csrfToken;
    const livePoll=store.createPoll({type:'chat',question:'Welche Strategie?',options:[{label:'Vorsichtig'},{label:'Mutig'}],durationMs:60_000,allowVoteChange:false,createdBy:'admin-only',now:Date.now()});assert.ok(livePoll);
    const pollVote=await fetch(base+'/community/api/poll/vote',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({pollId:livePoll.id,option:2})});assert.equal(pollVote.status,200,await pollVote.clone().text());
    const pollRepeat=await fetch(base+'/community/api/poll/vote',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({pollId:livePoll.id,option:1})});assert.equal(pollRepeat.status,409,'ein Zuschauer darf seine Stimme nicht ändern oder ein zweites Mal abgeben');
    const pollState=await(await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any;assert.equal(pollState.personal.livePollOption,2);assert.equal(pollState.public.livePoll.options[1].votes,1);assert.equal(JSON.stringify(pollState.public.livePoll).includes('viewer-secret-id'),false);
    store.endPoll(livePoll.id,Date.now());
    const badCsrf=await fetch(base+'/community/api/imposter/join',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':'bad'},body:'{}'});assert.equal(badCsrf.status,403);
    const webJoin=await fetch(base+'/community/api/imposter/join',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});assert.equal(webJoin.status,200);
    assert.match(features.miniGames.handle(chat('chat-user-1','chat_one','Chat One','!joinimposter'),'joinimposter',[])||'',/ist dabei/u);
    assert.match(features.miniGames.handle(chat('chat-user-2','chat_two','Chat Two','!joinimposter'),'joinimposter',[])||'',/ist dabei/u);
    let snapshot=await (await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any;
    assert.deepEqual(snapshot.public.imposter.players.map((x:any)=>x.displayName).sort(),['Chat One','Chat Two','Viewer Name'].sort());
    assert.doesNotMatch(JSON.stringify(snapshot.public.imposter),/viewer-secret-id|chat-user-/u);assert.equal(snapshot.public.imposter.role,null);
    features.miniGames.startRoles('broadcaster-1');snapshot=await (await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any;
    assert.ok(['imposter','player'].includes(snapshot.public.imposter.role.kind));assert.equal(snapshot.public.imposter.players.some((x:any)=>'role'in x),false);
    const sessionRaw=viewerCookie.split('=')[1]||'',reopened=new FeatureStore(database);assert.equal(reopened.viewerSession(createHash('sha256').update(sessionRaw).digest('hex'),Date.now())?.userId,validatedUser,'viewer session survives opening the same SQLite database after a process restart');
    const afterReload=await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}});const afterState=await afterReload.json() as any;assert.equal(afterState.authenticated,true);assert.equal(afterState.public.imposter.role.kind,snapshot.public.imposter.role.kind);
    const mini=features.miniGames;mini.beginVote(Date.now());
    const voting=await (await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any;assert.equal(voting.public.imposter.phase,'voting');assert.ok(voting.public.imposter.candidates.length>=1);
    const target=voting.public.imposter.candidates[0];const vote=await fetch(base+'/community/api/imposter/vote',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({target})});assert.equal(vote.status,200);
    const repeat=await fetch(base+'/community/api/imposter/vote',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({target})});assert.equal(repeat.status,200);assert.match((await repeat.json() as any).message,/bereits abgestimmt/u);
    reopened.miniGameQuery(db=>db.prepare("UPDATE imposter_rounds SET phase_ends_at=? WHERE phase='voting'").run(Date.now()-1));mini.tick(Date.now()+1);reopened.close();
    const results=await (await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any;assert.equal(results.public.imposter.phase,'results');assert.ok(results.public.imposter.result.xpAwarded>0);assert.ok(results.public.imposter.result.myXp>0);
    const adminRoute=await fetch(base+'/dashboard/api/overview',{headers:{cookie:viewerCookie}});assert.equal(adminRoute.status,401);
    const logout=await fetch(base+'/community/logout',{method:'POST',headers:{cookie:viewerCookie,'X-CSRF-Token':csrf}});assert.equal(logout.status,200);const loggedOut=await (await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any;assert.equal(loggedOut.authenticated,false);
  }finally{await dashboard.stop();try{store.close()}catch{}process.env=env;fs.rmSync(directory,{recursive:true,force:true});}
});

test('Discord account linking uses a one-time short-lived intent bound to the Twitch OAuth state',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),p=await port();
  process.env.TWITCH_CLIENT_ID='portal-client';process.env.TWITCH_CLIENT_SECRET='portal-secret';process.env.DASHBOARD_REDIRECT_URI=`http://127.0.0.1:${p}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(p);process.env.DISCORD_INTEGRATION_SECRET='synthetic-integration-secret-123456789';
  store.setConfig('discord_integration',{enabled:true,accountLinkEnabled:true});
  const cfg=testConfig({clientId:'portal-client',clientSecret:'portal-secret',redirectUri:`http://127.0.0.1:${p}/dashboard/oauth/callback`}),features=new CommunityFeatures(store,cfg);
  const fetchImpl:typeof fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'synthetic-viewer-access'});if(url.endsWith('/oauth2/validate'))return Response.json({client_id:'portal-client',user_id:'twitch-account-1'});if(url.endsWith('/helix/users'))return Response.json({data:[{id:'twitch-account-1',login:'linked_viewer',display_name:'Linked Viewer'}]});throw new Error(`Unexpected Twitch endpoint ${url}`);};
  const portal=new ViewerCommunityPortal(store,features,cfg,fetchImpl),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  const auth={authorization:'Bearer synthetic-integration-secret-123456789','content-type':'application/json'};
  try{
    assert.equal(await dashboard.start(),true);const base=`http://127.0.0.1:${p}/api/discord/v1`;
    const intent=await fetch(`${base}/account-links/intents`,{method:'POST',headers:auth,body:JSON.stringify({discordUserId:'1206225751544832053'})});assert.equal(intent.status,201);
    const {authorizationUrl}=await intent.json() as {authorizationUrl:string};
    const publicLink=new URL(authorizationUrl),token=publicLink.hash.slice('#token='.length),consent=await fetch(`http://127.0.0.1:${p}${publicLink.pathname}`);assert.equal(consent.status,200);assert.equal(consent.headers.get('referrer-policy'),'no-referrer');assert.match(await consent.text(),/XP oder Spielstände werden nicht kopiert/u);
    const start=await fetch(`http://127.0.0.1:${p}${publicLink.pathname}`,{method:'POST',headers:{Origin:`http://127.0.0.1:${p}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),redirect:'manual'});assert.equal(start.status,302);assert.equal(start.headers.get('referrer-policy'),'no-referrer');
    const twitchAuth=new URL(start.headers.get('location')||''),state=twitchAuth.searchParams.get('state')||'';
    const stateCookie=cookies(start).find(value=>value.startsWith('community_oauth_state='))?.split(';')[0]||'';assert.ok(stateCookie);
    const callback=await fetch(`http://127.0.0.1:${p}/dashboard/oauth/callback?code=linked&state=${state}`,{headers:{cookie:stateCookie},redirect:'manual'});
    assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/community/link/complete');
    const linkedRow=store.miniGameQuery(db=>db.prepare('SELECT linked_at FROM community_account_links WHERE discord_user_id=?').get('1206225751544832053') as {linked_at:number});
    assert.deepEqual(store.communityAccountLinkStatus('1206225751544832053'),{linked:true,linkedAt:linkedRow.linked_at});
    const replay=await fetch(`http://127.0.0.1:${p}/dashboard/oauth/callback?code=linked&state=${state}`,{headers:{cookie:stateCookie},redirect:'manual'});assert.equal(replay.status,400,'Twitch OAuth state is one-time');
    const expired=await fetch(`http://127.0.0.1:${p}${publicLink.pathname}`,{method:'POST',headers:{Origin:`http://127.0.0.1:${p}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),redirect:'manual'});assert.equal(expired.status,410,'link bearer is consumed after account linking');
    const completion=await fetch(`http://127.0.0.1:${p}/community/link/complete`);assert.equal(completion.status,200);assert.match(await completion.text(),/keine Konten oder XP-Stände zusammengeführt/u);
  }finally{await dashboard.stop();store.close();process.env=env;}
});

test('Community web actions reuse quest, Elio and Mystery Drop eligibility/cooldowns and storage',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'community-actions-')),store=new FeatureStore(path.join(directory,'state.sqlite')),p=await port();
  process.env.TWITCH_CLIENT_ID='portal-client';process.env.TWITCH_CLIENT_SECRET='portal-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(p);
  const cfg=testConfig({clientId:'portal-client',clientSecret:'portal-secret',redirectUri:'https://bot.example.test/dashboard/oauth/callback'}),features=new CommunityFeatures(store,cfg);
  features.arcade.updateSettings({...features.arcade.settings(),petEnabled:true,dropsEnabled:true});
  store.setConfig('quest_settings',{enabled:true,chatEnabled:true,maxLength:180,queueLimit:100,maxOpenPerUser:2,cooldownMs:300_000,activeDurationMs:0,completionXp:25,channelPointsEnabled:false,modsCanModerate:false,modsCanSkip:false,moderatorUserIds:[]});
  const fetchImpl:typeof fetch=async input=>String(input).endsWith('/oauth2/token')?Response.json({access_token:'token'}):String(input).endsWith('/oauth2/validate')?Response.json({client_id:'portal-client',user_id:'viewer-id'}):String(input).endsWith('/helix/users')?Response.json({data:[{id:'viewer-id',login:'viewer',display_name:'Viewer'}]}):Response.error();
  const portal=new ViewerCommunityPortal(store,features,cfg,fetchImpl),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  try{await dashboard.start();const base=`http://127.0.0.1:${p}`,login=await fetch(base+'/community/login/twitch',{redirect:'manual'}),auth=new URL(login.headers.get('location')||''),sc=cookies(login).find(x=>x.startsWith('community_oauth_state='))?.split(';')[0]||'',cb=await fetch(`${base}/dashboard/oauth/callback?code=x&state=${auth.searchParams.get('state')}`,{headers:{cookie:sc},redirect:'manual'}),vc=cookies(cb).find(x=>x.startsWith('community_viewer='))?.split(';')[0]||'',s=await (await fetch(base+'/community/api/state',{headers:{cookie:vc}})).json() as any,csrf=s.viewer.csrfToken;
    const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{cookie:vc,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
    const quest=await post('/community/api/quest',{title:'Finde den geheimen Schatz'});assert.equal(quest.status,200);let state=await (await fetch(base+'/community/api/state',{headers:{cookie:vc}})).json() as any;assert.equal(state.personal.quests[0].status,'pending');assert.equal(state.public.approvedQuests.some((q:any)=>q.title==='Finde den geheimen Schatz'),false);
    const ideaResponse=await post('/community/api/ideas',{text:'Ein gemeinsamer Filmabend mit der Community'});assert.equal(ideaResponse.status,201);const ideaData=await ideaResponse.json() as any;const publicIdeas=await(await fetch(base+'/community/api/ideas',{headers:{cookie:vc}})).json() as any;assert.equal(publicIdeas.items.some((x:any)=>x.id===ideaData.idea.id),false,'private Ideen bleiben bis zur Moderationsfreigabe verborgen');assert.ok(publicIdeas.mine.some((x:any)=>x.id===ideaData.idea.id),'die einreichende Person sieht den eigenen Status: '+JSON.stringify(publicIdeas.mine));
    assert.equal(store.moderateCommunityIdea(ideaData.idea.id,'approve','moderator-id',Date.now()),true);const approvedIdeas=await(await fetch(base+'/community/api/ideas')).json() as any;assert.ok(approvedIdeas.items.some((x:any)=>x.id===ideaData.idea.id));assert.equal((await post('/community/api/ideas/vote',{id:ideaData.idea.id})).status,200);assert.equal((await post('/community/api/ideas/vote',{id:ideaData.idea.id})).status,409,'Likes sind je Twitch-Nutzer eindeutig');
    const noLogin=await fetch(base+'/community/api/pet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'feed'})});assert.equal(noLogin.status,401);const parallelFeeds=await Promise.all([post('/community/api/pet',{kind:'feed'}),post('/community/api/pet',{kind:'feed'})]);assert.deepEqual(parallelFeeds.map(r=>r.status).sort(),[200,409]);const feed=parallelFeeds.find(r=>r.status===200)!;const feedResult=await feed.json() as any;assert.equal(feedResult.ok,true);assert.equal(typeof feedResult.reaction,'string');assert.ok(feedResult.reaction.length>0);assert.equal(feedResult.changes.hunger,8);assert.equal(feedResult.pet.hunger,78);assert.equal(feedResult.remainingMs,features.arcade.settings().petCooldownMs);const repeatedFeed=await post('/community/api/pet',{kind:'feed'});assert.equal(repeatedFeed.status,409);const cooldown=await repeatedFeed.json() as any;assert.equal(cooldown.ok,false);assert.match(cooldown.error,/warte/u);assert.ok(cooldown.remainingMs>0);features.arcade.handle({...{eventId:'pause-pet',senderUserId:'broadcaster-1',senderLogin:'owner',senderDisplayName:'Owner',broadcasterUserId:'broadcaster-1',message:'!petpause',sentAt:Date.now(),isModerator:false}},'petpause',[],Date.now());const paused=await post('/community/api/pet',{kind:'play'});assert.equal(paused.status,409);assert.match((await paused.json() as any).error,/Pflegepause/u);features.arcade.updateSettings({...features.arcade.settings(),petEnabled:false});const disabled=await post('/community/api/pet',{kind:'feed'});assert.equal(disabled.status,409);assert.match((await disabled.json() as any).error,/deaktiviert/u);features.arcade.updateSettings({...features.arcade.settings(),petEnabled:true});features.arcade.handle({eventId:'resume-pet',senderUserId:'broadcaster-1',senderLogin:'owner',senderDisplayName:'Owner',broadcasterUserId:'broadcaster-1',message:'!petresume',sentAt:Date.now(),isModerator:false},'petresume',[],Date.now());
    features.arcade.startDropAdmin('broadcaster-1',undefined);const claim=await post('/community/api/drop/claim',{});assert.equal(claim.status,200);const dropState=await (await fetch(base+'/community/api/state',{headers:{cookie:vc}})).json() as any;assert.equal(dropState.public.drop.participants,1);assert.equal(dropState.public.drop.participated,true);
  }finally{await dashboard.stop();store.close();process.env=env;fs.rmSync(directory,{recursive:true,force:true});}
});
