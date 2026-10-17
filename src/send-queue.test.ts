import assert from 'node:assert/strict';
import test from 'node:test';
import { SendQueue } from './send-queue.js';

test('Sendewarteschlange sendet seriell und hält Antworten in Reihenfolge', async () => {
  const sent: string[] = [];
  const queue = new SendQueue(async (message) => { sent.push(message); }, 0);
  await Promise.all([queue.enqueue('eins'), queue.enqueue('zwei'), queue.enqueue('drei')]);
  assert.deepEqual(sent, ['【🤖 COMMUNITY】 eins', '【🤖 COMMUNITY】 zwei', '【🤖 COMMUNITY】 drei']);
});

test('Sendewarteschlange dedupliziert dieselbe Event-ID, aber nicht gleiche Texte verschiedener Nutzer', async () => {
  let release: (() => void) | undefined;
  const queue = new SendQueue(async message => { if(message.includes('blocker')) await new Promise<void>(resolve=>{release=resolve;}); }, 0);
  const blocker = queue.enqueue('blocker');
  await new Promise(resolve=>setTimeout(resolve,0));
  const first = queue.enqueue('gleicher Hinweis',undefined,'community',{id:'same-user-event'});
  const duplicate = queue.enqueue('gleicher Hinweis',undefined,'community',{id:'same-user-event'});
  const otherUser = queue.enqueue('gleicher Hinweis',undefined,'community',{id:'other-user-event'});
  assert.equal(await duplicate, false);
  release?.();
  await blocker;
  assert.equal(await first, true);
  assert.equal(await otherUser,true);
});

test('parallele individuelle Community-Antworten bleiben getrennt und werden zugestellt',async()=>{
  const delivered:string[]=[];const queue=new SendQueue(async message=>{delivered.push(message)},0);
  const results=await Promise.all(Array.from({length:10},(_,index)=>queue.enqueue(`Viewer${index} findet ${index+1} Kürbisse.`,undefined,'season',{id:`event-${index}`})));
  assert.equal(results.filter(Boolean).length,10);
  assert.equal(delivered.length,10);
  for(let index=0;index<10;index++)assert.ok(delivered.some(message=>message.includes(`Viewer${index} findet ${index+1} Kürbisse`)),`Viewer ${index} erhält die korrekte eigene Ausgabe`);
});

test('Sendewarteschlange begrenzt Duplikate, zeigt Zähler und priorisiert wichtige Ankündigungen', async () => {
  const sent: string[] = [];
  let release: (() => void) | undefined;
  const queue = new SendQueue(async message => {
    if (message.includes('blocker')) await new Promise<void>(resolve => { release = resolve; });
    sent.push(message);
  }, 0, undefined, 500, 2);
  const first = queue.enqueue('blocker');
  await new Promise(resolve => setTimeout(resolve, 0));
  const regular = queue.enqueue('Imposter-Teilnahme gespeichert.',undefined,'community',{id:'participant-a'});
  const duplicate = queue.enqueue('Imposter-Teilnahme gespeichert.',undefined,'community',{id:'participant-a'});
  const important = queue.enqueue('Der Mystery Drop startet!');
  assert.equal(queue.snapshot().suppressed, 1);
  release?.();
  await Promise.all([first, regular, duplicate, important]);
  assert.deepEqual(sent, ['【🤖 COMMUNITY】 blocker', '【🤖 COMMUNITY】 Der Mystery Drop startet!', '【🤖 COMMUNITY】 Imposter-Teilnahme gespeichert.']);
});

test('Sendewarteschlange bleibt als beschäftigt markiert, solange Twitch den Versand verarbeitet', async () => {
  let release: (() => void) | undefined;
  const queue = new SendQueue(async () => new Promise<void>(resolve => { release = resolve; }), 0);
  const sending = queue.enqueue('wichtige Meldung');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(queue.size, 1, 'laufender Versand wird in der Gesamtzahl mitgezählt');
  assert.equal(queue.busy, true, 'laufender Versand muss andere Automatik zurückhalten');
  release?.();
  await sending;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queue.busy, false);
});

test('Sendewarteschlange zählt bestätigten Versand, Rate-Limits, Fehler und Verzögerung', async () => {
  let calls=0;
  const queue=new SendQueue(async()=>{calls++;if(calls===1)return {accepted:true,rateLimitedRetries:2};throw new Error('safe transport failure')},0);
  assert.equal(await queue.enqueue('Treffer bestätigt.','', 'attack',{id:'accepted'}),true);
  await assert.rejects(queue.enqueue('Antwort fehlgeschlagen.','', 'community',{id:'failed'}));
  const status=queue.snapshot();
  assert.equal(status.sent,1);assert.equal(status.rateLimited,2);assert.equal(status.failed,1);assert.equal(status.sending,false);
  assert.equal(status.averageDelayMs>=0,true);assert.match(status.lastError||'',/safe transport failure/u);
});
