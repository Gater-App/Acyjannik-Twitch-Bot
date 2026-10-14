import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutomaticChatMessages } from './automatic-chat-messages.js';
import { FeatureStore } from './feature-store.js';

function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'automatic-chat-'));const file=path.join(dir,'data','bot.sqlite');const store=new FeatureStore(file);return {dir,file,store,service:new AutomaticChatMessages(store),close(){store.close();fs.rmSync(dir,{recursive:true,force:true})}};}

test('automatic messages create, edit, pause, resume, delete and survive store restart',()=>{
  const f=fixture();const created=f.service.save({title:'Discord',message:'Kommt zu uns auf Discord!',intervalMinutes:30,activeChatOnly:false},1000);
  assert.equal(created.enabled,true);assert.equal(created.intervalMinutes,30);assert.equal(f.service.list(1000).length,1);
  const edited=f.service.save({id:created.id,title:'Discord Community',message:'Wir freuen uns auf euch!',intervalMinutes:45,enabled:true,activeChatOnly:true},2000);
  assert.equal(edited.title,'Discord Community');assert.equal(edited.intervalMinutes,45);assert.equal(edited.activeChatOnly,true);
  assert.equal(f.service.setEnabled(created.id,false,3000),true);assert.equal(f.service.list(3000)[0]?.enabled,false);
  f.store.close();const store=new FeatureStore(f.file),service=new AutomaticChatMessages(store);assert.equal(service.list(3000)[0]?.message,'Wir freuen uns auf euch!');
  assert.equal(service.setEnabled(created.id,true,4000),true);assert.equal(service.delete(created.id),true);store.close();fs.rmSync(f.dir,{recursive:true,force:true});
});

test('scheduled messages require due interval, activity when selected, and idle game/chat state',()=>{
  const f=fixture();const row=f.service.save({title:'Tipp',message:'Schreibt !help für Befehle.',intervalMinutes:30,activeChatOnly:true},1000);
  assert.equal(f.service.nextDue(1000+30*60_000-1,20,false,true),undefined);
  assert.equal(f.service.nextDue(1000+30*60_000,20,false,false),undefined,'offline wird nie gesendet');
  assert.equal(f.service.nextDue(1000+30*60_000,20,false,undefined),undefined,'unbekannter Live-Status wird sicher unterdrückt');
  assert.equal(f.service.nextDue(1000+30*60_000,20,false,true)?.id,row.id);
  assert.equal(f.service.nextDue(1000,5,false,true),undefined);assert.equal(f.service.nextDue(1000,20,true,true),undefined);
  const attemptedAt=1000+30*60_000;assert.equal(f.service.reserveMessageAttempt(row.id,attemptedAt),true);assert.equal(f.service.reserveMessageAttempt(row.id,attemptedAt),false,'derselbe geplante Versand wird nicht doppelt reserviert');assert.equal(f.service.nextDue(1000+60*60_000-1,20,false,true),undefined);
  assert.equal(f.service.nextDue(1000+60*60_000,20,false,true)?.id,row.id);
  f.service.markFailed(row.id,attemptedAt+1);assert.equal(f.service.list(attemptedAt+2)[0]?.lastErrorAt,attemptedAt+1);assert.equal(f.service.list(attemptedAt+2)[0]?.nextEarliestAt,1000+60*60_000);
  f.store.close();const restartedStore=new FeatureStore(f.file),restarted=new AutomaticChatMessages(restartedStore);
  assert.equal(restarted.nextDue(attemptedAt,20,false,true),undefined,'Sendeversuch und Wiederholungsabstand bleiben nach Neustart erhalten');
  restartedStore.close();fs.rmSync(f.dir,{recursive:true,force:true});
});

test('shared automatic-message spacing survives restart and limits the hourly burst',()=>{
  const f=fixture();const row=f.service.save({title:'Info',message:'Eine Nachricht.',intervalMinutes:15},1000);
  const firstDue=1000+15*60_000;assert.equal(f.service.reserveMessageAttempt(row.id,firstDue),true);
  assert.equal(f.service.canReserveGlobalSlot(firstDue+AUTO_GAP-1),false);
  assert.equal(f.service.reserveGlobalSlot(firstDue+AUTO_GAP),true);
  assert.equal(f.service.canReserveGlobalSlot(firstDue+AUTO_GAP+1),false);
  f.store.close();const restartedStore=new FeatureStore(f.file),restarted=new AutomaticChatMessages(restartedStore);
  assert.equal(restarted.canReserveGlobalSlot(firstDue+AUTO_GAP+1),false,'gemeinsamer Mindestabstand bleibt nach Neustart erhalten');
  for(let i=1;i<3;i++)assert.equal(restarted.reserveGlobalSlot(firstDue+(i+1)*AUTO_GAP),true);
  assert.equal(restarted.canReserveGlobalSlot(firstDue+4*AUTO_GAP),false,'höchstens vier automatische Nachrichten pro Stunde');
  restartedStore.close();fs.rmSync(f.dir,{recursive:true,force:true});
});

test('parallel scheduled senders can reserve only one shared chat slot',async()=>{
  const f=fixture();
  const reservations=await Promise.all(Array.from({length:12},(_,index)=>Promise.resolve().then(()=>f.service.reserveGlobalSlot(100_000+index))));
  assert.equal(reservations.filter(Boolean).length,1,'ein gemeinsamer SQLite-Guard verhindert parallele doppelte automatische Nachrichten');
  f.close();
});

test('Status zeigt den gemeinsamen Abstand und das Stundenlimit an',()=>{
  const f=fixture(),now=100_000;
  assert.equal(f.service.globalStatus(now).canSend,true);
  for(let i=0;i<4;i++)assert.equal(f.service.reserveGlobalSlot(now+i*AUTO_GAP),true);
  const status=f.service.globalStatus(now+4*AUTO_GAP);
  assert.equal(status.sentThisHour,4);assert.equal(status.hourlyLimit,4);assert.equal(status.canSend,false);
  assert.equal(status.nextEarliestAt,now+4*AUTO_GAP);
  f.close();
});

test('existing community-tip cooldown is folded into the shared plan',()=>{
  const f=fixture();f.store.setConfig('community_tip_state',{lastSentAt:5_000,streamId:'stream',sentInStream:['xp'],sentHistory:[5_000]});
  const shared=new AutomaticChatMessages(f.store);
  assert.equal(shared.canReserveGlobalSlot(5_000+AUTO_GAP-1),false);
  assert.equal(shared.canReserveGlobalSlot(5_000+AUTO_GAP),true);
  f.close();
});

test('custom interval and message bounds, control characters, and duplicate prefix are safe',()=>{
  const f=fixture();
  assert.throws(()=>f.service.save({title:'T',message:'Text',intervalMinutes:14}));
  assert.throws(()=>f.service.save({title:'T',message:'x'.repeat(500),intervalMinutes:30}));
  const row=f.service.save({title:'T',message:'【📢 INFO】 Hallo\nChat\u0000!',intervalMinutes:60},1000);
  assert.equal(row.message,'【📢 INFO】 Hallo Chat !');
  f.close();
});

const AUTO_GAP=5*60_000;
