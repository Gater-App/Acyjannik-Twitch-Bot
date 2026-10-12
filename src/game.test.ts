import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from './database.js';
import { chooseEvent, GameService, resolveOutcome } from './game.js';
import { testConfig } from './test-config.js';

test('Ereignisauswahl verwendet deterministische Gewichtungsgrenzen', () => {
  const config = testConfig({ eventWeights: { TREAT: 1, TRICK: 1, JACKPOT: 0, GHOST: 0, WITCH: 0, EMPTY_HOUSE: 0, GOLDEN_PUMPKIN: 0 } });
  assert.equal(chooseEvent(config.eventWeights, () => 0), 'TREAT');
  assert.equal(chooseEvent(config.eventWeights, () => 0.5), 'TRICK');
});

test('Punktespannen und negative Werte werden korrekt aufgelöst', () => {
  const config = testConfig({
    eventWeights: { TREAT: 0, TRICK: 0, JACKPOT: 0, GHOST: 0, WITCH: 0, EMPTY_HOUSE: 0, GOLDEN_PUMPKIN: 1 },
    gameValues: { ...testConfig().gameValues, goldenPumpkin: { min: 50, max: 50 } },
  });
  assert.deepEqual(resolveOutcome('GOLDEN_PUMPKIN', config, () => 0), { event: 'GOLDEN_PUMPKIN', delta: 50 });
  assert.equal(resolveOutcome('TRICK', testConfig(), () => 0).delta, -1);
});

test('Cooldown und nicht-negative Punktestände sind persistent wirksam', () => {
  const config = testConfig({
    eventWeights: { TREAT: 0, TRICK: 1, JACKPOT: 0, GHOST: 0, WITCH: 0, EMPTY_HOUSE: 0, GOLDEN_PUMPKIN: 0 },
    gameValues: { ...testConfig().gameValues, trick: { min: 10, max: 10 } },
  });
  const database = new Database(':memory:', true);
  const game = new GameService(database, config, () => 0);
  const first = game.play('viewer-1', 'Viewer', 1_000);
  assert.equal(first.ok, true);
  assert.equal(game.pumpkins('viewer-1'), 0);
  const second = game.play('viewer-1', 'Viewer', 1_001);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'cooldown');
  database.close();
});

test('Start und Ende liefern den Gewinner', () => {
  const database = new Database(':memory:', false);
  const config = testConfig({ activeOnStart: false });
  const game = new GameService(database, config, () => 0);
  assert.equal(game.start(1), true);
  assert.equal(game.start(2), false);
  game.play('a', 'Alice', 3);
  const ended = game.end(4);
  assert.equal(ended.ended, true);
  assert.equal(ended.winner?.displayName, 'Alice');
  assert.equal(game.active, false);
  database.close();
});
