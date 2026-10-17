import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { CommunityArcade } from './community-arcade.js';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

function linkDiscordAccount(store:FeatureStore,discordUserId:string,twitchUserId:string):void{
  const tokenHash='a'.repeat(64),stateHash='b'.repeat(64);
  store.createCommunityAccountLinkIntent({tokenHash,discordUserId,createdAt:1_000,expiresAt:601_000});
  assert.equal(store.beginCommunityAccountLinkOAuthState({stateHash,tokenHash,expiresAt:601_000,now:1_000}),true);
  assert.equal(store.completeCommunityAccountLink({stateHash,twitchUserId,now:2_000}),'linked');
}

test('Discord Elio actions and Mystery Drop claims use linked Twitch identities and remain idempotent',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort(),secret='synthetic-discord-integration-key-123456789';
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='test-admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET=secret;
  const arcade=new CommunityArcade(store,'broadcaster-1');
  arcade.updateSettings({...arcade.settings(),petEnabled:true,dropsEnabled:true,petCooldownMs:120_000,dropDurationMs:60_000});
  store.setConfig('discord_integration',{enabled:true,accountLinkEnabled:true,elioEnabled:true,discordDropsEnabled:true,ideasChannelId:'',rewardsChannelId:'',liveChannelId:'',dropChannelId:'1206225751544832041',notifyIdeas:false,notifyLevels:false,notifyDrops:false,notifyQuests:false,notifySeasonal:false,notifyLive:false});
  linkDiscordAccount(store,'1206225751544832053','twitch-viewer-1');
  const server=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetch,undefined,undefined,undefined,undefined,arcade);
  const base=`http://127.0.0.1:${port}/api/discord/v1`,headers={authorization:`Bearer ${secret}`,'content-type':'application/json'};
  try{
    assert.equal(await server.start(),true);
    const petBefore=arcade.snapshot('pet').pet as {hunger:number;happiness:number;xp:number};
    const petAction={eventId:'1206225751544832054',discordUserId:'1206225751544832053',displayName:'Viewer',action:'feed'};
    const petResponse=await fetch(`${base}/community/elio/action`,{method:'POST',headers,body:JSON.stringify(petAction)});
    assert.equal(petResponse.status,200,await petResponse.clone().text());
    const firstPet=await petResponse.json() as {changes:{hunger:number;happiness:number;xp:number}};
    assert.equal(firstPet.changes.hunger,8);assert.equal(firstPet.changes.xp,2);
    const duplicatePet=await fetch(`${base}/community/elio/action`,{method:'POST',headers,body:JSON.stringify(petAction)});
    assert.equal(duplicatePet.status,409,'Discord interaction replay cannot repeat the pet action');
    const petAfter=arcade.snapshot('pet').pet as {hunger:number;happiness:number;xp:number};
    assert.equal(petAfter.hunger,Math.min(100,petBefore.hunger+8));assert.equal(petAfter.xp,petBefore.xp+2);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_pet_interactions').get() as {n:number}).n),1);

    assert.match(arcade.startDropAdmin('test-moderator',undefined,Date.now()),/Mystery Drop startet/u);
    const active=await(await fetch(`${base}/community/drop`,{headers})).json() as {visible:boolean;drop:{id:string;participants:number}};
    assert.equal(active.visible,true);assert.ok(active.drop.id);
    const claim={discordUserId:'1206225751544832053',displayName:'Viewer',dropId:active.drop.id,eventId:'1206225751544832055'};
    const claimResponse=await fetch(`${base}/community/drop/claim`,{method:'POST',headers,body:JSON.stringify(claim)});assert.equal(claimResponse.status,200,await claimResponse.clone().text());assert.equal((await claimResponse.json() as {joined:boolean}).joined,true);
    const secondClaim=await fetch(`${base}/community/drop/claim`,{method:'POST',headers,body:JSON.stringify({...claim,eventId:'1206225751544832056'})});assert.equal(secondClaim.status,200);assert.equal((await secondClaim.json() as {joined:boolean}).joined,false,'second Discord interaction maps to the same Twitch claim key');
    assert.equal(arcade.snapshot('drop').drop && (arcade.snapshot('drop').drop as {participants:number}).participants,1);
    const xpBefore=store.xp('twitch-viewer-1').xp;
    store.miniGameTransaction(db=>db.prepare('UPDATE mystery_drops SET ends_at=? WHERE id=?').run(Date.now()-1,active.drop.id));
    arcade.tickMessages(Date.now());
    assert.equal(store.xp('twitch-viewer-1').xp,xpBefore+5,'one shared participant receives one configured common-drop award');
    arcade.tickMessages(Date.now()+1);
    assert.equal(store.xp('twitch-viewer-1').xp,xpBefore+5,'drop replay does not pay twice');
  }finally{
    await server.stop();store.close();
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];
    for(const [key,value] of Object.entries(env))process.env[key]=value;
  }
});

test('Discord community actions fail closed when disabled, unlinked, or unauthenticated',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort(),secret='synthetic-discord-integration-key-123456789';
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='test-admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET=secret;
  const arcade=new CommunityArcade(store,'broadcaster-1');arcade.updateSettings({...arcade.settings(),petEnabled:true,dropsEnabled:true});
  store.setConfig('discord_integration',{enabled:false,accountLinkEnabled:true,elioEnabled:true,discordDropsEnabled:true,dropChannelId:'1206225751544832041'});
  const server=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetch,undefined,undefined,undefined,undefined,arcade);
  const base=`http://127.0.0.1:${port}/api/discord/v1`,headers={authorization:`Bearer ${secret}`,'content-type':'application/json'};
  try{
    assert.equal(await server.start(),true);
    assert.equal((await fetch(`${base}/community/elio`)).status,401);
    const action={eventId:'1206225751544832054',discordUserId:'1206225751544832053',displayName:'Viewer',action:'care'};
    assert.equal((await fetch(`${base}/community/elio/action`,{method:'POST',headers,body:JSON.stringify(action)})).status,409);
    store.setConfig('discord_integration',{...store.config('discord_integration',{}),enabled:true});
    assert.equal((await fetch(`${base}/community/elio/action`,{method:'POST',headers,body:JSON.stringify(action)})).status,403,'unlinked Discord account cannot act as a Twitch viewer');
    assert.equal((await fetch(`${base}/community/drop`,{headers})).status,200,'enabled drop status remains readable even when there is no active drop');
  }finally{
    await server.stop();store.close();
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];
    for(const [key,value] of Object.entries(env))process.env[key]=value;
  }
});
