import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunityWorld } from './community-world.js';
import { FeatureStore } from './feature-store.js';

test('Community world derives missions from accepted actions and pays each mission once',()=>{
  const store=new FeatureStore(':memory:'),world=new CommunityWorld(store),user='viewer-1',name='Viewer',now=Date.now()+2_000;
  try{
    let state=world.snapshot(user,name,now,{petEnabled:true,questsEnabled:true,gamesEnabled:true});
    assert.equal(state.missions.length,5);
    assert.equal(state.missions.find(x=>x.id==='visit_elio')?.completed,false);
    store.miniGameTransaction(db=>{
      for(let i=0;i<5;i++)db.prepare("INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at,source) VALUES(?,?,?,?,'portal')").run(`pet-${i}`,user,'feed',now+i);
    });
    const petMission=world.snapshot(user,name,now+10,{petEnabled:true,questsEnabled:true,gamesEnabled:true}).missions.find(x=>x.id==='visit_elio')!;
    assert.equal(petMission.completed,true);
    assert.deepEqual(world.claim(user,name,'visit_elio',now+11,{petEnabled:true,questsEnabled:true,gamesEnabled:true}),{ok:true,rewardXp:10});
    assert.deepEqual(world.claim(user,name,'visit_elio',now+12,{petEnabled:true,questsEnabled:true,gamesEnabled:true}),{ok:false,reason:'claimed'});
    const trophies=world.snapshot(user,name,now+13,{petEnabled:true,questsEnabled:true,gamesEnabled:true});
    assert.ok(trophies.badges.some(x=>x.id==='elio_friend'));
    assert.equal(trophies.badges.find(x=>x.id==='elio_friend')?.unlockedAt,now+10);

    const policy={maxLength:180,queueLimit:20,maxOpenPerUser:3,cooldownMs:0,activeDurationMs:0,completionXp:25};
    const quest=store.submitQuest({submitterUserId:user,displayName:name,title:'Gemeinsam eine Runde spielen',source:'dashboard'},policy,now+20);
    assert.equal(quest.ok,true);
    const refreshed=world.snapshot(user,name,now+21,{petEnabled:true,questsEnabled:true,gamesEnabled:true});
    assert.equal(refreshed.missions.find(x=>x.id==='share_quest')?.completed,true);
    assert.ok(refreshed.badges.some(x=>x.id==='quest_spark'));
    assert.equal(world.snapshot(user,name,now+22,{petEnabled:false,questsEnabled:false,gamesEnabled:false}).missions.length,0);
  }finally{store.close();}
});

test('community world mission periods roll over and claimed rewards are scoped to the period',()=>{
  const store=new FeatureStore(':memory:'),world=new CommunityWorld(store),user='viewer-2',name='Andere Person';
  try{
    const first=Date.parse('2026-10-14T12:00:00Z');
    store.setConfig('community_world_started_at',first-1);
    store.miniGameTransaction(db=>db.prepare("INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at,source) VALUES('today-feed',?,'feed',?,'portal')").run(user,first));
    assert.equal(world.snapshot(user,name,first,{petEnabled:true,questsEnabled:false,gamesEnabled:false}).missions.find(x=>x.id==='visit_elio')?.completed,true);
    world.claim(user,name,'visit_elio',first+1,{petEnabled:true,questsEnabled:false,gamesEnabled:false});
    const tomorrow=first+86_400_000;
    assert.equal(world.snapshot(user,name,tomorrow,{petEnabled:true,questsEnabled:false,gamesEnabled:false}).missions.find(x=>x.id==='visit_elio')?.claimed,false);
    assert.equal(world.snapshot(user,name,tomorrow,{petEnabled:true,questsEnabled:false,gamesEnabled:false}).missions.find(x=>x.id==='visit_elio')?.progress,0);
  }finally{store.close();}
});

test('daily missions follow the Berlin calendar day, including its midnight boundary',()=>{
  const store=new FeatureStore(':memory:'),world=new CommunityWorld(store),user='viewer-berlin',name='Berlin Viewer';
  try{
    const before=Date.parse('2026-10-14T21:59:59.000Z'),after=Date.parse('2026-10-14T22:00:01.000Z');
    store.setConfig('community_world_started_at',before-1_000);
    store.miniGameTransaction(db=>db.prepare("INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at,source) VALUES('berlin-midnight-feed',?,'feed',?,'portal')").run(user,before));
    assert.equal(world.snapshot(user,name,before,{petEnabled:true,questsEnabled:false,gamesEnabled:false}).missions.find(x=>x.id==='visit_elio')?.completed,true);
    const nextDay=world.snapshot(user,name,after,{petEnabled:true,questsEnabled:false,gamesEnabled:false}).missions.find(x=>x.id==='visit_elio');
    assert.equal(nextDay?.completed,false);
    assert.equal(nextDay?.progress,0);
  }finally{store.close();}
});
