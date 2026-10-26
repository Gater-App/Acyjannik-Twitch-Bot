import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommunityFeatures } from './community-features.js';
import { CHRISTMAS_2026_START_AT, FeatureStore, HALLOWEEN_2026_END_AT } from './feature-store.js';
import { testConfig } from './test-config.js';

function seedScore(store:FeatureStore,userId:string,name:string,points:number,updatedAt:number):void {
  store.miniGameTransaction(db=>{
    db.prepare(`INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at) VALUES('halloween',?,?,?,?)
      ON CONFLICT(event_id,user_id) DO UPDATE SET display_name=excluded.display_name,points=excluded.points,updated_at=excluded.updated_at`).run(userId,name,points,updatedAt);
    db.prepare(`INSERT INTO players(user_id,display_name,pumpkins,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,pumpkins=excluded.pumpkins,updated_at=excluded.updated_at`).run(userId,name,points,updatedAt);
  });
}

test('migration v49 fixes the 2026 seasonal boundaries to Europe/Berlin and is restart-safe',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acy-seasonal-v49-')),file=path.join(dir,'data','state.sqlite');
  try{
    let store=new FeatureStore(file);
    const before=store.miniGameQuery(db=>({version:(db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number}).version,halloween:db.prepare("SELECT end_at endAt,timezone FROM seasonal_events WHERE id='halloween'").get(),christmas:db.prepare("SELECT start_at startAt,timezone FROM seasonal_events WHERE id='christmas'").get(),integrity:(db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check}));
    assert.equal(before.version,49);assert.deepEqual(before.halloween,{endAt:HALLOWEEN_2026_END_AT,timezone:'Europe/Berlin'});assert.deepEqual(before.christmas,{startAt:CHRISTMAS_2026_START_AT,timezone:'Europe/Berlin'});assert.equal(before.integrity,'ok');store.close();
    store=new FeatureStore(file);assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM seasonal_event_results').get() as {n:number}).n),0);store.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Halloween bleibt eine Sekunde vor Mitternacht spielbar und ist exakt ab Mitternacht serverseitig gesperrt',()=>{
  const store=new FeatureStore(':memory:'),community=new CommunityFeatures(store,testConfig());
  try{
    store.miniGameTransaction(db=>db.prepare("UPDATE seasonal_events SET cooldown_ms=0 WHERE id='halloween'").run());
    assert.equal(store.setEventActive('halloween',true,HALLOWEEN_2026_END_AT-1),true);
    const last=store.playEvent('halloween','viewer','Viewer',3,HALLOWEEN_2026_END_AT-1,{eventId:'last-valid-halloween',format:points=>String(points)});assert.equal(last.ok,true);
    const after=store.playEvent('halloween','viewer-2','Viewer 2',10,HALLOWEEN_2026_END_AT,{eventId:'first-invalid-halloween',format:points=>String(points)});assert.deepEqual(after,{ok:false,reason:'inactive'});
    community.tick(HALLOWEEN_2026_END_AT,false);
    assert.equal(store.activeEvent()?.id,undefined);assert.equal(store.score('halloween','viewer'),3);
    assert.equal(store.seasonalEventResult('halloween',2026)?.endAt,HALLOWEEN_2026_END_AT);
    assert.deepEqual(store.playEvent('halloween','viewer-3','Viewer 3',-1,HALLOWEEN_2026_END_AT+1,{eventId:'late-halloween-loss',format:()=>''}),{ok:false,reason:'inactive'});
  }finally{store.close();}
});

test('Halloween final ranking excludes broadcaster and bots, breaks ties by Twitch ID, and freezes after restart',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acy-seasonal-final-')),file=path.join(dir,'data','state.sqlite');let store=new FeatureStore(file);
  try{
    seedScore(store,'200','Zoe',40,2);seedScore(store,'100','Anna',40,3);seedScore(store,'broadcaster','Jannik',999,4);seedScore(store,'service-bot','Nightbot',1500,5);seedScore(store,'zero','Nullpunkt',0,6);
    store.recordRecentChatActivity('service-bot','Nightbot','nightbot',HALLOWEEN_2026_END_AT-10);
    const result=store.finalizeHalloween2026(HALLOWEEN_2026_END_AT+500,['broadcaster','bot-id']);assert.ok(result);
    assert.equal(result.winnerName,'Anna');assert.equal(result.winnerPoints,40);assert.deepEqual(result.leaderboard.map(row=>row.displayName),['Anna','Zoe','Nullpunkt']);
    seedScore(store,'100','Anna',9999,HALLOWEEN_2026_END_AT+1000);
    const unchanged=store.finalizeHalloween2026(HALLOWEEN_2026_END_AT+2000,['broadcaster','bot-id']);assert.equal(unchanged?.winnerPoints,40);assert.equal(unchanged?.leaderboard[0]?.points,40);
  }finally{store.close();}
  store=new FeatureStore(file);try{const result=store.seasonalEventResult('halloween',2026);assert.equal(result?.winnerName,'Anna');assert.equal(result?.winnerPoints,40);assert.equal(result?.leaderboard[0]?.points,40);assert.equal(result?.announcementStatus,'pending');}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('offline Halloween result is retained in the dashboard data and announced exactly once on the next confirmed live stream',()=>{
  const store=new FeatureStore(':memory:'),community=new CommunityFeatures(store,testConfig());
  try{
    seedScore(store,'viewer-1','Basti',25,100);community.tick(HALLOWEEN_2026_END_AT,false);
    assert.equal(community.seasonalEventResults()[0]?.winnerName,'Basti');
    assert.deepEqual(community.claimSeasonalResultMessages(HALLOWEEN_2026_END_AT+1,false),[]);
    const first=community.claimSeasonalResultMessages(HALLOWEEN_2026_END_AT+1,true);assert.equal(first.length,1);assert.match(first[0]?.message||'',/Basti mit 25 Kürbissen/u);
    assert.deepEqual(community.claimSeasonalResultMessages(HALLOWEEN_2026_END_AT+2,true),[],'Lease verhindert Doppelankündigung bei mehrfachen Ticks');
    assert.equal(community.finishSeasonalResultDelivery('halloween',2026,true,HALLOWEEN_2026_END_AT+3),true);
    assert.deepEqual(community.claimSeasonalResultMessages(HALLOWEEN_2026_END_AT+4,true),[]);
  }finally{store.close();}
});

test('fehlgeschlagene Gewinnernachricht ist retrybar, aber ein erfolgreicher Versand bleibt abgeschlossen',()=>{
  const store=new FeatureStore(':memory:');
  try{
    seedScore(store,'viewer-1','Basti',5,10);const result=store.finalizeHalloween2026(HALLOWEEN_2026_END_AT,['broadcaster','bot']);assert.ok(result);
    const first=store.claimSeasonalResultMessages(HALLOWEEN_2026_END_AT+1,true);assert.equal(first.length,1);
    assert.equal(store.finishSeasonalResultDelivery('halloween',2026,false,HALLOWEEN_2026_END_AT+2,'simulierter Versandfehler'),true);
    assert.equal(store.seasonalEventResult('halloween',2026)?.announcementStatus,'pending');
    assert.equal(store.claimSeasonalResultMessages(HALLOWEEN_2026_END_AT+31_000,true).length,1);
    assert.equal(store.finishSeasonalResultDelivery('halloween',2026,true,HALLOWEEN_2026_END_AT+31_001),true);
    assert.equal(store.seasonalEventResult('halloween',2026)?.announcementStatus,'sent');
    assert.equal(store.retrySeasonalResultDelivery('halloween',2026,HALLOWEEN_2026_END_AT+40_000),false);
  }finally{store.close();}
});

test('Weihnachtsaktionen sind vor dem lokalen Start gesperrt und der Scheduler startet sie am exakten Zeitpunkt',()=>{
  const store=new FeatureStore(':memory:'),community=new CommunityFeatures(store,testConfig());
  try{
    assert.equal(store.setEventActive('christmas',true,CHRISTMAS_2026_START_AT-1),false);
    assert.deepEqual(store.playEvent('christmas','early','Early',5,CHRISTMAS_2026_START_AT-1,{eventId:'early-gift',format:()=>''}),{ok:false,reason:'inactive'});
    community.tick(CHRISTMAS_2026_START_AT-1,false);assert.equal(store.activeEvent(),undefined);
    community.tick(CHRISTMAS_2026_START_AT,false);assert.equal(store.activeEvent()?.id,'christmas');
    const gift=store.playEvent('christmas','viewer','Viewer',3,CHRISTMAS_2026_START_AT,{eventId:'first-gift',format:points=>String(points)});assert.equal(gift.ok,true);
  }finally{store.close();}
});
