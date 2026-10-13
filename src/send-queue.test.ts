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
  const regular = queue.enqueue('normale Info');
  const duplicate = queue.enqueue('normale Info');
  const important = queue.enqueue('Der Mystery Drop startet!');
  assert.equal(queue.snapshot().suppressed, 1);
  release?.();
  await Promise.all([first, regular, duplicate, important]);
  assert.deepEqual(sent, ['【🤖 COMMUNITY】 blocker', '【🤖 COMMUNITY】 Der Mystery Drop startet!', '【🤖 COMMUNITY】 normale Info']);
});
