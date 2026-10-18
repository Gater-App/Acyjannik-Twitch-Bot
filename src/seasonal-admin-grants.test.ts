import assert from 'node:assert/strict';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';

test('seasonal admin grant is transactional, idempotent, audited and mirrors legacy pumpkins',()=>{
  const store=new FeatureStore(':memory:');
  try{
    store.miniGameTransaction(db=>{
      db.prepare('INSERT INTO xp_users(user_id,display_name,xp,updated_at) VALUES(?,?,?,?)').run('123456','IoFan',250,1);
      db.prepare('INSERT INTO players(user_id,display_name,pumpkins,updated_at) VALUES(?,?,?,?)').run('123456','IoFan',7,1);
      db.prepare('INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at) VALUES(?,?,?,?,?)').run('halloween','123456','IoFan',7,1);
      db.prepare('INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at) VALUES(?,?,?,?,?)').run('easter','789012','EggFan',3,1);
    });
    assert.ok(store.seasonalGrantCandidates('EggFan').some(user=>user.userId==='789012'),'Saisonkonten ohne XP-Datensatz bleiben gezielt auffindbar');
    const input={requestId:'40c6fe2c-9846-4cc8-8ea9-9b08723c3a66',eventId:'halloween',userId:'123456',amount:5,actorId:'987654',now:10_000};
    const first=store.grantSeasonalCurrency(input);
    const retry=store.grantSeasonalCurrency({...input,now:11_000});
    assert.equal(first.duplicate,false);assert.equal(first.pointsBefore,7);assert.equal(first.pointsAfter,12);
    assert.equal(retry.duplicate,true);assert.equal(retry.pointsAfter,12);
    assert.equal(store.score('halloween','123456'),12);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT pumpkins FROM players WHERE user_id=?').get('123456') as {pumpkins:number}).pumpkins),12);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM seasonal_admin_grants').get() as {n:number}).n),1);
    assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='seasonal-currency-grant'").get() as {n:number}).n),1);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM xp_ledger').get() as {n:number}).n),0,'Saison-Währungen werden nicht als XP verbucht');
    assert.equal(store.seasonalGrantHistory()[0]?.pointsAfter,12);
  }finally{store.close()}
});

test('seasonal admin grant rejects unknown accounts, unsupported currencies and excessive amounts',()=>{
  const store=new FeatureStore(':memory:');
  try{
    const base={requestId:'79de57e2-b5b6-4a38-a7a2-183e54e70a99',eventId:'easter',userId:'123456',amount:1,actorId:'987654',now:20_000};
    assert.throws(()=>store.grantSeasonalCurrency({...base,eventId:'other'}),/gültige Saison/u);
    assert.throws(()=>store.grantSeasonalCurrency({...base,amount:101}),/1–100/u);
    assert.throws(()=>store.grantSeasonalCurrency(base),/Twitch-Konto/u);
  }finally{store.close()}
});
