import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { CommunityFeatures } from './community-features.js';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';
import { testConfig } from './test-config.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
function linkDiscordAccount(store:FeatureStore):void{
  const tokenHash='c'.repeat(64),stateHash='d'.repeat(64);
  store.createCommunityAccountLinkIntent({tokenHash,discordUserId:'1206225751544832053',createdAt:1_000,expiresAt:601_000});
  assert.equal(store.beginCommunityAccountLinkOAuthState({stateHash,tokenHash,expiresAt:601_000,now:1_000}),true);
  assert.equal(store.completeCommunityAccountLink({stateHash,twitchUserId:'twitch-games-viewer',now:2_000}),'linked');
}

test('Discord 8-Ball and RPS use Twitch game rules, cooldowns, account links, and one XP ledger',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort(),secret='synthetic-discord-integration-key-123456789';
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='test-admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET=secret;
  const features=new CommunityFeatures(store,testConfig(),undefined,(min)=>min);
  store.setConfig('discord_integration',{enabled:true,accountLinkEnabled:true,discordEightBallEnabled:true,discordRpsEnabled:true,elioEnabled:false,discordDropsEnabled:false,ideasChannelId:'',rewardsChannelId:'',liveChannelId:'',dropChannelId:'',notifyIdeas:false,notifyLevels:false,notifyDrops:false,notifyQuests:false,notifySeasonal:false,notifyLive:false});
  store.setConfig('xp_settings',{dailyGameCap:100,rpsWinXp:10});linkDiscordAccount(store);
  const server=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetch);
  server.setDiscordGameHandler((message,game,args,now)=>features.discordGameReply(message,game,args,now));
  const base=`http://127.0.0.1:${port}/api/discord/v1`,headers={authorization:`Bearer ${secret}`,'content-type':'application/json'};
  try{
    assert.equal(await server.start(),true);
    const ball={eventId:'1206225751544832054',discordUserId:'1206225751544832053',displayName:'Viewer',game:'8ball',question:'Wird die Community-Runde schön?'};
    const ballFirst=await fetch(`${base}/community/games/play`,{method:'POST',headers,body:JSON.stringify(ball)});assert.equal(ballFirst.status,200);const firstAnswer=await ballFirst.json() as {message:string;duplicateEvent:boolean};assert.ok(firstAnswer.message);assert.equal(firstAnswer.duplicateEvent,false);
    const ballReplay=await fetch(`${base}/community/games/play`,{method:'POST',headers,body:JSON.stringify(ball)});assert.deepEqual(await ballReplay.json(),{ok:true,message:firstAnswer.message,duplicateEvent:true},'interaction replay returns the original answer and does not consume cooldown again');
    const rps={eventId:'1206225751544832055',discordUserId:'1206225751544832053',displayName:'Viewer',game:'rps',choice:'stein'};
    const rpsFirst=await fetch(`${base}/community/games/play`,{method:'POST',headers,body:JSON.stringify(rps)});assert.equal(rpsFirst.status,200);assert.match((await rpsFirst.json() as {message:string}).message,/Du gewinnst gegen schere/u);
    assert.equal(store.xp('twitch-games-viewer').xp,10,'RPS reward is posted to the existing Twitch XP ledger once');
    const rpsReplay=await fetch(`${base}/community/games/play`,{method:'POST',headers,body:JSON.stringify(rps)});assert.deepEqual(await rpsReplay.json(),{ok:true,message:'✂️ Du gewinnst gegen schere! +10 XP.',duplicateEvent:true});
    assert.equal(store.xp('twitch-games-viewer').xp,10,'same interaction never gives XP twice');
    const nextRps={...rps,eventId:'1206225751544832056'};const cooled=await fetch(`${base}/community/games/play`,{method:'POST',headers,body:JSON.stringify(nextRps)});assert.equal(cooled.status,200);assert.match((await cooled.json() as {message:string}).message,/Einen Moment/u);assert.equal(store.xp('twitch-games-viewer').xp,10);
    const invalid=await fetch(`${base}/community/games/play`,{method:'POST',headers,body:JSON.stringify({...ball,eventId:'1206225751544832057',question:'?'})});assert.equal(invalid.status,400);
    const invalidType=await fetch(`${base}/community/games/play`,{method:'POST',headers,body:JSON.stringify({...ball,eventId:'1206225751544832058',question:{text:'not a string'}})});assert.equal(invalidType.status,400);
  }finally{
    await server.stop();store.close();
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];
    for(const [key,value] of Object.entries(env))process.env[key]=value;
  }
});

test('Discord minigames fail closed for disabled feature flags, unlinked identities, and missing API secrets',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort(),secret='synthetic-discord-integration-key-123456789';
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='test-admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET=secret;
  const features=new CommunityFeatures(store,testConfig());store.setConfig('discord_integration',{enabled:true,accountLinkEnabled:false,discordEightBallEnabled:false,discordRpsEnabled:false});
  const server=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetch);server.setDiscordGameHandler((message,game,args,now)=>features.discordGameReply(message,game,args,now));
  const base=`http://127.0.0.1:${port}/api/discord/v1`,payload={eventId:'1206225751544832054',discordUserId:'1206225751544832053',displayName:'Viewer',game:'rps',choice:'stein'};
  try{
    assert.equal(await server.start(),true);
    assert.equal((await fetch(`${base}/community/games/play`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).status,401);
    assert.equal((await fetch(`${base}/community/games/play`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(payload)})).status,409);
  }finally{
    await server.stop();store.close();
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];
    for(const [key,value] of Object.entries(env))process.env[key]=value;
  }
});
