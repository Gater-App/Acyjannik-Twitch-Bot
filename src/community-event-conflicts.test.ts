import assert from 'node:assert/strict';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { findActiveCommunityEventConflict } from './community-event-conflicts.js';

test('Saison-Aktivierung und geplante Game Night gelten nicht als laufende Chatspiele',()=>{
  const store=new FeatureStore(':memory:');
  store.miniGameTransaction(db=>{
    db.prepare("UPDATE seasonal_events SET active=1 WHERE id='halloween'").run();
    db.prepare("INSERT INTO community_interactive_events(id,kind,status,title,description,starts_at,ends_at,settings_json,created_by,created_at,updated_at) VALUES('night','game_night','open','Game Night','',100,200,'{}','test',1,1)").run();
  });
  assert.equal(store.miniGameQuery(db=>findActiveCommunityEventConflict(db)),undefined);
  store.close();
});

test('eine tatsächlich laufende, inkompatible Runde wird durch den gemeinsamen Konfliktcheck erkannt',()=>{
  const store=new FeatureStore(':memory:');
  store.miniGameTransaction(db=>db.prepare("INSERT INTO community_chaos_events(id,game,status,starts_at,deadline,settings_json,test_mode,created_by) VALUES('chaos','treasure','active',1,40000,'{}',1,'test')").run());
  assert.deepEqual(store.miniGameQuery(db=>findActiveCommunityEventConflict(db)),{type:'community-chaos',id:'chaos',label:'Community-Chaos'});
  store.close();
});
