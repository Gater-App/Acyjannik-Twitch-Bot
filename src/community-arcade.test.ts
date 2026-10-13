import test from 'node:test';
import assert from 'node:assert/strict';
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
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  arcade.configureChallenge('Test A',1,true);arcade.configureChallenge('Test B',3,true);
  assert.match(arcade.spinAdmin('broadcaster',5000),/landet auf/u);
  const snap=arcade.snapshot('wheel',5001) as {visible:boolean;wheel:{title:string;status:string}};
  assert.equal(snap.visible,true);assert.ok(arcade.manageChallenges().some(x=>x.title===snap.wheel.title));assert.equal(snap.wheel.status,'completed');
  assert.match(arcade.spinAdmin('broadcaster',5002),/kurze Pause/u);
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
  assert.match(arcade.spinAdmin('broadcaster',2_002),/kurze Pause/u,'a repeated wheel action is blocked by its cooldown');
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM mystery_drops WHERE status IN ('claiming','announced')").get() as {n:number}).n,1);
  assert.match(arcade.tick(11_001)[0]||'',/2 Personen erhalten je 5 XP/u);
  assert.equal(store.xp('viewer-1').xp,5);assert.equal(store.xp('viewer-2').xp,5);
  arcade.tick(11_002);assert.equal(store.xp('viewer-1').xp,5);assert.equal(store.xp('viewer-2').xp,5);
  store.close();
});

test('automatischer Wheel-Drop erstellt keinen zweiten Drop; manuelle Challenge bleibt nur eine Aufgabe',()=>{
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
  assert.match(arcade.spinAdmin('broadcaster',1_000),/Jannik entscheidet/u);
  assert.equal(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM mystery_drops').get() as {n:number}).n,0);
  store.close();
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
