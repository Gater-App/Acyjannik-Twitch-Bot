import assert from 'node:assert/strict';
import test from 'node:test';
import { TwitchVipService } from './twitch-vip.js';
import type { TwitchOAuth } from './twitch-oauth.js';

function oauth(scopes=['channel:read:vips'],userId='broadcaster-1',clientId='client-1'){
  const fake={getAccessToken:async()=> 'test-token',refreshAccessToken:async()=> 'test-token'} as unknown as TwitchOAuth;
  return {fake,validate:()=>Response.json({client_id:clientId,user_id:userId,scopes})};
}

test('Twitch VIP lookup uses broadcaster authorization, Twitch user ID, and fails closed',async()=>{
  const {fake,validate}=oauth();const seen:string[]=[];
  const fetchImpl:typeof fetch=async(input,init)=>{const url=String(input);seen.push(url);if(url.endsWith('/oauth2/validate'))return validate();if(url.includes('/channels/vips?'))return Response.json({data:[{user_id:'12345',user_name:'viewer'}]});throw new Error('unexpected request')};
  const service=new TwitchVipService('client-1','broadcaster-1',fake,fetchImpl);
  assert.equal((await service.status()).state,'ready');
  assert.equal(await service.isVip('12345'),true);
  assert.equal(await service.isVip('viewer-name'),false);
  assert.equal(await service.isVip('ordinary-8'),false);
  const vipUrl=new URL(seen.find(value=>value.includes('/channels/vips?'))!);
  assert.equal(vipUrl.searchParams.get('broadcaster_id'),'broadcaster-1');
  assert.equal(vipUrl.searchParams.get('user_id'),'12345');
});

test('Twitch VIP lookup rejects wrong broadcaster, missing scope, and API failures',async()=>{
  for(const scenario of [
    {name:'wrong broadcaster',...oauth(['channel:read:vips'],'someone-else')},
    {name:'wrong Twitch app',...oauth(['channel:read:vips'],'broadcaster-1','other-client')},
    {name:'missing scope',...oauth([])},
  ]){
    const service=new TwitchVipService('client-1','broadcaster-1',scenario.fake,async input=>String(input).endsWith('/oauth2/validate')?scenario.validate():Response.json({data:[{user_id:'vip-7'}]}));
    assert.notEqual((await service.status()).state,'ready',scenario.name);
    assert.equal(await service.isVip('vip-7'),false,scenario.name);
  }
  const {fake,validate}=oauth();
  const unavailable=new TwitchVipService('client-1','broadcaster-1',fake,async input=>String(input).endsWith('/oauth2/validate')?validate():new Response('unavailable',{status:503}));
  assert.equal(await unavailable.isVip('vip-7'),false);
});
