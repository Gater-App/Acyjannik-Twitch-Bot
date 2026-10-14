import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BotLifecycle, BOT_RESTART_COOLDOWN_MS } from './bot-lifecycle.js';
import { FeatureStore } from './feature-store.js';

function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bot-lifecycle-'));const store=new FeatureStore(path.join(dir,'data','bot.sqlite'));const lifecycle=new BotLifecycle(store);return{dir,store,lifecycle,close(){store.close();fs.rmSync(dir,{recursive:true,force:true})}};}

test('Lebenszeichen sind standardmäßig aus und ungeplanter Start verwirft einen bloß vorbereiteten Marker',()=>{
  const f=fixture();assert.equal(f.lifecycle.settings().enabled,false);assert.equal(f.lifecycle.beginShutdown(10,false),undefined,'gewöhnliche SIGINT/SIGTERM ohne Marker erzeugt keinen Abschied');f.lifecycle.setEnabled(true);
  const prepared=f.lifecycle.prepare(100_000);assert.equal(prepared.ok,true);
  assert.equal(f.lifecycle.takeReturnCandidate(101_000),undefined);
  assert.equal(f.lifecycle.marker()?.phase,'cancelled');f.close();
});

test('Live-Update sendet Abschied höchstens einmal und gibt genau einen Rückkehrversuch frei',()=>{
  const f=fixture();f.lifecycle.setEnabled(true);const prepared=f.lifecycle.prepare(1_000);assert.equal(prepared.ok,true);
  const marker=f.lifecycle.beginShutdown(2_000,true)!;assert.equal(marker.farewellStatus,'pending');
  f.lifecycle.finishFarewell(marker.id,'sent');f.lifecycle.completeShutdown(marker.id);
  const candidate=f.lifecycle.takeReturnCandidate(3_000);assert.equal(candidate?.id,marker.id);assert.equal(candidate?.phase,'returning');
  assert.equal(f.lifecycle.takeReturnCandidate(3_500),undefined,'zweiter Start oder EventSub-Reconnect sendet keine zweite Rückkehrnachricht');
  f.lifecycle.finishWelcome(marker.id,'sent');assert.equal(f.lifecycle.marker()?.welcomeStatus,'sent');
  f.close();
});

test('Offline, fehlender Chatversand, abgebrochener Shutdown und Cooldown bleiben sicher',()=>{
  const f=fixture();f.lifecycle.setEnabled(true);const first=f.lifecycle.prepare(1_000);assert.equal(first.ok,true);
  const offline=f.lifecycle.beginShutdown(2_000,false)!;assert.equal(offline.farewellStatus,'skipped');f.lifecycle.completeShutdown(offline.id);
  assert.equal(f.lifecycle.takeReturnCandidate(3_000),undefined,'offline vorbereiteter Neustart erzeugt später keine Begrüßung');
  assert.equal(f.lifecycle.prepare(1_000+BOT_RESTART_COOLDOWN_MS-1).ok,false);
  const second=f.lifecycle.prepare(1_000+BOT_RESTART_COOLDOWN_MS);assert.equal(second.ok,true);
  const live=f.lifecycle.beginShutdown(1_000+BOT_RESTART_COOLDOWN_MS+1,true)!;
  f.lifecycle.finishFarewell(live.id,'failed');f.lifecycle.completeShutdown(live.id);
  assert.equal(new BotLifecycle(f.store).takeReturnCandidate(1_000+BOT_RESTART_COOLDOWN_MS+2)?.id,live.id,'fehlgeschlagener Abschied blockiert den Neustart nicht');
  f.close();
});

test('Abgelaufene Marker und ein Prozessabsturz beim Rückkehrversuch werden nicht wiederholt',()=>{
  const f=fixture();f.lifecycle.setEnabled(true);const prepared=f.lifecycle.prepare(100_000);assert.equal(prepared.ok,true);
  const live=f.lifecycle.beginShutdown(101_000,true)!;f.lifecycle.finishFarewell(live.id,'sent');f.lifecycle.completeShutdown(live.id);
  const returning=f.lifecycle.takeReturnCandidate(102_000)!;assert.equal(returning.phase,'returning');
  const restarted=new BotLifecycle(f.store);assert.equal(restarted.takeReturnCandidate(103_000),undefined);
  assert.equal(restarted.marker()?.welcomeStatus,'failed');f.close();
});

test('Gleichzeitige Prozessstarts erhalten nur einen Rückkehr-Anspruch und laufende Spiele bleiben unverändert',()=>{
  const f=fixture();f.store.setState('guess',{status:'active',target:37},100_000);
  f.lifecycle.setEnabled(true);const prepared=f.lifecycle.prepare(100_000);assert.equal(prepared.ok,true);
  const marker=f.lifecycle.beginShutdown(101_000,true)!;f.lifecycle.finishFarewell(marker.id,'sent');f.lifecycle.completeShutdown(marker.id);
  const first=new BotLifecycle(f.store).takeReturnCandidate(102_000);
  const secondStore=new FeatureStore(path.join(f.dir,'data','bot.sqlite'));
  const second=new BotLifecycle(secondStore).takeReturnCandidate(102_000);secondStore.close();
  assert.equal(Boolean(first),true);assert.equal(second,undefined,'atomare SQLite-Übernahme schützt vor zwei Prozessstarts');
  assert.deepEqual(f.store.state('guess',null),{status:'active',target:37},'Neustartstatus verändert keine laufende Spielrunde');
  f.close();
});

test('Deaktivieren während der Stabilisierungsphase unterdrückt die Rückkehrnachricht',()=>{
  const f=fixture();f.lifecycle.setEnabled(true);const prepared=f.lifecycle.prepare(1_000);assert.equal(prepared.ok,true);
  const marker=f.lifecycle.beginShutdown(1_001,true)!;f.lifecycle.finishFarewell(marker.id,'sent');f.lifecycle.completeShutdown(marker.id);
  assert.equal(f.lifecycle.takeReturnCandidate(1_002)?.phase,'returning');
  f.lifecycle.setEnabled(false);
  f.lifecycle.finishWelcome(marker.id,'sent');
  assert.equal(f.lifecycle.marker()?.phase,'cancelled');assert.equal(f.lifecycle.marker()?.welcomeStatus,'skipped');
  f.close();
});
