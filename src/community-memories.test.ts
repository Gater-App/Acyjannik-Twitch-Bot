import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';
import { CommunityFeatures } from './community-features.js';
import { ViewerCommunityPortal, renderCommunityPage } from './community-portal.js';
import { memoriesModerationPage, validTwitchClipUrl } from './community-memories.js';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';
import { testConfig } from './test-config.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
function setCookies(response:Response):string[]{const headers=response.headers as Headers&{getSetCookie?:()=>string[]};return headers.getSetCookie?.()||[response.headers.get('set-cookie')||''];}

test('Migration 29 legt die Erinnerungswand aus einer v28-Datenbank an und erstellt ein Backup',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'community-memories-migration-')),database=path.join(directory,'data','state.sqlite');fs.mkdirSync(path.dirname(database));let store=new FeatureStore(database);
  try{
    store.miniGameTransaction(db=>{db.exec('DROP TABLE community_memory_reactions;DROP TABLE community_memories;DELETE FROM schema_migrations WHERE version>=29')});
  }finally{store.close()}
  store=new FeatureStore(database);
  try{
    const schema=store.miniGameQuery(db=>({memories:db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='community_memories'").get() as {n:number},reactions:db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='community_memory_reactions'").get() as {n:number},migration:db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=29').get() as {n:number}}));
    assert.deepEqual([schema.memories.n,schema.reactions.n,schema.migration.n],[1,1,1]);
    assert.ok(fs.readdirSync(path.join(directory,'backups')).some(name=>name.includes('migration-v29-')),'v29-Migration erstellt ein Vorab-Backup');
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('Community-Erinnerungen begrenzen Twitch-Clips auf sichere öffentliche Twitch-URLs',()=>{
  assert.equal(validTwitchClipUrl('https://clips.twitch.tv/FriendlyClipSlug123'),'https://clips.twitch.tv/FriendlyClipSlug123');
  assert.equal(validTwitchClipUrl('https://www.twitch.tv/streamer/clip/FriendlyClipSlug123'),'https://www.twitch.tv/streamer/clip/FriendlyClipSlug123');
  assert.equal(validTwitchClipUrl('http://clips.twitch.tv/FriendlyClipSlug123'),null);
  assert.equal(validTwitchClipUrl('https://clips.twitch.tv.evil.example/FriendlyClipSlug123'),null);
  assert.equal(validTwitchClipUrl('https://clips.twitch.tv/FriendlyClipSlug123?redirect=https://evil.example'),null);
  const portal=renderCommunityPage('/community/momente','nonce-test');assert.match(portal,/data-page="memories"/u);assert.match(portal,/memory-filters/u);assert.match(portal,/privaten Chatnachrichten/u);
  const review=memoriesModerationPage('csrf-test','nonce-test');for(const [,script] of review.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/gu))new vm.Script(script||'');
});

test('Erinnerungen bleiben bis zur Freigabe privat, werden filterbar, einmalig reagiert und löschbar',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'community-memories-')),store=new FeatureStore(path.join(directory,'state.sqlite')),port=await freePort();
  process.env.TWITCH_CLIENT_ID='memory-client';process.env.TWITCH_CLIENT_SECRET='memory-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';
  process.env.DASHBOARD_ADMIN_IDS='admin-memory-id';process.env.AUTHORIZED_MODERATOR_IDS='mod-memory-id';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  let userId='viewer-memory-id';
  const fetchImpl:typeof fetch=async input=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'temporary-token'});if(url.endsWith('/oauth2/validate'))return Response.json({client_id:'memory-client',user_id:userId});if(url.endsWith('/helix/users'))return Response.json({data:[{id:userId,login:'memory_viewer',display_name:'Memory Viewer'}]});throw new Error(`Unexpected external request: ${url}`);};
  const cfg=testConfig({clientId:'memory-client',clientSecret:'memory-secret',redirectUri:'https://bot.example.test/dashboard/oauth/callback'}),features=new CommunityFeatures(store,cfg),portal=new ViewerCommunityPortal(store,features,cfg,fetchImpl),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  const base=`http://127.0.0.1:${port}`;
  const viewerLogin=async()=>{userId='viewer-memory-id';const start=await fetch(base+'/community/login/twitch',{redirect:'manual'}),state=new URL(start.headers.get('location')||'').searchParams.get('state')||'',stateCookie=setCookies(start).find(c=>c.startsWith('community_oauth_state='))?.split(';')[0]||'',callback=await fetch(`${base}/dashboard/oauth/callback?code=viewer&state=${state}`,{headers:{cookie:stateCookie},redirect:'manual'});return setCookies(callback).find(c=>c.startsWith('community_viewer='))?.split(';')[0]||'';};
  const moderatorLogin=async()=>{userId='mod-memory-id';const start=await fetch(base+'/dashboard/login',{redirect:'manual'}),state=new URL(start.headers.get('location')||'').searchParams.get('state')||'',stateCookie=setCookies(start).find(c=>c.startsWith('community_admin_oauth_state='))?.split(';')[0]||setCookies(start).find(c=>c.includes('state='))?.split(';')[0]||'',callback=await fetch(`${base}/dashboard/oauth/callback?code=moderator&state=${state}`,{headers:{cookie:stateCookie},redirect:'manual'});return setCookies(callback).find(c=>c.startsWith('community_admin='))?.split(';')[0]||'';};
  try{
    await dashboard.start();
    const anonymous=await fetch(base+'/community/api/memories');assert.equal(anonymous.status,200);assert.deepEqual((await anonymous.json() as any).items,[]);
    const anonymousWrite=await fetch(base+'/community/api/memories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Ein schöner Stream-Moment',category:'community'})});assert.equal(anonymousWrite.status,401);
    const viewerCookie=await viewerLogin(),viewerState=await(await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any,csrf=viewerState.viewer.csrfToken;
    const post=(url:string,body:unknown)=>fetch(base+url,{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
    const unsafeClip=await post('/community/api/memories',{text:'Ein schöner Stream-Moment',category:'community',clipUrl:'https://clips.twitch.tv.evil.example/BadSlug123'});assert.equal(unsafeClip.status,400);
    const submission=await post('/community/api/memories',{text:'Die Community hat den Endboss gemeinsam besiegt!',category:'gaming',event:'Sommer-Stream',clipUrl:'https://clips.twitch.tv/FriendlyClipSlug123'});assert.equal(submission.status,201,await submission.clone().text());
    let publicList=await(await fetch(base+'/community/api/memories?category=gaming',{headers:{cookie:viewerCookie}})).json() as any;assert.equal(publicList.items.length,0,'pending content is never public');
    const pendingState=await(await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}})).json() as any;assert.equal(pendingState.personal.memorySubmissions[0].status,'pending');

    const modCookie=await moderatorLogin();assert.ok(modCookie,'authorized moderator receives a scoped dashboard session');
    const reviewPage=await fetch(base+'/dashboard/memories',{headers:{cookie:modCookie}});assert.equal(reviewPage.status,200);const reviewHtml=await reviewPage.text();assert.match(reviewHtml,/Community-Erinnerungen/u);
    const read=(url:string)=>fetch(base+url,{headers:{cookie:modCookie}});
    const moderationRead=await read('/dashboard/api/memories');assert.equal(moderationRead.status,200);const queue=await moderationRead.json() as any;assert.equal(queue.pending.length,1);assert.equal(queue.pending[0].submitterName,'Memory Viewer');
    const adminOnly=await read('/dashboard/api/overview');assert.equal(adminOnly.status,403,'moderator can review memories but cannot read admin overview');
    const modCsrf=reviewHtml.match(/meta name="csrf" content="([^"]+)/u)?.[1]||'';
    const moderate=(action:string)=>fetch(base+'/dashboard/api/memories',{method:'POST',headers:{cookie:modCookie,'Content-Type':'application/json','X-CSRF-Token':modCsrf,Origin:'https://bot.example.test'},body:JSON.stringify({id:queue.pending[0].id,action})});
    const approved=await moderate('publish');assert.equal(approved.status,200,await approved.clone().text());
    publicList=await(await fetch(base+'/community/api/memories?category=gaming&event=Sommer-Stream',{headers:{cookie:viewerCookie}})).json() as any;
    assert.equal(publicList.items.length,1);assert.equal(publicList.items[0].body,'Die Community hat den Endboss gemeinsam besiegt!');assert.equal(publicList.items[0].clipUrl,'https://clips.twitch.tv/FriendlyClipSlug123');assert.equal(publicList.items[0].submitterName,undefined);assert.equal(JSON.stringify(publicList).includes('viewer-memory-id'),false);
    const reaction=await post('/community/api/memories/react',{id:publicList.items[0].id});assert.equal(reaction.status,200);
    const duplicate=await post('/community/api/memories/react',{id:publicList.items[0].id});assert.equal(duplicate.status,409);
    const feature=await moderate('feature');assert.equal(feature.status,200);
    const recap=await(await fetch(base+'/community/api/memories?featured=true')).json() as any;assert.equal(recap.items.length,1);assert.equal(recap.items[0].reactions,1);
    const deleteOwn=await post('/community/api/memories/delete',{id:publicList.items[0].id});assert.equal(deleteOwn.status,200);const afterDelete=await(await fetch(base+'/community/api/memories')).json() as any;assert.equal(afterDelete.items.length,0);
    const filtered=await fetch(base+'/community/api/memories?category=not-real');assert.equal(filtered.status,400);
  }finally{await dashboard.stop();portal.stop();store.close();process.env=env;fs.rmSync(directory,{recursive:true,force:true});}
});

