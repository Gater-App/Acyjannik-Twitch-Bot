import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { CommunityFeatures } from './community-features.js';
import { ViewerCommunityPortal } from './community-portal.js';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';
import { testConfig } from './test-config.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
function setCookies(response:Response):string[]{const headers=response.headers as Headers&{getSetCookie?:()=>string[]};return headers.getSetCookie?.()||[response.headers.get('set-cookie')||''];}

test('Geheimwort-Portal nutzt OAuth-Session, CSRF und eigene Rolle; öffentliche API und OBS bleiben geheim',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort();
  process.env.TWITCH_CLIENT_ID='portal-client';process.env.TWITCH_CLIENT_SECRET='portal-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  const config=testConfig({clientId:'portal-client',clientSecret:'portal-secret',redirectUri:'https://bot.example.test/dashboard/oauth/callback'}),features=new CommunityFeatures(store,config);
  features.secretWordImposter.updateSettings({...features.secretWordImposter.settings(),enabled:true,minPlayers:3,maxPlayers:5,cooldownMs:0});
  let validatedUser='viewer-word-id';
  const fetchImpl:typeof fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'test-token'});if(url.endsWith('/oauth2/validate')){assert.equal(new Headers(init?.headers).get('Authorization'),'OAuth test-token');return Response.json({client_id:'portal-client',user_id:validatedUser});}if(url.endsWith('/helix/users'))return Response.json({data:[{id:validatedUser,login:validatedUser==='viewer-word-id'?'viewerword':'outsiderword',display_name:validatedUser==='viewer-word-id'?'Viewer Word':'Outsider'}]});return Response.error();};
  const portal=new ViewerCommunityPortal(store,features,config,fetchImpl);
  const dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal,
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,features.secretWordImposter);
  try{
    assert.equal(await dashboard.start(),true);const base=`http://127.0.0.1:${port}`;
    assert.equal(features.secretWordImposter.start('admin').ok,true);
    const anonymous=await fetch(base+'/community/api/word-imposter/state?userId=viewer-word-id');assert.equal(anonymous.status,200);const anon=await anonymous.json() as any;
    assert.equal(anon.mine,null);assert.equal(anon.viewer,null);assert.doesNotMatch(JSON.stringify(anon),/secret_word|viewer-word-id|role|Abenteuer/u);
    const page=await fetch(base+'/community/imposter-word');assert.equal(page.status,200);assert.match(page.headers.get('cache-control')||'',/no-store/u);assert.match(page.headers.get('content-security-policy')||'',/frame-ancestors 'none'/u);const html=await page.text();assert.match(html,/@media\(max-width:680px\)/u);assert.match(html,/nur nach Twitch-Anmeldung sichtbar/u);for(const [,script] of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/gu))new vm.Script(script||'');
    const oldPage=await(await fetch(base+'/community/imposter')).text();assert.match(oldPage,/href="\/community\/imposter-word"/u);
    const login=await fetch(base+'/community/login/twitch',{redirect:'manual'}),auth=new URL(login.headers.get('location')||''),state=auth.searchParams.get('state')||'',stateCookie=setCookies(login).find(value=>value.startsWith('community_oauth_state='))?.split(';')[0]||'';
    const callback=await fetch(`${base}/dashboard/oauth/callback?code=viewer&state=${state}`,{headers:{cookie:stateCookie},redirect:'manual'});assert.equal(callback.status,303);const viewerCookie=setCookies(callback).find(value=>value.startsWith('community_viewer='))?.split(';')[0]||'';assert.ok(viewerCookie);
    const stateResponse=await fetch(base+'/community/api/word-imposter/state',{headers:{cookie:viewerCookie}}),stateJson=await stateResponse.json() as any,csrf=stateJson.csrfToken;assert.equal(stateJson.authenticated,true);assert.equal(stateJson.mine,null);
    const noSession=await fetch(base+'/community/api/word-imposter/join',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(noSession.status,401);
    const badCsrf=await fetch(base+'/community/api/word-imposter/join',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':'bad'},body:'{}'});assert.equal(badCsrf.status,403);
    const join=()=>fetch(base+'/community/api/word-imposter/join',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});
    assert.equal((await join()).status,200);assert.equal((await join()).status,409);
    for(let i=1;i<=2;i++)assert.equal(features.secretWordImposter.join({userId:`chat-word-${i}`,login:`chatword${i}`,displayName:`Chat Word ${i}`}).ok,true);
    assert.equal(features.secretWordImposter.startRoles('admin').ok,true);
    const own=await(await fetch(base+'/community/api/word-imposter/state?userId=chat-word-1',{headers:{cookie:viewerCookie}})).json() as any;
    const direct=features.secretWordImposter.privateRole('viewer-word-id');assert.deepEqual(own.mine,direct);assert.equal(own.viewer.isParticipant,true);assert.equal(own.viewer.isImposter,direct?.role==='imposter');
    const publicCopy=JSON.stringify(own.game);assert.doesNotMatch(publicCopy,/secret_word|imposter_id|viewer-word-id|chat-word-|role/u);
    const secret=store.miniGameQuery(db=>(db.prepare("SELECT secret_word FROM word_imposter_rounds WHERE phase='hints'").get() as {secret_word:string}).secret_word);
    const token='public-word-widget-token-12345678901234567890',hash=createHash('sha256').update(token).digest('hex');store.rotateWidgetToken('imposter',hash,Date.now(),'admin');
    const widget=await(await fetch(`${base}/widgets/api/imposter?token=${token}`)).json() as any;assert.equal(widget.visible,true);assert.equal(widget.wordImposter.phase,'hints');assert.equal(JSON.stringify(widget).includes(secret),false);assert.doesNotMatch(JSON.stringify(widget),/chat-word-|viewer-word-id|secret_word|imposter_id|"role"/u);
    validatedUser='outside-word-id';const login2=await fetch(base+'/community/login/twitch',{redirect:'manual'}),auth2=new URL(login2.headers.get('location')||''),state2=auth2.searchParams.get('state')||'',stateCookie2=setCookies(login2).find(value=>value.startsWith('community_oauth_state='))?.split(';')[0]||'';
    const callback2=await fetch(`${base}/dashboard/oauth/callback?code=outsider&state=${state2}`,{headers:{cookie:stateCookie2},redirect:'manual'});const outsiderCookie=setCookies(callback2).find(value=>value.startsWith('community_viewer='))?.split(';')[0]||'';
    const outsider=await(await fetch(base+'/community/api/word-imposter/state',{headers:{cookie:outsiderCookie}})).json() as any;assert.equal(outsider.mine,null);assert.equal(outsider.viewer.isParticipant,false);
  }finally{await dashboard.stop();store.close();process.env=env;}
});
