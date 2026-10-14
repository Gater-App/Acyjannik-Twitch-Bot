import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { DEFAULT_VIP_SETTINGS, VipExperience } from './vip-experience.js';

test('VIP experience persists safe defaults, limits chaos requests, and grants achievements once',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vip-experience-')),store=new FeatureStore(path.join(dir,'state.sqlite'));
  try{
    const vip=new VipExperience(store);
    assert.deepEqual(vip.settings(),DEFAULT_VIP_SETTINGS);
    vip.updateSettings({enabled:true,loungeEnabled:true,elioEnabled:true,chaosEnabled:true,challengesEnabled:true,achievementsEnabled:true,globalCooldownMinutes:2});
    assert.equal(vip.settings().enabled,true);
    assert.equal(vip.updateSettings({enabled:true}).enabled,true);
    assert.throws(()=>vip.updateSettings({enabled:true,adminIds:['viewer']}),/unbekannte Felder/u);
    assert.throws(()=>vip.updateSettings({globalCooldownMinutes:0}),/erlaubten Bereich/u);

    const first=vip.requestChaos('123','VIP','stream-1','elio-crown',10_000);
    assert.equal(first.ok,true);
    assert.equal(vip.requestChaos('123','VIP','stream-1','oracle',10_001).ok,false,'eine Anfrage je VIP und Stream');
    assert.equal(vip.requestChaos('456','VIP 2','stream-1','oracle',10_002).ok,false,'höchstens eine offene Anfrage global');
    const pending=vip.pendingRequests();assert.equal(pending.length,1);assert.equal(pending[0]?.status,'pending');
    assert.equal(vip.decideRequest(String(first.id),'mod-1',true,10_003)?.status,'pending');
    assert.equal(vip.decideRequest(String(first.id),'mod-2',true,10_004),undefined,'Freigabe ist nur einmal möglich');
    vip.finishRequest(String(first.id),true,10_005);
    assert.equal(vip.requestChaos('456','VIP 2','stream-1','oracle',20_000).ok,false,'globaler Cooldown');
    assert.equal(vip.recordChaosAchievement('123',20_001),true);
    assert.equal(vip.recordChaosAchievement('123',20_002),false);

    for(let i=0;i<5;i++)vip.recordPetPlay('123',`pet-${i}`,30_000+i);
    assert.equal(vip.achievements('123').filter(b=>b.id==='royal_cat_friend').length,1);
    assert.equal(vip.recordPetPlay('123','pet-4',30_010),false,'doppelte Event-ID erhöht den Fortschritt nicht');
    const reopened=new FeatureStore(path.join(dir,'state.sqlite'));
    assert.equal(new VipExperience(reopened).achievements('123').length,2,'VIP-Abzeichen bleiben nach erneutem Öffnen der Datenbank erhalten');
    reopened.close();
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('VIP challenge submissions use the existing quest record and cooldown',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vip-challenge-')),store=new FeatureStore(path.join(dir,'state.sqlite'));
  try{
    const vip=new VipExperience(store);vip.updateSettings({enabled:true,challengesEnabled:true});
    assert.equal(vip.canSubmitChallenge('viewer',1000),true);
    assert.equal(vip.submitChallenge('viewer','quest-1',1000),true);
    assert.equal(vip.submitChallenge('viewer','quest-2',1001),false);
    assert.equal(vip.canSubmitChallenge('viewer',1001),false);
    assert.equal(vip.challengeRows()[0]?.questId,'quest-1');
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
