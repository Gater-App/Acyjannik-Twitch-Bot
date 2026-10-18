import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { ModeratorPranks } from './moderator-pranks.js';
import type { ChatMessage } from './types.js';

const msg=(userId='viewer-1',display='Viewer'):ChatMessage=>({eventId:`e-${userId}`,messageId:`m-${userId}`,broadcasterUserId:'channel',senderUserId:userId,senderLogin:userId,senderDisplayName:display,message:'!orakel Was bringt der Tag?',sentAt:1,isModerator:false});

test('Pranks erlauben höchstens eine Phase, Cooldowns greifen, Ende und Neustart bleiben sicher',()=>{
  const store=new FeatureStore(':memory:');let busy=false;const p=new ModeratorPranks(store,()=>false,()=>busy);
  p.configure({enabled:{chief:true,accusation:true,'vault-alarm':true,oracle:true}});
  const chief=p.start('chief','mod',1_000);assert.equal(chief.ok,true);assert.ok(chief.announcement===undefined,'Chatankündigung ist standardmäßig aus');
  assert.equal((p.snapshot(1_000).lastActions as Record<string,number>).chief,1_000,'Dashboard kann den letzten Start nachvollziehbar anzeigen');
  assert.equal(p.start('oracle','mod',1_001).ok,false,'keine parallelen Pranks');
  assert.equal(p.snapshot(61_001).active,null,'abgelaufene Phase wird beim Status sicher ausgeblendet');
  p.tick(61_001);assert.equal(p.snapshot(61_001).active,null);
  assert.equal(p.start('chief','mod',62_000).ok,false,'Startcooldown bleibt nach Ablauf wirksam');
  busy=true;assert.equal(p.start('oracle','mod',1_000_000).ok,false,'laufendes Community-Spiel blockiert große Pranks');
  p.configure({enabled:{...p.settings().enabled,chief:false}});assert.equal(p.start('chief','mod',1_000_000).ok,false);
  store.close();
});

test('parallele Dashboard-Starts erzeugen höchstens eine aktive Prankphase',async()=>{
  const store=new FeatureStore(':memory:'),p=new ModeratorPranks(store,()=>false,()=>false);p.configure({enabled:{chief:true,oracle:true}});
  const results=await Promise.all(Array.from({length:12},(_,i)=>Promise.resolve().then(()=>p.start(i%2?'chief':'oracle','mod-'+i,50_000+i))));
  assert.equal(results.filter(result=>result.ok).length,1);assert.ok(p.snapshot(50_100).active);store.close();
});

test('Aktive Prankphase überlebt Store-Neustart, läuft nach ihrer Frist aber automatisch aus',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-pranks-restart-')),file=path.join(directory,'features.sqlite'),now=Date.now();
  let store=new FeatureStore(file),first=new ModeratorPranks(store,()=>false,()=>false);first.configure({enabled:{chief:true}});
  assert.equal(first.start('chief','mod',now).ok,true);store.close();
  store=new FeatureStore(file);const restored=new ModeratorPranks(store,()=>false,()=>false);assert.equal((restored.snapshot(now).active as {kind:string}).kind,'chief');
  restored.tick(now+60_001);assert.equal(restored.snapshot(now+60_001).active,null);store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('Tresor-Fehlalarm benötigt echte laufende Runde; Orakel begrenzt Antwortspam',()=>{
  const store=new FeatureStore(':memory:');let vault=false;const p=new ModeratorPranks(store,()=>vault,()=>false);
  assert.equal(p.start('vault-alarm','mod',100).ok,false);
  p.configure({enabled:{chief:true,accusation:true,'vault-alarm':true,oracle:true}});vault=true;const alarm=p.start('vault-alarm','mod',100);assert.equal(alarm.ok,true);assert.equal(p.start('oracle','mod',101).ok,false);
  p.end(102);const oracle=p.start('oracle','mod',1_000_000);assert.equal(oracle.ok,true);
  const answer=p.handle(msg('a'), 'orakel',['Was','bringt','der','Tag'],1_000_001);assert.match(answer||'',/【🔮 ORAKEL】/u);
  assert.equal(p.handle(msg('a'), 'orakel',['Was','bringt','der','Tag'],1_000_002),undefined,'Nutzer-Cooldown unterdrückt Antwort');
  for(let i=0;i<5;i++)p.handle(msg(`user-${i}`),'orakel',['Was','bringt','der','Tag'],1_000_010+i);
  assert.equal(p.handle(msg('six'),'orakel',['Was','bringt','der','Tag'],1_000_020),undefined,'globaler Antwortdeckel greift');
  store.close();
});

test('Tresor-Fehlalarm darf die dafür erforderliche Tresorrunde nicht selbst als Konflikt behandeln',()=>{
  const store=new FeatureStore(':memory:');let vault=true;const ignoredVault:boolean[]=[];
  const p=new ModeratorPranks(store,()=>vault,(ignoreRequiredVault=false)=>{ignoredVault.push(ignoreRequiredVault);return false});
  p.configure({enabled:{chief:true,accusation:true,'vault-alarm':true,oracle:true}});
  assert.equal(p.start('vault-alarm','mod',100).ok,true);
  assert.deepEqual(ignoredVault,[true]);
  store.close();
});

test('Ziel kann Pranks dauerhaft abwählen; Verteidigung vergibt und verändert keine Punkte',()=>{
  const store=new FeatureStore(':memory:');const p=new ModeratorPranks(store,()=>false,()=>false);
  p.configure({enabled:{chief:true,accusation:true,'vault-alarm':true,oracle:true}});
  p.handle({...msg('1234'),message:'!prankoptout'},'prankoptout',[],100);
  assert.equal(p.isOptedOut('1234'),true);
  assert.equal(p.start('accusation','mod',1_000,{id:'1234',name:'Target'}).ok,false);
  p.handle({...msg('1234'),message:'!prankoptin'},'prankoptin',[],2_000);
  assert.equal(p.start('accusation','mod',1_000_000,{id:'1234',name:'Target'}).ok,true);
  const defense=p.handle(msg('1234','Target'),'unschuldig',[],1_000_001);assert.match(defense||'',/unschuldig|Freispruch|Fall geschlossen/u);
  assert.equal(p.snapshot(1_000_002).active,null);
  assert.equal(p.start('accusation','mod',2_000_000,{id:'1234',name:'Target'}).ok,false,'eine Zielperson wird höchstens einmal pro Tag ausgewählt');
  const afterCooldown=1_000_000+30*60_000+1;
  assert.equal(p.start('accusation','mod',afterCooldown,{id:'5678',name:'Target2'}).ok,true);
  p.handle({...msg('5678'),message:'!prankoptout'},'prankoptout',[],afterCooldown+1);
  assert.equal(p.snapshot(afterCooldown+2).active,null,'Opt-out beendet auch eine gerade laufende Verdächtigung');
  assert.equal(store.xp('1234').xp,0);
  store.close();
});
