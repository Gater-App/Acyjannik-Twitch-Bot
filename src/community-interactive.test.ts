import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureStore } from './feature-store.js';
import { CommunityInteractive, localTimeToEpoch } from './community-interactive.js';

function setup(chooseOutcome?:(exclusiveMax:number)=>number){const store=new FeatureStore(':memory:'),interactive=new CommunityInteractive(store,chooseOutcome);return {store,interactive};}

test('Twitch-vs-Discord defaults off, assigns platform teams, deduplicates linked identity, and bounds points',()=>{
  const {store,interactive}=setup();
  try{
    assert.equal(interactive.settings().battleEnabled,false);
    assert.equal(interactive.startBattle('admin',1).ok,false);
    interactive.updateSettings({battleEnabled:true,battleActionCooldownMs:30_000,battleMaxPointsPerUser:2});
    const started=interactive.startBattle('admin',1000);assert.equal(started.ok,true);const event=started.event!;
    store.miniGameTransaction(db=>db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run('twitch-1','12345678901234567',1000));
    assert.equal(interactive.join(event.id,'twitch','twitch-1','TwitchFan',undefined,1100).status,'joined');
    const crossTeam=interactive.join(event.id,'discord','12345678901234567','DiscordFan',undefined,1200);assert.equal(crossTeam.ok,false);assert.match(crossTeam.message,/nur für ein Team/u);
    assert.equal(interactive.join(event.id,'discord','12345678901234568','DiscordFan',undefined,1200).status,'joined');
    assert.equal(interactive.join(event.id,'discord','12345678901234569','LateLinkFan',undefined,1200).status,'joined');
    store.miniGameTransaction(db=>db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run('twitch-late-link','12345678901234569',1300));
    assert.equal(interactive.join(event.id,'twitch','twitch-late-link','LateLinkFan',undefined,1400).ok,false,'linking during an event must retain the existing team identity');
    assert.equal(interactive.contribute(event.id,'late-link-action','twitch','twitch-late-link',2000).points,1,'a newly linked Twitch identity acts on the original participant record');
    const scored=interactive.contribute(event.id,'twitch-action-1','twitch','twitch-1',2000);assert.equal(scored.points,1);
    const replay=interactive.contribute(event.id,'twitch-action-1','twitch','twitch-1',2500);assert.equal(replay.duplicate,true);assert.equal(replay.points,0);
    assert.equal(interactive.contribute(event.id,'twitch-action-2','twitch','twitch-1',3000).ok,false,'per-user cooldown applies');
    assert.equal(interactive.contribute(event.id,'twitch-action-2','twitch','twitch-1',40_000).points,1);
    assert.equal(interactive.contribute(event.id,'twitch-action-3','twitch','twitch-1',80_000).ok,false,'per-user point limit applies');
    assert.deepEqual(interactive.get(event.id,80_001)?.points,{twitch:2,discord:1});
    assert.equal(interactive.finish(event.id,'admin',90_000),true);
    assert.equal(interactive.contribute(event.id,'late-action','twitch','twitch-1',90_001).ok,false);
  }finally{store.close();}
});

test('Game Night uses Berlin wall time, enforces capacity atomically, and promotes the waitlist on cancellation',()=>{
  const {store,interactive}=setup();
  try{
    assert.equal(interactive.settings().gameNightEnabled,false);
    interactive.updateSettings({gameNightEnabled:true});
    const now=Date.UTC(2026,0,1,12),created=interactive.createGameNight('admin',{title:'ACY Game Night',game:'Minecraft',localStart:'2026-01-15T19:00',capacity:2,waitlist:true},now);
    const event=created.event!;assert.equal(event.startsAt,Date.UTC(2026,0,15,18));
    assert.equal(interactive.join(event.id,'twitch','1001','Spielerin',undefined,now+1).status,'joined');
    assert.equal(interactive.join(event.id,'discord','12345678901234567','Spieler',undefined,now+2).status,'joined');
    assert.equal(interactive.join(event.id,'discord','12345678901234568','Warteliste',undefined,now+3).status,'waitlist');
    assert.equal(interactive.leave(event.id,'twitch','1001',now+4).status,'withdrawn');
    assert.equal(interactive.get(event.id,now+5)?.participants,2);
    assert.equal(interactive.get(event.id,now+5)?.waitlist,0);
  }finally{store.close();}
});

test('Secret events resolve server-side once, use central XP, and preserve one shared participant identity',()=>{
  const {store,interactive}=setup(()=>0);
  try{
    assert.equal(interactive.createSecretEvent('mystery_case','admin',{title:'Mysteriöser Koffer'},10_000).ok,false);
    interactive.updateSettings({secretEventsEnabled:true,secretEventDurationMs:15_000,secretRewardXp:5});
    store.setConfig('arcade_settings',{petEnabled:true});
    store.miniGameTransaction(db=>db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run('twitch-secret','12345678901234567',1000));
    const event=interactive.createSecretEvent('mystery_case','admin',{title:'Mysteriöser Koffer'},10_000).event!;
    assert.equal(interactive.join(event.id,'discord','12345678901234567','Viewer',undefined,10_001).status,'joined');
    assert.equal(interactive.get(event.id,25_000)?.status,'completed');
    assert.match(interactive.get(event.id,25_001)?.result||'',/5 Community-XP/u);
    assert.equal(store.xp('twitch-secret').xp,5);
    assert.equal(interactive.finish(event.id,'admin',25_002),false,'completed event cannot distribute another result');
    assert.equal(store.xp('twitch-secret').xp,5);
    assert.throws(()=>interactive.updateSettings({autoSecretEventsEnabled:true,secretEventsEnabled:false}),/manuelle Event-Freigabe/u);
  }finally{store.close();}
});

test('Europe/Berlin local schedule conversion handles summer time and rejects ambiguous or nonexistent DST times',()=>{
  assert.equal(localTimeToEpoch('2026-01-15T19:00','Europe/Berlin'),Date.UTC(2026,0,15,18));
  assert.equal(localTimeToEpoch('2026-07-15T19:00','Europe/Berlin'),Date.UTC(2026,6,15,17));
  assert.throws(()=>localTimeToEpoch('2026-03-29T02:30','Europe/Berlin'),/existiert wegen der Zeitumstellung nicht/u);
  assert.throws(()=>localTimeToEpoch('2026-10-25T02:30','Europe/Berlin'),/doppeldeutig/u);
});
