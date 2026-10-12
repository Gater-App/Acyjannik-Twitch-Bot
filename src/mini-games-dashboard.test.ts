import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import test from 'node:test';
import {createHash} from 'node:crypto';
import {DashboardServer} from './dashboard.js';import {FeatureStore} from './feature-store.js';import {MiniGames} from './mini-games.js';import {logger} from './logger.js';import {testConfig} from './test-config.js';import type {ChatMessage} from './types.js';
async function freePort(){const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
test('Twitch-Teilnehmer-OAuth bindet die geheime Rolle an die verifizierte eigene ID; OBS bekommt keine Geheimnisse',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),config=testConfig(),games=new MiniGames(store,config,()=>0),port=await freePort();
  process.env.TWITCH_CLIENT_ID='test-client';process.env.TWITCH_CLIENT_SECRET='test-secret';process.env.DASHBOARD_REDIRECT_URI='https://bot.example.test/dashboard/oauth/callback';process.env.DASHBOARD_ADMIN_IDS='admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  games.updateSettings({...games.settings(),enabled:true});games.startImposter('admin',100);for(let i=1;i<=4;i++)games.join({eventId:`e${i}`,broadcasterUserId:'broadcaster-1',senderUserId:`p${i}`,senderLogin:`p${i}`,senderDisplayName:`Player${i}`,message:'',sentAt:1},101+i);games.startRoles('admin',110);
  let currentUser='p2';const fetchMock:typeof fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'temporary'});if(url.endsWith('/oauth2/validate'))return Response.json({client_id:'test-client',user_id:currentUser,login:currentUser});if(url.endsWith('/helix/users'))return Response.json({data:[{id:currentUser,login:currentUser,display_name:'Player'}]});throw Error('Unexpected external request '+url)};
  const server=new DashboardServer(store,()=>({twitchConnected:false,channel:'acijannik',startedAt:1}),logger,fetchMock,undefined,undefined,undefined,games);
  try{await server.start();const base=`http://127.0.0.1:${port}`;
    const noSession=await fetch(base+'/games/imposter/role',{redirect:'manual'});assert.equal(noSession.status,303);assert.doesNotMatch(await noSession.text(),/Regel|IMPOSTER/u);
    const login=await fetch(base+'/games/imposter/login',{redirect:'manual'}),authorize=new URL(login.headers.get('location')||'');assert.equal(authorize.searchParams.get('scope'),'');assert.equal(authorize.searchParams.get('redirect_uri'),'https://bot.example.test/games/imposter/callback');
    const state=authorize.searchParams.get('state')||'',stateCookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const callback=await fetch(`${base}/games/imposter/callback?code=code&state=${state}`,{headers:{Cookie:stateCookie},redirect:'manual'});assert.equal(callback.status,303);
    const session=callback.headers.getSetCookie().find(c=>c.startsWith('imposter_participant='))!.split(';')[0]!;
    const role=await fetch(base+'/games/imposter/role',{headers:{Cookie:session}});assert.equal(role.status,200);assert.match(role.headers.get('cache-control')||'',/no-store/u);assert.match(await role.text(),/GROSSBUCHSTABEN/u);
    const widgetType='imposter' as const,token='this-is-a-sufficiently-long-widget-token-123456';store.rotateWidgetToken(widgetType,createHash('sha256').update(token).digest('hex'),120,'admin');
    const widget=await fetch(`${base}/widgets/api/imposter?token=${token}`);const data=await widget.json() as {game:Record<string,unknown>};assert.equal(widget.status,200);assert.equal(JSON.stringify(data).includes('GROSSBUCHSTABEN'),false);assert.equal(JSON.stringify(data).includes('imposterId'),false);
    currentUser='outsider';const another=await fetch(`${base}/games/imposter/login`,{redirect:'manual'}),otherState=new URL(another.headers.get('location')||'').searchParams.get('state')||'',otherCookie=another.headers.get('set-cookie')!.split(';')[0]!;
    const denied=await fetch(`${base}/games/imposter/callback?code=code&state=${otherState}`,{headers:{Cookie:otherCookie},redirect:'manual'});assert.equal(denied.status,403,'die Login-Seite stellt keine Rolle aus, wenn die verifizierte User-ID nicht teilnimmt');
  }finally{await server.stop();store.close();for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];for(const [key,value] of Object.entries(env))process.env[key]=value;}
});
