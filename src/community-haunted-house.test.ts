import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunityHauntedHouse } from './community-haunted-house.js';
import { CommunityWorld } from './community-world.js';
import { FeatureStore } from './feature-store.js';

function activate(store:FeatureStore,now:number,startAt:number|null=null,endAt:number|null=null):void{
  const existing=store.event('halloween');assert.ok(existing);
  store.saveEvent({...existing,active:false,startAt,endAt,timezone:'Europe/Berlin'});
  assert.equal(store.setEventActive('halloween',true,now),true);
}

test('Haunted House counts accepted event IDs once, unlocks rooms and persists achievements after the season',()=>{
  const store=new FeatureStore(':memory:'),house=new CommunityHauntedHouse(store),world=new CommunityWorld(store),now=Date.UTC(2026,9,31,18);
  try{
    activate(store,now,now-60_000,now+60_000);
    assert.deepEqual(house.recordAcceptedPlay('treat-1','viewer-1',now),{progress:1,justCompleted:false});
    assert.deepEqual(house.recordAcceptedPlay('treat-1','viewer-other',now+1),{progress:1,justCompleted:false},'EventSub-Duplikate tragen nicht erneut bei');
    for(let i=2;i<=25;i++)house.recordAcceptedPlay(`treat-${i}`,`viewer-${i%2}`,now+i);
    let snapshot=house.snapshot('viewer-1',now+30);
    assert.equal(snapshot.progress,25);assert.equal(snapshot.contributors,2);assert.equal(snapshot.rooms[0]?.unlocked,true);assert.equal(snapshot.rooms[1]?.unlocked,true);assert.equal(snapshot.rooms[2]?.unlocked,false);
    for(let i=26;i<=100;i++)house.recordAcceptedPlay(`treat-${i}`,`viewer-${i%3}`,now+i);
    snapshot=house.snapshot('viewer-1',now+101);
    assert.equal(snapshot.completed,true);assert.equal(snapshot.rooms.every(room=>room.unlocked),true);
    const earned=world.snapshot('viewer-1','Viewer',now+102,{petEnabled:false,questsEnabled:false,gamesEnabled:false}).badges.map(x=>x.id);
    assert.ok(earned.includes('haunted_visitor'));assert.ok(earned.includes('haunted_scout'));assert.ok(earned.includes('haunted_house_crew'));
    const before={pumpkins:store.score('halloween','viewer-1'),xp:(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) AS n FROM xp_ledger').get()) as {n:number}).n};
    assert.equal(store.setEventActive('halloween',false,now+110),true);
    const archived=house.snapshot('viewer-1',now+111);
    assert.equal(archived.active,false);assert.equal(archived.progress,100);assert.equal(archived.personal?.visits,38);
    const after={pumpkins:store.score('halloween','viewer-1'),xp:(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) AS n FROM xp_ledger').get()) as {n:number}).n};
    assert.deepEqual(after,before,'Spukhaus-Fortschritt vergibt keine Kürbisse und keine XP');
  }finally{store.close();}
});

test('Haunted House akzeptiert keine Beiträge außerhalb der konfigurierten Saison und startet im Folgejahr neu',()=>{
  const store=new FeatureStore(':memory:'),house=new CommunityHauntedHouse(store),now=Date.UTC(2026,9,31,18),start=now+60_000,end=now+120_000;
  try{
    activate(store,now,start,end);
    assert.equal(house.recordAcceptedPlay('early','viewer-1',now),undefined);
    assert.equal(house.recordAcceptedPlay('late','viewer-1',end),undefined);
    assert.equal(house.snapshot(undefined,now).progress,0);
    assert.equal(store.setEventActive('halloween',false,end),true);
    const prior=store.event('halloween');assert.ok(prior);
    const nextStart=Date.UTC(2027,9,31,18);store.saveEvent({...prior,active:false,startAt:nextStart,endAt:nextStart+60_000});
    assert.equal(store.setEventActive('halloween',true,nextStart),true);
    assert.deepEqual(house.recordAcceptedPlay('new-season','viewer-1',nextStart),{progress:1,justCompleted:false});
    const current=house.snapshot('viewer-1',nextStart+1);
    assert.equal(current.progress,1);assert.equal(current.seasonYear,2027);assert.equal(current.rooms[0]?.unlocked,true);assert.equal(current.rooms[1]?.unlocked,false);
  }finally{store.close();}
});
