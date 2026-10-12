import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';

test('Testkonfiguration hat nutzbare Default-Punktespannen', () => {
  const config = loadConfig({ testMode: true });
  assert.deepEqual(config.gameValues.treat, { min: 5, max: 20 });
  assert.deepEqual(config.gameValues.trick, { min: 1, max: 10 });
  assert.equal(config.maxChatMessageLength, 500);
});
