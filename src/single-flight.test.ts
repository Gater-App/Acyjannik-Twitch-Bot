import assert from 'node:assert/strict';
import test from 'node:test';
import { singleFlight } from './single-flight.js';

test('single-flight skips overlapping ticks and recovers after a failed pass', async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const errors: unknown[] = [];
  const run = singleFlight(async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
    else if (calls === 2) throw new Error('temporary failure');
  }, error => errors.push(error));

  assert.equal(run(), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(run(), false);
  assert.equal(calls, 1);
  release?.();
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(run(), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.equal(run(), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
});
