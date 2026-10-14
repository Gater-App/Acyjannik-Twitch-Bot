import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { SpotifySongRequests } from './song-requests.js';
import { SONG_REQUESTS_CARD } from './song-requests-ui.js';
import type { TwitchApi } from './twitch-api.js';
import type { TwitchOAuth } from './twitch-oauth.js';
import type { Logger } from './logger.js';

const logger={info(){},warn(){},error(){},debug(){}} as unknown as Logger;
function event(id='redeem-1'){return {metadata:{message_type:'notification'},payload:{subscription:{type:'channel.channel_points_custom_reward_redemption.add',condition:{broadcaster_user_id:'channel-1',reward_id:'reward-song'}},event:{id,broadcaster_user_id:'channel-1',user_id:'viewer-1',user_name:'Viewer',user_input:'Daft Punk - One More Time',status:'unfulfilled',redeemed_at:new Date().toISOString(),reward:{id:'reward-song'}}}} as unknown as Record<string,unknown>;}

test('Song Requests bleiben standardmäßig aus; OAuth-Callback und Playlist-Einlösung sind persistent/idempotent',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'song-requests-')),dbPath=path.join(dir,'db.sqlite'),tokenPath=path.join(dir,'spotify.json');
  const previous={id:process.env.SPOTIFY_CLIENT_ID,secret:process.env.SPOTIFY_CLIENT_SECRET,redirect:process.env.SPOTIFY_REDIRECT_URI};
  process.env.SPOTIFY_CLIENT_ID='client';process.env.SPOTIFY_CLIENT_SECRET='secret';process.env.SPOTIFY_REDIRECT_URI='https://twitch.gater-app.de/dashboard/spotify/callback';
  const store=new FeatureStore(dbPath);assert.deepEqual(store.config('song_request_settings',{}),{enabled:false,rewardId:null,rewardTitle:'🎵 Song wünschen',cost:1000,playlistId:null,playlistName:null});
  const calls:string[]=[];const twitch={ensureChannelPointsSubscription:async()=>{},getUnfulfilledRedemptions:async()=>[],getRedemption:async()=>undefined,
    setRedemptionStatus:async(_b:string,_r:string,id:string,status:string)=>{calls.push(`twitch:${id}:${status}`);return {}},getCustomRewards:async()=>[],createCustomReward:async()=>({})} as unknown as TwitchApi;
  const twitchOAuth={hasAccessToken:true,grantedScopes:['channel:manage:redemptions']} as unknown as TwitchOAuth;
  const fetchMock=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{const url=String(input);calls.push(`${init?.method||'GET'}:${url}`);
    if(url==='https://accounts.spotify.com/api/token')return Response.json({access_token:'access',refresh_token:'refresh',expires_in:3600,scope:'playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public'});
    if(url==='https://api.spotify.com/v1/search?'+new URLSearchParams({q:'Daft Punk - One More Time',type:'track',limit:'1'}).toString())return Response.json({tracks:{items:[{uri:'spotify:track:0123456789012345678901',name:'One More Time',artists:[{name:'Daft Punk'}]}]}});
    if(url==='https://api.spotify.com/v1/playlists/playlist-1/items')return Response.json({snapshot_id:'snapshot'});
    throw new Error(`Unexpected URL ${url}`);
  };
  try{
    let service=new SpotifySongRequests(store,twitch,twitchOAuth,'channel-1',logger,fetchMock,tokenPath);
    assert.equal(service.broadcasterConnected(),true,'Broadcasterstatus hängt an vorhandenem Token und erforderlichem Kanalpunkte-Scope');
    const auth=new URL(service.authorizationUrl()),state=auth.searchParams.get('state')!;await service.handleCallback(new URL(`https://twitch.gater-app.de/dashboard/spotify/callback?code=auth-code&state=${state}`));
    assert.equal(fs.statSync(tokenPath).mode&0o777,0o600);assert.equal(service.connected(),true);
    await assert.rejects(()=>service.saveSettings({enabled:true,rewardId:'reward-song',playlistId:'playlist-1',cost:500}),/1.000/u);
    store.setConfig('song_request_settings',{enabled:true,rewardId:'reward-song',rewardTitle:'🎵 Song wünschen',cost:500,playlistId:'playlist-1',playlistName:'Streamsongs'});
    await service.acceptEventSub(event());await service.acceptEventSub(event());
    assert.equal(calls.filter(x=>x==='POST:https://api.spotify.com/v1/playlists/playlist-1/items').length,1);
    assert.ok(calls.includes('twitch:redeem-1:FULFILLED'));assert.equal(service.list()[0]?.status,'added');
    service=new SpotifySongRequests(store,twitch,twitchOAuth,'channel-1',logger,fetchMock,tokenPath);await service.initialize();assert.equal(service.connected(),true);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});
    if(previous.id===undefined)delete process.env.SPOTIFY_CLIENT_ID;else process.env.SPOTIFY_CLIENT_ID=previous.id;
    if(previous.secret===undefined)delete process.env.SPOTIFY_CLIENT_SECRET;else process.env.SPOTIFY_CLIENT_SECRET=previous.secret;
    if(previous.redirect===undefined)delete process.env.SPOTIFY_REDIRECT_URI;else process.env.SPOTIFY_REDIRECT_URI=previous.redirect;}
});

test('Neustart markiert uneindeutige Playlist-Schreibvorgänge zur Prüfung und wiederholt sie nicht',async()=>{
  const store=new FeatureStore(':memory:'),twitch={} as TwitchApi,oauth={} as TwitchOAuth;
  store.miniGameTransaction(db=>db.prepare("INSERT INTO song_requests(redemption_id,reward_id,user_id,display_name,user_input,status,created_at,updated_at) VALUES('uncertain','r','u','Viewer','song','processing',1,1)").run());
  const service=new SpotifySongRequests(store,twitch,oauth,'channel-1',logger,fetch,'/tmp/unused-song-tokens.json');await service.initialize();
  assert.equal(service.list()[0]?.status,'needs_review');assert.match(service.list()[0]?.lastError||'',/nicht automatisch erneut/u);store.close();
});

test('Preisstandard wird sicher auf 1.000 migriert, eigener Preis bleibt erhalten und UI bietet keine Wiedergabesteuerung',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'song-price-migration-'));
  for(const [label,cost,expected] of [['default',500,1000],['custom',1200,1200]] as const){const file=path.join(dir,`${label}.sqlite`);let store=new FeatureStore(file);
    store.setConfig('song_request_settings',{enabled:false,rewardId:null,rewardTitle:'🎵 Song wünschen',cost,playlistId:null,playlistName:null});store.miniGameTransaction(db=>db.prepare('DELETE FROM schema_migrations WHERE version IN (19,20,21,22)').run());store.close();
    store=new FeatureStore(file);assert.equal(store.config<{cost:number}>('song_request_settings',{cost:0}).cost,expected);store.close();}
  assert.match(SONG_REQUESTS_CARD,/1\.000 Kanalpunkte/u);assert.doesNotMatch(SONG_REQUESTS_CARD,/skip|Wiedergabe starten/u);fs.rmSync(dir,{recursive:true,force:true});
});

test('Spotify-State ist nur einmal gültig und Fehlversuche verändern die Freigabe nicht',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'song-state-')),store=new FeatureStore(':memory:'),old=process.env.SPOTIFY_REDIRECT_URI,oldId=process.env.SPOTIFY_CLIENT_ID,oldSecret=process.env.SPOTIFY_CLIENT_SECRET;process.env.SPOTIFY_REDIRECT_URI='http://127.0.0.1/dashboard/spotify/callback';process.env.SPOTIFY_CLIENT_ID='client';process.env.SPOTIFY_CLIENT_SECRET='secret';
  try{const service=new SpotifySongRequests(store,{} as TwitchApi,{} as TwitchOAuth,'channel-1',logger,fetch, path.join(dir,'tokens.json'));
    const state=new URL(service.authorizationUrl()).searchParams.get('state')!;
    await assert.rejects(()=>service.handleCallback(new URL(`http://127.0.0.1/dashboard/spotify/callback?code=x&state=wrong`)),/ungültig/u);
    await assert.rejects(()=>service.handleCallback(new URL(`http://127.0.0.1/dashboard/spotify/callback?code=x&state=${state}`)),/ungültig/u);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});if(old===undefined)delete process.env.SPOTIFY_REDIRECT_URI;else process.env.SPOTIFY_REDIRECT_URI=old;if(oldId===undefined)delete process.env.SPOTIFY_CLIENT_ID;else process.env.SPOTIFY_CLIENT_ID=oldId;if(oldSecret===undefined)delete process.env.SPOTIFY_CLIENT_SECRET;else process.env.SPOTIFY_CLIENT_SECRET=oldSecret;}
});
