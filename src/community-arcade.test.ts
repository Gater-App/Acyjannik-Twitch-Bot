import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureStore } from './feature-store.js';
import { CommunityArcade } from './community-arcade.js';
import type { ChatMessage } from './types.js';

function setup(){const store=new FeatureStore(':memory:');const arcade=new CommunityArcade(store,'broadcaster');return {store,arcade};}
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
  assert.match(arcade.startDropAdmin('broadcaster','rare',1000),/MYSTERY DROP/u);
  assert.match(arcade.handle(message('viewer','c1','!claim'),'claim',[],2000)||'',/dabei/u);
  assert.match(arcade.handle(message('viewer','c2','!claim'),'claim',[],3000)||'',/bereits/u);
  assert.match(arcade.tick(11_001)[0]||'',/1 Teilnehmende/u);
  assert.equal(store.xp('viewer').xp,10);
  arcade.tick(11_002);assert.equal(store.xp('viewer').xp,10);
  store.close();
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
