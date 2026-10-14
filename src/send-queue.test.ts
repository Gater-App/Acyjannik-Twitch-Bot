import assert from 'node:assert/strict';
import test from 'node:test';
import { SendQueue } from './send-queue.js';

test('Sendewarteschlange sendet seriell und hält Antworten in Reihenfolge', async () => {
  const sent: string[] = [];
  const queue = new SendQueue(async (message) => { sent.push(message); }, 0);
  await Promise.all([queue.enqueue('eins'), queue.enqueue('zwei'), queue.enqueue('drei')]);
  assert.deepEqual(sent, ['【🤖 COMMUNITY】 eins', '【🤖 COMMUNITY】 zwei', '【🤖 COMMUNITY】 drei']);
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
  const regular = queue.enqueue('Imposter-Teilnahme gespeichert.');
  const duplicate = queue.enqueue('Imposter-Teilnahme gespeichert.');
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
  assert.equal(queue.size, 0, 'die laufende Nachricht ist nicht mehr in der Warteschlange');
  assert.equal(queue.busy, true, 'laufender Versand muss andere Automatik zurückhalten');
  release?.();
  await sending;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queue.busy, false);
});
