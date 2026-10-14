import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { FileTokenStore, OAuthCallbackServer, TwitchOAuth } from './twitch-oauth.js';

test('OAuth-URL enthält nur die minimalen Chat-Scopes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-oauth-'));
  const oauth = new TwitchOAuth('client', 'secret', 'http://127.0.0.1/callback', ['user:read:chat', 'user:write:chat'], new FileTokenStore(path.join(directory, 'tokens.json')));
  const url = new URL(oauth.authorizationUrl);
  assert.equal(url.searchParams.get('scope'), 'user:read:chat user:write:chat');
  await fs.rm(directory, { recursive: true, force: true });
});

test('Refresh-Token-Rotation wird gespeichert ohne Tokens zu loggen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-oauth-refresh-'));
  const tokenPath = path.join(directory, 'tokens.json');
  const fetchMock: typeof fetch = async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'bearer' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const oauth = new TwitchOAuth('client', 'secret', 'http://127.0.0.1/callback', [], new FileTokenStore(tokenPath), fetchMock);
  await oauth.initialize(undefined, 'old-refresh');
  assert.equal(await oauth.getAccessToken(), 'new-access');
  const saved = JSON.parse(await fs.readFile(tokenPath, 'utf8')) as { accessToken: string; refreshToken: string };
  assert.equal(saved.accessToken, 'new-access');
  assert.equal(saved.refreshToken, 'new-refresh');
  await fs.rm(directory, { recursive: true, force: true });
});

test('parallele OAuth-401s teilen sich einen Refresh statt ein rotierendes Token doppelt einzulösen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-oauth-single-refresh-'));
  const tokenPath = path.join(directory, 'tokens.json'), store = new FileTokenStore(tokenPath);
  await store.save({ accessToken: 'old-access', refreshToken: 'old-refresh' });
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'bearer' });
  };
  const oauth = new TwitchOAuth('client', 'secret', 'http://127.0.0.1/callback', [], store, fetchMock);
  await oauth.initialize();
  await Promise.all([oauth.refreshAccessToken(), oauth.refreshAccessToken()]);
  assert.equal(calls, 1);
  assert.equal((await store.load())?.refreshToken, 'rotated-refresh');
  await fs.rm(directory, { recursive: true, force: true });
});

test('Token-Refresh erhält den gespeicherten Broadcaster-Scope, wenn Twitch ihn nicht erneut mitsendet', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-oauth-scopes-'));
  const tokenPath = path.join(directory, 'tokens.json');
  const store = new FileTokenStore(tokenPath);
  await store.save({ accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0, scopes: ['channel:manage:redemptions'] });
  const fetchMock: typeof fetch = async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'bearer' });
  const oauth = new TwitchOAuth('client', 'secret', 'http://127.0.0.1/callback', ['channel:manage:redemptions'], store, fetchMock);
  await oauth.initialize();
  assert.deepEqual(oauth.grantedScopes, ['channel:manage:redemptions']);
  assert.deepEqual((await store.load())?.scopes, ['channel:manage:redemptions']);
  await fs.rm(directory, { recursive: true, force: true });
});

test('Broadcaster-Kanalpunkte erhalten separaten Scope und geschützten Reauthorization-Start',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'channel-points-oauth-'));
  const socket=net.createServer();await new Promise<void>((resolve,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as net.AddressInfo).port;await new Promise<void>((resolve)=>socket.close(()=>resolve()));
  const fetchMock:typeof fetch=async()=>Response.json({access_token:'channel-access',refresh_token:'channel-refresh',expires_in:3600,
    scope:['channel:manage:redemptions'],token_type:'bearer'});
  const chat=new TwitchOAuth('client','secret',`http://127.0.0.1:${port}/oauth/callback`,['user:read:chat','user:write:chat'],
    new FileTokenStore(path.join(directory,'chat.json')),fetchMock);
  const broadcaster=new TwitchOAuth('client','secret',`http://127.0.0.1:${port}/oauth/redemptions/callback`,['channel:manage:redemptions'],
    new FileTokenStore(path.join(directory,'broadcaster.json')),fetchMock);
  const server=new OAuthCallbackServer('127.0.0.1',port,60_000,chat,undefined,[{name:'channel-points',oauth:broadcaster,callbackPath:'/oauth/redemptions/callback'}]);
  try{
    await server.start();
    const authorization=new URL(server.startUrlFor('channel-points'));
    assert.equal(authorization.searchParams.get('scope'),'channel:manage:redemptions');
    assert.equal(authorization.searchParams.get('redirect_uri'),`http://127.0.0.1:${port}/oauth/redemptions/callback`);
    assert.equal((await fetch(`http://127.0.0.1:${port}/oauth/redemptions/callback`)).status,400,'Callback ohne state/code wird verworfen');
    const state=authorization.searchParams.get('state');assert.ok(state);
    assert.equal((await fetch(`http://127.0.0.1:${port}/oauth/redemptions/callback?state=${state}&code=test`)).status,200);
    assert.deepEqual(broadcaster.grantedScopes,['channel:manage:redemptions']);
    assert.equal(chat.hasAccessToken,false,'Kanalpunkte-OAuth verändert den separaten Bot-Chat-Token nicht');
    const saved=JSON.parse(await fs.readFile(path.join(directory,'broadcaster.json'),'utf8')) as {scopes:string[]};
    assert.deepEqual(saved.scopes,['channel:manage:redemptions']);
  }finally{await server.stop();await fs.rm(directory,{recursive:true,force:true});}
});

test('Broadcaster OAuth überlebt Prozessneustart, konsumiert State einmalig und lässt Bot-OAuth unverändert',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'oauth-roundtrip-'));
  const socket=net.createServer();await new Promise<void>((resolve,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as net.AddressInfo).port;await new Promise<void>((resolve)=>socket.close(()=>resolve()));
  const botPath=path.join(directory,'bot-tokens.json'),broadcasterPath=path.join(directory,'broadcaster-tokens.json');
  const botStore=new FileTokenStore(botPath),broadcasterStore=new FileTokenStore(broadcasterPath);
  await botStore.save({accessToken:'synthetic-bot-access',refreshToken:'synthetic-bot-refresh',scopes:['user:read:chat','user:write:chat']});
  let exchangedRedirect='';
  const fetchMock:typeof fetch=async(input,init)=>{
    if(String(input).endsWith('/oauth2/token')){
      exchangedRedirect=new URLSearchParams(String(init?.body||'')).get('redirect_uri')||'';
      return Response.json({access_token:'synthetic-broadcaster-access',refresh_token:'synthetic-broadcaster-refresh',expires_in:3600,
        scope:['channel:manage:redemptions'],token_type:'bearer'});
    }
    throw new Error('Unexpected Twitch request in local roundtrip test.');
  };
  const chat=new TwitchOAuth('test-client','test-secret',`http://127.0.0.1:${port}/oauth/callback`,['user:read:chat','user:write:chat'],botStore,fetchMock);
  await chat.initialize();
  const broadcaster=new TwitchOAuth('test-client','test-secret',`https://twitch.gater-app.de/oauth/redemptions/callback`,['channel:manage:redemptions'],broadcasterStore,fetchMock);
  const statePath=path.join(directory,'broadcaster.oauth-state');
  const flow={name:'channel-points',oauth:broadcaster,callbackPath:'/oauth/redemptions/callback',stateFilePath:statePath};
  const makeServer=()=>new OAuthCallbackServer('127.0.0.1',port,600_000,chat,undefined,[flow],path.join(directory,'bot.oauth-state'));
  let server=makeServer();await server.start();
  const authorization=new URL(server.startUrlFor('channel-points'));
  const expectedRedirect='https://twitch.gater-app.de/oauth/redemptions/callback';
  assert.equal(authorization.searchParams.get('redirect_uri'),expectedRedirect);
  const state=authorization.searchParams.get('state');assert.ok(state);
  await server.stop();
  server=makeServer();await server.start();
  try{
    const callback=await fetch(`http://127.0.0.1:${port}/oauth/redemptions/callback?state=${state}&code=synthetic-code`);
    assert.equal(callback.status,200,await callback.text());
    assert.equal(exchangedRedirect,expectedRedirect,'token exchange nutzt dieselbe exakte Callback-URL wie die Autorisierung');
    assert.deepEqual((await broadcasterStore.load())?.scopes,['channel:manage:redemptions']);
    assert.equal((await botStore.load())?.accessToken,'synthetic-bot-access','Broadcaster-OAuth darf Bot-OAuth nicht überschreiben');
    assert.equal((await fetch(`http://127.0.0.1:${port}/oauth/redemptions/callback?state=${state}&code=second-code`)).status,400,'ein State ist nach dem ersten Callback verbraucht');
    assert.equal(fsSync.statSync(statePath).mode&0o077,0,'OAuth-State-Datei hat restriktive Dateirechte');
  }finally{await server.stop();await fs.rm(directory,{recursive:true,force:true});}
});

test('OAuth-Start verwirft eine Redirect-URI mit abweichendem Callback-Pfad',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'oauth-redirect-check-'));
  const oauth=new TwitchOAuth('client','secret','https://twitch.gater-app.de/oauth/redemptions/callback',[],new FileTokenStore(path.join(directory,'tokens.json')));
  const server=new OAuthCallbackServer('127.0.0.1',0,600_000,oauth);
  assert.throws(()=>server.startUrl,/muss exakt auf \/oauth\/callback zeigen/);
  await fs.rm(directory,{recursive:true,force:true});
});
