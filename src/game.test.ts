import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from './database.js';
import { chooseEvent, chooseEventFromRoll, GameService, resolveOutcome } from './game.js';
import { testConfig } from './test-config.js';

test('Ereignisauswahl verwendet deterministische Gewichtungsgrenzen', () => {
  const config = testConfig({ eventWeights: { TREAT: 1, TRICK: 1, JACKPOT: 0, GHOST: 0, WITCH: 0, EMPTY_HOUSE: 0, GOLDEN_PUMPKIN: 0 } });
  assert.equal(chooseEvent(config.eventWeights, () => 0), 'TREAT');
  assert.equal(chooseEvent(config.eventWeights, () => 0.5), 'TRICK');
});

test('100.000 reproduzierbare Ziehungen folgen den Standardgewichten ohne nutzerabhängige Auswahl', () => {
  const config = testConfig({eventWeights:{TREAT:48,TRICK:25,JACKPOT:5,GHOST:8,WITCH:8,EMPTY_HOUSE:5,GOLDEN_PUMPKIN:1}});
  const keys = ['TREAT', 'TRICK', 'JACKPOT', 'GHOST', 'WITCH', 'EMPTY_HOUSE', 'GOLDEN_PUMPKIN'] as const;
  let state = 0x6d2b79f5;
  const seeded = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const counts = Object.fromEntries(keys.map(key => [key, 0])) as Record<typeof keys[number], number>;
  const userCounts = new Map<string, Record<typeof keys[number], number>>();
  for (let i = 0; i < 100_000; i++) {
    const roll = Math.floor(seeded()*100);
    const event = chooseEventFromRoll(config.eventWeights, roll);
    counts[event]++;
    const user = i % 4 === 0 ? 'viewer-a' : i % 4 === 1 ? 'viewer-b' : i % 4 === 2 ? 'viewer-c' : 'viewer-d';
    const perUser = userCounts.get(user) || Object.fromEntries(keys.map(key => [key, 0])) as Record<typeof keys[number], number>;
    perUser[event]++; userCounts.set(user, perUser);
  }
  const expected = { TREAT: 48_000, TRICK: 25_000, JACKPOT: 5_000, GHOST: 8_000, WITCH: 8_000, EMPTY_HOUSE: 5_000, GOLDEN_PUMPKIN: 1_000 };
  for (const key of keys) assert.ok(Math.abs(counts[key] - expected[key]) < 6 * Math.sqrt(expected[key]) + 3, `${key}: ${counts[key]} gegenüber ${expected[key]}`);
  for (const perUser of userCounts.values()) for (const key of keys) {
    const target = expected[key] / 4;
    assert.ok(Math.abs(perUser[key] - target) < 6 * Math.sqrt(target) + 3, `${key}: Nutzergruppe weicht statistisch auffällig ab`);
  }
  const positive = counts.TREAT + counts.JACKPOT + counts.WITCH + counts.GOLDEN_PUMPKIN;
  const negative = counts.TRICK + counts.GHOST;
  const neutral = counts.EMPTY_HOUSE;
  assert.ok(Math.abs(positive - 62_000) < 6 * Math.sqrt(62_000) + 3);
  assert.ok(Math.abs(negative - 33_000) < 6 * Math.sqrt(33_000) + 3);
  assert.ok(Math.abs(neutral - 5_000) < 6 * Math.sqrt(5_000) + 3);
});

test('Gewichtssummen und Zufallswerte mit ungültigen Grenzen werden abgewiesen', () => {
  const config = testConfig();
  assert.throws(() => chooseEvent({ ...config.eventWeights, TREAT: 0.5 }, () => 0));
  assert.throws(() => chooseEvent({ ...config.eventWeights, TREAT: Number.MAX_SAFE_INTEGER, TRICK: 1 }, () => 0));
  assert.throws(() => chooseEvent(config.eventWeights, () => Number.NaN));
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

test('Produktiver Standardpfad verwendet sichere Auswahl und lässt Nutzer-ID nicht in die Ziehung einfließen',()=>{
  const config=testConfig({eventWeights:{TREAT:0,TRICK:1,JACKPOT:0,GHOST:0,WITCH:0,EMPTY_HOUSE:0,GOLDEN_PUMPKIN:0},gameValues:{...testConfig().gameValues,trick:{min:2,max:2}}});
  const database=new Database(':memory:',true),game=new GameService(database,config);const a=game.play('viewer-a','A',1_000),b=game.play('viewer-b','B',1_000);
  assert.equal(a.ok,true);assert.equal(b.ok,true);if(a.ok&&b.ok){assert.deepEqual(a.outcome,{event:'TRICK',delta:-2,pumpkins:0});assert.deepEqual(b.outcome,{event:'TRICK',delta:-2,pumpkins:0});}
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
