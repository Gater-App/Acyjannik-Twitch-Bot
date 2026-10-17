import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { DashboardServer } from './dashboard.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

test('Discord ideas use Twitch source of truth, idempotent inbox and acknowledged outbox',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort();
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='test-admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET='synthetic-integration-secret-123456789';
  store.setConfig('discord_integration',{enabled:true,accountLinkEnabled:true,ideasChannelId:'1206225751544832041',rewardsChannelId:'',liveChannelId:'',notifyIdeas:true,notifyLevels:false,notifyDrops:false,notifyQuests:false,notifySeasonal:false,notifyLive:false});
  const server=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetch);
  const base=`http://127.0.0.1:${port}/api/discord/v1`,auth={authorization:'Bearer synthetic-integration-secret-123456789','content-type':'application/json'};
  try{
    assert.equal(await server.start(),true);
    assert.equal((await fetch(`${base}/config`)).status,401,'interne Endpunkte verlangen das Integrationsgeheimnis');
    const submission={eventId:'1206225751544832041',discordUserId:'1206225751544832051',displayName:'Viewer',text:'Horrorabend: Lasst uns gemeinsam ein Gruselspiel spielen',category:'Community'};
    const first=await fetch(`${base}/ideas`,{method:'POST',headers:auth,body:JSON.stringify(submission)});assert.equal(first.status,201);const accepted=await first.json() as {idea:{id:string}};
    const replay=await fetch(`${base}/ideas`,{method:'POST',headers:auth,body:JSON.stringify(submission)});assert.equal(replay.status,201);assert.equal((await replay.json() as {duplicateEvent?:boolean}).duplicateEvent,true);
    assert.equal(store.communityIdeas({status:'pending'}).length,1,'Wiederholung derselben Discord-Interaction erzeugt keine zweite Idee');
    assert.equal(store.moderateCommunityIdea(accepted.idea.id,'approve','twitch-moderator',Date.now()),true);
    const vote={eventId:'1206225751544832042',ideaId:accepted.idea.id,discordUserId:'1206225751544832052'};
    assert.equal((await fetch(`${base}/ideas/vote`,{method:'POST',headers:auth,body:JSON.stringify(vote)})).status,200);
    assert.equal((await fetch(`${base}/ideas/vote`,{method:'POST',headers:auth,body:JSON.stringify(vote)})).status,200,'wiederholte Interaction erhält idempotente Antwort');
    assert.equal(store.communityIdea(accepted.idea.id)?.votes,1);
    const linkIntent=await fetch(`${base}/account-links/intents`,{method:'POST',headers:auth,body:JSON.stringify({discordUserId:'1206225751544832053'})});assert.equal(linkIntent.status,201);
    const intentBody=await linkIntent.json() as {authorizationUrl:string;expiresAt:number};assert.match(intentBody.authorizationUrl,/\/community\/link\/twitch#token=/u);
    assert.equal((await fetch(`${base}/account-links/status`,{method:'POST',headers:auth,body:JSON.stringify({discordUserId:'1206225751544832053'})})).status,200);
    assert.equal((await fetch(`${base}/account-links/intents`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discordUserId:'1206225751544832053'})})).status,401);
    const polled=await fetch(`${base}/outbox/poll`,{method:'POST',headers:auth,body:'{}'});assert.equal(polled.status,200);
    const events=(await polled.json() as {events:Array<{id:string;type:string}>}).events;assert.deepEqual(events.map(event=>event.type),['idea.submitted','idea.status','idea.vote']);
    const ack=await fetch(`${base}/outbox/ack`,{method:'POST',headers:auth,body:JSON.stringify({id:events[0]!.id,success:true})});assert.equal(ack.status,200);
    assert.equal(store.discordOutboxStats().delivered,1);
    const unauthVote=await fetch(`${base}/ideas/vote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(vote)});assert.equal(unauthVote.status,401);
  }finally{
    await server.stop();store.close();
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];
    for(const [key,value] of Object.entries(env))process.env[key]=value;
  }
});

test('account links are unique, transactional, reversible, and never merge Twitch data',()=>{
  const store=new FeatureStore(':memory:');
  try{
    const tokenHash='a'.repeat(64),stateHash='b'.repeat(64);
    store.createCommunityAccountLinkIntent({tokenHash,discordUserId:'1206225751544832053',createdAt:1000,expiresAt:601000});
    assert.equal(store.beginCommunityAccountLinkOAuthState({stateHash,tokenHash,expiresAt:601000,now:1000}),true);
    assert.equal(store.beginCommunityAccountLinkOAuthState({stateHash:'c'.repeat(64),tokenHash,expiresAt:601000,now:1100}),false,'link intent is consumed when OAuth begins');
    assert.equal(store.completeCommunityAccountLink({stateHash,twitchUserId:'twitch-1',now:2000}),'linked');
    assert.deepEqual(store.communityAccountLinkStatus('1206225751544832053'),{linked:true,linkedAt:2000});
    assert.equal(store.completeCommunityAccountLink({stateHash,twitchUserId:'twitch-1',now:3000}),'expired','OAuth state cannot be replayed');
    assert.equal(store.disconnectCommunityAccountLink({discordUserId:'1206225751544832053',now:4000}),true);
    assert.equal(store.disconnectCommunityAccountLink({discordUserId:'1206225751544832053',now:5000}),false);
    assert.deepEqual(store.communityAccountLinkStatus('1206225751544832053'),{linked:false});
    assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM community_account_link_audit WHERE action='unlinked'").get() as {n:number}).n,1);
  }finally{store.close();}
});

test('Discord outbox retries with bounded backoff and moves exhausted deliveries to dead letter',()=>{
  const store=new FeatureStore(':memory:');
  try{
    store.setConfig('discord_integration',{enabled:true,notifyIdeas:true});
    store.submitCommunityIdea({id:'idea-outbox',userId:'twitch-user',displayName:'Viewer',text:'Ein Community-Horrorabend wäre toll',now:1000});
    let now=1000;
    for(let attempt=0;attempt<8;attempt++){
      const event=store.discordOutboxBatch(now,1)[0];assert.ok(event);assert.equal(store.settleDiscordOutbox(event.id,false,now,'synthetic error'),true);
      now+=24*60*60_000;
    }
    assert.equal(store.discordOutboxStats().dead,1);
  }finally{store.close();}
});

test('live-state outbox creates one announcement, coalesces stable polls, and updates only changed stream metadata',()=>{
  const store=new FeatureStore(':memory:');
  try{
    store.setConfig('discord_integration',{enabled:true,ideasChannelId:'1206225751544832041',rewardsChannelId:'1206225751544832042',liveChannelId:'1206225751544832043',notifyIdeas:false,notifyLevels:false,notifyDrops:false,notifyQuests:false,notifySeasonal:false,notifyLive:true});
    store.recordDiscordLiveTransition(false,undefined,1000);
    store.recordDiscordLiveTransition(false,undefined,2000);
    assert.equal(store.discordOutboxStats().pending,0,'erster Status und wiederholte Offline-Abfragen senden nichts');
    store.recordDiscordLiveTransition(true,{id:'stream-1',title:'Teststream',game_name:'Spiel A'},3000);
    store.recordDiscordLiveTransition(true,{id:'stream-1',title:'Teststream',game_name:'Spiel A'},4000);
    assert.equal(store.discordOutboxStats().pending,1,'wiederholte Online-Abfragen erzeugen keine Dopplung');
    store.recordDiscordLiveTransition(true,{id:'stream-1',title:'Neuer Titel',game_name:'Spiel A'},5000);
    store.recordDiscordLiveTransition(true,{id:'stream-1',title:'Neuer Titel',game_name:'Spiel B'},6000);
    store.recordDiscordLiveTransition(true,{id:'stream-1',title:'Neuer Titel',game_name:'Spiel B'},7000);
    store.recordDiscordLiveTransition(false,undefined,8000);
    store.recordDiscordLiveTransition(false,undefined,9000);
    const events=store.discordOutboxBatch(9000,5);assert.deepEqual(events.map(event=>event.type),['twitch.live','twitch.live.update','twitch.live.update','twitch.live']);
    assert.deepEqual(events.map(event=>(event.payload as {active:boolean}).active),[true,true,true,false]);
    assert.equal((events[1]!.payload as {title:string}).title,'Neuer Titel');
    assert.equal((events[2]!.payload as {gameName:string}).gameName,'Spiel B');
  }finally{store.close();}
});

test('enabling live notifications during an ongoing stream emits one current announcement',()=>{
  const store=new FeatureStore(':memory:');
  try{
    store.setConfig('discord_integration',{enabled:true,notifyLive:false});
    store.recordDiscordLiveTransition(false,undefined,1000);
    store.recordDiscordLiveTransition(true,{id:'stream-existing',title:'Schon live',game_name:'Spiel'},2000);
    assert.equal(store.discordOutboxStats().pending,0,'deaktivierte Hinweise erzeugen keine Zustellung');
    store.setConfig('discord_integration',{enabled:true,notifyLive:true});
    store.recordDiscordLiveTransition(true,{id:'stream-existing',title:'Schon live',game_name:'Spiel'},3000);
    store.recordDiscordLiveTransition(true,{id:'stream-existing',title:'Schon live',game_name:'Spiel'},4000);
    const events=store.discordOutboxBatch(4000,5);
    assert.equal(events.length,1,'Aktivierung während des Streams erzeugt eine einzelne aktuelle Ankündigung');
    assert.equal(events[0]?.type,'twitch.live');
  }finally{store.close();}
});
