import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { FeatureStore } from './feature-store.js';
import { CommunityArcade } from './community-arcade.js';
import { communityWidgetHtml } from './dashboard-community-ui.js';
import type { ChatMessage } from './types.js';

function setup(chooseIndex?:(exclusiveMax:number)=>number){const store=new FeatureStore(':memory:');const arcade=new CommunityArcade(store,'broadcaster',chooseIndex);return {store,arcade};}
function message(user:string,event:string,text:string):ChatMessage{return {eventId:event,messageId:event,broadcasterUserId:'broadcaster',senderUserId:user,senderLogin:user,senderDisplayName:user,message:text,sentAt:1,isModerator:false};}

test('Community-Pet bleibt gemeinschaftlich, begrenzt Werte und dedupliziert Events',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),petEnabled:true});
  const before=arcade.pet();assert.equal(before.stage,'egg');
  assert.match(arcade.handle(message('u1','e1','!feed'),'feed',[],1000)||'',/füttert/u);
  assert.match(arcade.handle(message('u1','e1','!feed'),'feed',[],1001)||'',/bereits verarbeitet/u);
  assert.equal(arcade.pet().hunger,78);
  assert.match(arcade.handle(message('u1','e2','!play'),'play',[],2000)||'',/noch/u);
  assert.equal(arcade.pet().level,1);
  store.close();
});

test('Community-Aktionen werden nur aus gespeicherten, deduplizierten Interaktionen gebündelt und nach Neustart nicht wiederholt',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),petEnabled:true});
  for(const user of ['u1','u2','u3'])assert.match(arcade.handle(message(user,`pet-${user}`,'!feed'),'feed',[],10_000)||'',/füttert/u);
  const notice=arcade.tick(10_001).find(text=>text.includes('Gemeinschafts-Power'));
  assert.match(notice||'',/3 Zuschauer.*3 Aktionen/u);
  assert.equal(arcade.tick(10_002).some(text=>text.includes('Gemeinschafts-Power')),false);
  const afterRestart=new CommunityArcade(store,'broadcaster');
  assert.equal(afterRestart.tick(10_003).some(text=>text.includes('Gemeinschafts-Power')),false);
  const rows=store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_pet_interactions WHERE announced_at IS NOT NULL').get() as {n:number}).n);
  assert.equal(rows,3);
  store.close();
});

test('Mystery-Drop nimmt pro Twitch-ID einen Claim an und vergibt XP genau einmal',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),dropsEnabled:true,dropDurationMs:10_000});
  assert.match(arcade.startDropAdmin('broadcaster','rare',1000),/Ein Mystery Drop startet/u);
  assert.match(arcade.startDropAdmin('broadcaster','rare',1000),/läuft bereits/u);
  assert.match(arcade.handle(message('viewer','c1','!claim'),'claim',[],2000)||'',/dabei/u);
  const status=arcade.handle(message('viewer','status','!drop'),'drop',[],2500)||'';
  assert.match(status,/Mystery Drop läuft noch/u);
  assert.doesNotMatch(status,/common|rare|epic|legendary|community/iu);
  assert.match(arcade.handle(message('viewer','c2','!claim'),'claim',[],3000)||'',/bereits/u);
  assert.match(arcade.tick(11_001)[0]||'',/1 Person erhält je 10 XP/u);
  assert.equal(store.xp('viewer').xp,10);
  arcade.tick(11_002);assert.equal(store.xp('viewer').xp,10);
  store.close();
});

test('Mystery-Drop-Texte sind einheitlich deutsch, Null-Teilnahme verspricht keine XP und Widget-Stufen sind übersetzt',()=>{
  const stages=['common','rare','epic','legendary','community'];
  const labels=['Gewöhnlicher Drop','Seltener Drop','Epischer Drop','Legendärer Drop','Community-Drop'];
  for(let i=0;i<stages.length;i++){
    const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),dropsEnabled:true,dropDurationMs:10_000});
    const announcement=arcade.startDropAdmin('broadcaster',stages[i],1_000);
    assert.equal(announcement,'🎁 Ein Mystery Drop startet! Schreibt innerhalb von 10 Sekunden !claim, um mitzumachen!');
    assert.doesNotMatch(announcement,/common|rare|epic|legendary|community/iu);
    const widget=arcade.snapshot('drop',2_000) as {drop:{rarityLabel:string}};
    assert.equal(widget.drop.rarityLabel,labels[i]);
    const overlay=communityWidgetHtml('drop','nonce',34,'graphite');
    assert.match(overlay,/d\.rarityLabel/u);
    assert.match(overlay,/Diesmal war niemand dabei/u);
    assert.doesNotMatch(overlay,/d\.rarity\.toUpperCase/u);
    const result=arcade.tick(11_001)[0]||'';
    assert.match(result,/niemand mitgemacht/u);
    assert.doesNotMatch(result,/XP/u);
    store.close();
  }
});

test('Abgelaufene Teilnehmerdetails werden gemäß Aufbewahrungsfrist bereinigt',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),dropsEnabled:true,dropDurationMs:5000,activityRetentionDays:90});
  const old=Date.now()-100*86_400_000;arcade.startDropAdmin('broadcaster','common',old);
  arcade.handle(message('viewer','old-claim','!claim'),'claim',[],old+1);
  arcade.tick(Date.now());
  const remaining=store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM mystery_claims').get() as {n:number}).n);
  assert.equal(remaining,0);store.close();
});

test('Chaos Wheel verlangt zwei Segmente und persistiert das vom Server gezogene Ergebnis',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  arcade.configureChallenge('Test A',1,true);arcade.configureChallenge('Test B',3,true);
  assert.match(arcade.spinAdmin('broadcaster',5000),/Challenge startet jetzt/u);
  const snap=arcade.snapshot('wheel',5001) as {visible:boolean;wheel:{title:string;status:string;endsAt:number}};
  assert.equal(snap.visible,true);assert.ok(arcade.manageChallenges().some(x=>x.title===snap.wheel.title));assert.equal(snap.wheel.status,'active');assert.equal(snap.wheel.endsAt,305_000);
  assert.match(arcade.spinAdmin('broadcaster',5002),/Rad-Aktion läuft bereits/u);
  assert.match(arcade.tick(305_000)[0]||'',/Erfolg nicht überprüft/u);
  assert.equal(arcade.tick(305_001).length,0,'Challenge wird nur einmal abgeschlossen');
  assert.match(arcade.spinAdmin('broadcaster',305_001),/Ergebnis:/u,'nach Ablauf des konfigurierten Cooldowns kann eine neue Challenge starten');
  store.close();
});

test('Wheel-Aktionszuordnung startet genau einen konfigurierten Mystery Drop, claims und XP laufen über den bestehenden Pfad',()=>{
  const {store,arcade}=setup(()=>1);arcade.updateSettings({...arcade.settings(),dropsEnabled:true,wheelEnabled:true,dropDurationMs:10_000,wheelCooldownMs:5_000});
  for(const challenge of arcade.manageChallenges())arcade.configureChallenge(challenge.title,challenge.weight,false,challenge.id,challenge.actionType);
  arcade.configureChallenge('Manuelle Challenge',1,true,'test-manual','manual_challenge');
  arcade.configureChallenge('Automatischer Drop',1,true,'test-drop','start_mystery_drop');
  assert.equal(arcade.manageChallenges().find(x=>x.id==='test-drop')?.actionType,'start_mystery_drop');
  const result=arcade.spinAdmin('broadcaster',1_000);
  assert.match(result,/Ein Mystery Drop startet/u);assert.match(result,/10 Sekunden/u);assert.match(result,/!claim/u);
  assert.doesNotMatch(result,/common|rare|epic|legendary/iu);
  const drops=store.miniGameQuery(db=>db.prepare("SELECT id,starts_at,ends_at,source_spin_id FROM mystery_drops WHERE status='claiming'").all() as Array<{id:string;starts_at:number;ends_at:number;source_spin_id:string}>);
  assert.equal(drops.length,1);assert.equal(drops[0]?.starts_at,1_000);assert.equal(drops[0]?.ends_at,11_000);
  const spin=store.miniGameQuery(db=>db.prepare('SELECT id,action_type FROM chaos_wheel_spins').get() as {id:string;action_type:string});
  assert.equal(spin.action_type,'start_mystery_drop');assert.equal(drops[0]?.source_spin_id,spin.id);
  const widget=arcade.snapshot('drop',2_000) as {visible:boolean;drop:{participants:number;endsAt:number;rarityLabel:string}};
  assert.equal(widget.visible,true);assert.equal(widget.drop.participants,0);assert.equal(widget.drop.endsAt,11_000);assert.equal(widget.drop.rarityLabel,'Gewöhnlicher Drop');
  assert.match(arcade.handle(message('viewer-1','drop-claim-1','!claim'),'claim',[],2_000)||'',/dabei/u);
  assert.match(arcade.handle(message('viewer-2','drop-claim-2','!claim'),'claim',[],2_001)||'',/dabei/u);
  assert.match(arcade.spinAdmin('broadcaster',2_002),/Mystery Drop läuft bereits/u,'a repeated wheel action is blocked while its drop is active');
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM mystery_drops WHERE status IN ('claiming','announced')").get() as {n:number}).n,1);
  assert.match(arcade.tick(11_001)[0]||'',/2 Personen erhalten je 5 XP/u);
  assert.equal(store.xp('viewer-1').xp,5);assert.equal(store.xp('viewer-2').xp,5);
  arcade.tick(11_002);assert.equal(store.xp('viewer-1').xp,5);assert.equal(store.xp('viewer-2').xp,5);
  store.close();
});

test('Auto-Pilot startet keine zweite Aktion während ein Drop aktiv ist',()=>{
  const {store,arcade}=setup(()=>1);arcade.updateSettings({...arcade.settings(),dropsEnabled:true,wheelEnabled:true,wheelCooldownMs:1_000});
  for(const challenge of arcade.manageChallenges())arcade.configureChallenge(challenge.title,challenge.weight,false,challenge.id,challenge.actionType);
  arcade.configureChallenge('Manuelle Challenge',1,true,'manual-1','manual_challenge');
  arcade.configureChallenge('Automatischer Drop',1,true,'drop-1','start_mystery_drop');
  arcade.startDropAdmin('broadcaster','rare',1_000);
  assert.match(arcade.spinAdmin('broadcaster',2_000),/läuft bereits/u);
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM mystery_drops WHERE status IN ('announced','claiming')").get() as {n:number}).n,1);
  store.close();
});

test('normale Glücksrad-Challenge startet keinen Drop und Default-Einträge tragen Aktions-IDs',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),dropsEnabled:true,wheelEnabled:true});
  assert.equal(arcade.manageChallenges().find(x=>x.id==='builtin:mystery-drop')?.actionType,'start_mystery_drop');
  for(const challenge of arcade.manageChallenges())arcade.configureChallenge(challenge.title,challenge.weight,false,challenge.id,challenge.actionType);
  arcade.configureChallenge('Manuell A',1,true,'manual-a','manual_challenge');arcade.configureChallenge('Manuell B',1,true,'manual-b','manual_challenge');
  assert.match(arcade.spinAdmin('broadcaster',1_000),/Jannick spielt sie selbst/u);
  assert.equal(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM mystery_drops').get() as {n:number}).n,0);
  assert.equal((store.miniGameQuery(db=>db.prepare("SELECT status FROM chaos_wheel_spins ORDER BY created_at DESC LIMIT 1").get() as {status:string})).status,'active');
  store.close();
});

test('nicht verfügbare Aktionen werden ausgeschlossen, Pet-Bonus löst genau einmal aus und Not-Stopp beendet die Challenge',()=>{
  let selection=1;const {store,arcade}=setup(()=>selection);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,petEnabled:false,dropsEnabled:false});
  for(const x of arcade.manageChallenges())arcade.configureChallenge(x.title,x.weight,false,x.id,x.actionType);
  arcade.configureChallenge('Nur Challenge',1,true,'manual-only','manual_challenge');
  arcade.configureChallenge('Pet Bonus',1,true,'pet-action','boost_pet');
  arcade.configureChallenge('Drop',1,true,'drop-action','start_mystery_drop');
  const unavailable=arcade.wheelStatus(10_000) as {entries:Array<{id:string}>;canSpin:boolean};
  assert.equal(unavailable.canSpin,false);assert.deepEqual(unavailable.entries.map(x=>x.id),['manual-only']);
  arcade.updateSettings({...arcade.settings(),petEnabled:true});
  const before=arcade.pet();assert.match(arcade.spinAdmin('broadcaster',10_000),/automatisch \+10 Energie/u);
  assert.equal(arcade.pet().energy,Math.min(100,before.energy+10));
  assert.equal(arcade.spinAdmin('broadcaster',10_001).includes('Bonus'),false,'cooldown prevents reapplying the same action');
  arcade.updateSettings({...arcade.settings(),wheelCooldownMs:1_000});
  selection=0;
  assert.match(arcade.spinAdmin('broadcaster',11_001),/Challenge startet jetzt/u);
  assert.match(arcade.emergencyStop(11_002),/Auto-Pilot gestoppt/u);
  assert.equal((arcade.wheelStatus(11_003) as {autoPilotEnabled:boolean;activeAction:unknown}).autoPilotEnabled,false);
  assert.equal((store.miniGameQuery(db=>db.prepare("SELECT status FROM chaos_wheel_spins WHERE title='Nur Challenge'").get() as {status:string})).status,'canceled');
  store.close();
});

test('laufende Community-Spielrunde blockiert den Wheel-Autopiloten ohne Zustand zu verändern',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  store.miniGameTransaction(db=>db.prepare("INSERT INTO imposter_rounds(id,phase,started_at,phase_ends_at,updated_at) VALUES('live-round','playing',100,5000,100)").run());
  assert.match(arcade.spinAdmin('broadcaster',1_000),/Community-Spiel läuft bereits/u);
  assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM chaos_wheel_spins').get() as {n:number}).n),0);
  const status=arcade.wheelStatus(1_000) as {canSpin:boolean;reason:string};assert.equal(status.canSpin,false);assert.match(status.reason,/Community-Spiel/u);
  store.close();
});

test('aktive Wheel-Challenge wird nach echtem SQLite-Neustart fortgesetzt und genau einmal abgeschlossen',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wheel-autopilot-')),database=path.join(directory,'bot.sqlite');
  let store=new FeatureStore(database),arcade=new CommunityArcade(store,'broadcaster',()=>0);
  arcade.updateSettings({...arcade.settings(),wheelEnabled:true,wheelChallengeDurationMs:2_000});
  for(const x of arcade.manageChallenges())arcade.configureChallenge(x.title,x.weight,false,x.id,x.actionType);
  arcade.configureChallenge('Restart Challenge',1,true,'restart-manual','manual_challenge');
  arcade.configureChallenge('Restart Challenge 2',1,true,'restart-manual-2','manual_challenge');
  assert.match(arcade.spinAdmin('broadcaster',10_000),/Challenge startet jetzt/u);
  store.close();
  store=new FeatureStore(database);arcade=new CommunityArcade(store,'broadcaster');
  const resumed=arcade.wheelStatus(11_000) as {activeAction:{title:string;endsAt:number}|null};
  assert.equal(resumed.activeAction?.title,'Restart Challenge');assert.equal(resumed.activeAction?.endsAt,12_000);
  assert.match(arcade.tick(12_000)[0]||'',/Erfolg nicht überprüft/u);
  assert.equal(arcade.tick(12_001).length,0);
  store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('Features sind standardmäßig aus und Pet/Admin-Befehle sind autorisiert',()=>{
  const {store,arcade}=setup();
  assert.equal(arcade.settings().petEnabled,false);
  assert.match(arcade.startDropAdmin('broadcaster','common',999),/deaktiviert/u);
  assert.match(arcade.spinAdmin('broadcaster',999),/deaktiviert/u);
  assert.match(arcade.handle(message('viewer','n1','!pet'),'pet',[],1000)||'',/deaktiviert|pausiert/u);
  arcade.updateSettings({...arcade.settings(),petEnabled:true});
  assert.match(arcade.handle(message('viewer','n2','!setpetname Evil'),'setpetname',['Evil'],1000)||'',/Nur Jannik/u);
  assert.match(arcade.handle(message('broadcaster','n3','!setpetname Glut'),'setpetname',['Glut'],1001)||'',/heißt jetzt Glut/u);
  store.close();
});
