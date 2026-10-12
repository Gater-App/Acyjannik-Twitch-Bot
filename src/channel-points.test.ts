import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChannelPointsService } from './channel-points.js';
import { FeatureStore } from './feature-store.js';
import { logger } from './logger.js';
import { FileTokenStore, TwitchOAuth } from './twitch-oauth.js';
import { TwitchApi, TwitchApiError } from './twitch-api.js';

const policy={maxLength:180,queueLimit:20,maxOpenPerUser:2,cooldownMs:0,activeDurationMs:0,completionXp:25};
const reward={id:'reward-1',broadcaster_id:'channel-1',title:'Quest für Jannik 🎯',prompt:'Quest-Idee',cost:2000,
  is_user_input_required:true,should_redemptions_skip_request_queue:false,is_enabled:true};
function event(id='redemption-1',overrides:Record<string,unknown>={}) {
  return {metadata:{message_type:'notification',message_id:`delivery-${id}`},payload:{subscription:{type:'channel.channel_points_custom_reward_redemption.add',
    condition:{broadcaster_user_id:'channel-1',reward_id:'reward-1'}},event:{id,broadcaster_user_id:'channel-1',user_id:'viewer-1',user_name:'Viewer',
      user_input:'Nur Pistolen in der nächsten Runde',redeemed_at:'2026-10-12T20:00:00.000Z',status:'unfulfilled',reward,...overrides}}};
}

async function harness(fetchHelix:typeof fetch) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jannik-channel-points-'));
  const store=new FeatureStore(':memory:');
  const tokenStore=new FileTokenStore(path.join(directory,'broadcaster-token.json'));
  const oauthFetch:typeof fetch=async(input,init)=>String(input).endsWith('/oauth2/token')
    ?Response.json({access_token:'broadcaster-access',refresh_token:'broadcaster-refresh',expires_in:3600,scope:['channel:manage:redemptions'],token_type:'bearer'})
    :fetchHelix(input,init);
  const oauth=new TwitchOAuth('client','secret','http://127.0.0.1/callback',['channel:manage:redemptions'],tokenStore,oauthFetch,logger);
  await oauth.exchangeCode('test-code');
  const api=new TwitchApi('client',oauth,oauthFetch,logger);
  const service=new ChannelPointsService(store,api,oauth,'channel-1',()=>policy,logger);
  await service.saveSettings({enabled:true,rewardId:'reward-1',rewardTitle:reward.title,cost:2000,fulfillOnApproval:true});
  return {directory,store,oauth,service,close:async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});}};
}

test('Channel-Points-Events werden auf Kanal/Reward geprüft und Redemption-ID verhindert Duplikatquests',async()=>{
  const h=await harness(async()=>Response.json({data:[]}));
  try{
    await h.service.acceptEventSub(event() as unknown as Record<string,unknown>);
    await h.service.acceptEventSub(event() as unknown as Record<string,unknown>);
    await h.service.acceptEventSub(event('foreign',{broadcaster_user_id:'someone-else'}) as unknown as Record<string,unknown>);
    const redemptions=h.store.channelRedemptions();
    assert.equal(redemptions.length,1);
    assert.equal(redemptions[0]?.status,'pending');
    assert.equal(h.store.listQuests('pending').length,1);
    assert.equal(h.store.listQuests('pending')[0]?.source,'channel_points');
    assert.equal(h.store.listQuests('pending')[0]?.title,'Nur Pistolen in der nächsten Runde');
  }finally{await h.close();}
});

test('Ungültige Einlösung bleibt als manuelle Klärung privat und erzeugt keine Quest',async()=>{
  const h=await harness(async()=>Response.json({data:[]}));
  try{
    await h.service.acceptEventSub(event('invalid',{user_input:'<script>alert(1)</script>'}) as unknown as Record<string,unknown>);
    assert.equal(h.store.listQuests('all').length,0);
    assert.equal(h.store.channelRedemptions()[0]?.status,'manual');
    assert.match(h.store.channelRedemptions()[0]?.lastError||'',/manuelle Prüfung/u);
  }finally{await h.close();}
});

test('Quest-Freigabe gleicht Twitch-Status ab und bestätigt Fulfillment genau einmal',async()=>{
  let patches=0;
  const h=await harness(async(input,init)=>{
    const url=String(input);
    if(url.includes('/redemptions?')){
      if(init?.method==='PATCH'){patches++;return Response.json({data:[{id:'redemption-1',broadcaster_id:'channel-1',user_id:'viewer-1',user_name:'Viewer',
        user_input:'Nur Pistolen in der nächsten Runde',redeemed_at:'2026-10-12T20:00:00Z',status:'FULFILLED',reward}]});}
      return Response.json({data:[{id:'redemption-1',broadcaster_id:'channel-1',user_id:'viewer-1',user_name:'Viewer',
        user_input:'Nur Pistolen in der nächsten Runde',redeemed_at:'2026-10-12T20:00:00Z',status:'UNFULFILLED',reward}]});
    }
    throw new Error(`Unexpected Helix call: ${url}`);
  });
  try{
    await h.service.acceptEventSub(event() as unknown as Record<string,unknown>);
    const quest=h.store.listQuests('pending')[0]!;
    h.store.transitionQuest(quest.id,'approved','admin-1',Date.now(),policy);
    await h.service.resolveQuest(quest.id,'approved');
    await h.service.resolveQuest(quest.id,'approved');
    assert.equal(patches,1);
    assert.equal(h.store.channelRedemptions()[0]?.status,'fulfilled');
  }finally{await h.close();}
});

test('403 bei Cancellation wird als manuell zu prüfen angezeigt und verspricht keine Erstattung',async()=>{
  const h=await harness(async(input,init)=>{
    if(String(input).includes('/redemptions?')&&init?.method==='PATCH')return new Response('forbidden',{status:403});
    if(String(input).includes('/redemptions?'))return Response.json({data:[{id:'redemption-1',broadcaster_id:'channel-1',user_id:'viewer-1',user_name:'Viewer',
      user_input:'Nur Pistolen in der nächsten Runde',redeemed_at:'2026-10-12T20:00:00Z',status:'UNFULFILLED',reward}]});
    throw new Error(`Unexpected Helix call: ${String(input)}`);
  });
  try{
    await h.service.acceptEventSub(event() as unknown as Record<string,unknown>);
    const quest=h.store.listQuests('pending')[0]!;
    h.store.transitionQuest(quest.id,'rejected','admin-1',Date.now(),policy);
    await h.service.resolveQuest(quest.id,'rejected');
    const row=h.store.channelRedemptions()[0]!;
    assert.equal(row.status,'manual');
    assert.match(row.lastError||'',/keine Erstattung versprochen/u);
  }finally{await h.close();}
});

test('Reward-Voraussetzungen und Twitch-429/401-Fehler bleiben nachvollziehbar',async()=>{
  const h=await harness(async(input)=>{
    if(String(input).includes('only_manageable_rewards=false'))return Response.json({data:[reward]});
    return new Response('rate limit',{status:429,headers:{'Ratelimit-Reset':String(Math.floor(Date.now()/1000)+15)}});
  });
  try{
    await assert.rejects(h.service.createReward(2000),/existiert bereits/u);
    await assert.rejects(h.service.manageableRewards(),(error:unknown)=>error instanceof TwitchApiError&&error.status===429&&Boolean(error.retryAfterMs));
    assert.equal(h.oauth.grantedScopes.includes('channel:manage:redemptions'),true);
  }finally{await h.close();}
});
