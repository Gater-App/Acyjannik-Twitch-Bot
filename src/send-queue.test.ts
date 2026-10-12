import assert from 'node:assert/strict';
import test from 'node:test';
import { SendQueue } from './send-queue.js';

test('Sendewarteschlange sendet seriell und hält Antworten in Reihenfolge', async () => {
  const sent: string[] = [];
  const queue = new SendQueue(async (message) => { sent.push(message); }, 0);
  await Promise.all([queue.enqueue('eins'), queue.enqueue('zwei'), queue.enqueue('drei')]);
  assert.deepEqual(sent, ['eins', 'zwei', 'drei']);
});
