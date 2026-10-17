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

test('Battleabschluss nach Frist verteilt konfigurierte Teilnahme- und Sieger-XP genau einmal',()=>{
  const {store,interactive}=setup();
  try{
    interactive.updateSettings({battleEnabled:true,battleDurationMs:60_000,battleActionCooldownMs:5_000,battleParticipationXp:2,battleWinnerXp:5});
    store.miniGameTransaction(db=>{db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run('twitch-winner','12345678901234567',1);db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run('twitch-other','12345678901234568',1);});
    const event=interactive.startBattle('admin',1_000).event!;
    interactive.join(event.id,'twitch','twitch-winner','Twitch Fan',undefined,1_001);
    interactive.join(event.id,'discord','12345678901234568','Discord Fan',undefined,1_002);
    interactive.contribute(event.id,'twitch-score-1','twitch','twitch-winner',1_003);
    assert.equal(interactive.tick(61_001),1,'periodischer Backend-Tick schließt abgelaufene Battles ohne Dashboard-Zugriff');
    assert.equal(interactive.get(event.id,61_002)?.status,'completed');
    assert.match(interactive.get(event.id,61_002)?.result||'',/Twitch gewinnt/u);
    assert.equal(store.xp('twitch-winner').xp,7,'Twitch-side winner receives participation and winner bonus');
    assert.equal(store.xp('twitch-other').xp,2,'linked Discord participant receives participation XP through shared Twitch identity');
    assert.equal(interactive.tick(62_000),0,'abgeschlossene Events werden vom nächsten Tick nicht erneut verarbeitet');
    assert.equal(store.xp('twitch-winner').xp,7,'restart-safe expiry cannot pay rewards twice');
    assert.throws(()=>interactive.updateSettings({battleWinnerXp:21}),/zwischen 0 und 20/u);
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
    assert.equal(interactive.assignGameNightTeams(event.id,'admin',2,now+3),true);
    const roster=interactive.participants(event.id);assert.equal(roster.filter(person=>person.team).length,2);assert.deepEqual(interactive.get(event.id,now+4)?.settings.teamAssignments,undefined,'private identity assignments are not exposed through public event state');
    assert.equal(interactive.leave(event.id,'twitch','1001',now+4).status,'withdrawn');
    assert.equal(interactive.get(event.id,now+5)?.participants,2);
    assert.equal(interactive.get(event.id,now+5)?.waitlist,0);
    assert.equal(interactive.editGameNight(event.id,'admin',{title:'ACY Spieleabend',game:'Minecraft',localStart:'2026-01-17T19:00',capacity:3,waitlist:true},now+6),true);
    assert.equal(interactive.get(event.id,now+7)?.settings.game,'Minecraft');
    assert.equal(interactive.removeGameNightParticipant(event.id,'discord','12345678901234567',now+8),true);
    assert.equal(interactive.get(event.id,now+9)?.participants,1);
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

test('automatic secret events stay off by default, require recent activity, obey daily limits, and survive persisted event state',()=>{
  const {store,interactive}=setup(()=>2),now=Date.UTC(2026,9,17,12);
  try{
    store.recordRecentChatActivity('viewer-1','Fan 1','fan1',now);store.recordRecentChatActivity('viewer-2','Fan 2','fan2',now);
    assert.equal(interactive.tick(now),0);assert.equal(interactive.active(undefined,now).length,0);
    interactive.updateSettings({secretEventsEnabled:true,autoSecretEventsEnabled:true,secretAutoMinIntervalMs:3_600_000,secretAutoMaxPerDay:1,secretAutoMinActiveChatters:2});
    assert.equal(interactive.tick(now),0);
    const event=interactive.active(undefined,now)[0];assert.ok(event);assert.ok(['mystery_case','elio_rescue','secret_portal'].includes(event.kind));assert.equal(event.status,'open');
    assert.equal(interactive.tick(now+1000),0,'active event prevents overlapping automation');assert.equal(interactive.active(undefined,now+1000).length,1);
    assert.equal(interactive.finish(event.id,'admin',now+2000),true);
    assert.equal(interactive.tick(now+3_600_000),0,'daily event limit prevents another surprise');
    assert.equal(interactive.active(undefined,now+3_600_000).length,0);
  }finally{store.close();}
});

test('Europe/Berlin local schedule conversion handles summer time and rejects ambiguous or nonexistent DST times',()=>{
  assert.equal(localTimeToEpoch('2026-01-15T19:00','Europe/Berlin'),Date.UTC(2026,0,15,18));
  assert.equal(localTimeToEpoch('2026-07-15T19:00','Europe/Berlin'),Date.UTC(2026,6,15,17));
  assert.throws(()=>localTimeToEpoch('2026-03-29T02:30','Europe/Berlin'),/existiert wegen der Zeitumstellung nicht/u);
  assert.throws(()=>localTimeToEpoch('2026-10-25T02:30','Europe/Berlin'),/doppeldeutig/u);
});
