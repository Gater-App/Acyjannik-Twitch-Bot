import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsciiArtStore } from './ascii-art.js';

test('UTF-8-Art erhält führende Leerzeichen und Unicode-Zeichen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-art-'));
  const content = '  ⠀🎃\n  zweite Zeile';
  await fs.writeFile(path.join(directory, 'sample.txt'), content, 'utf8');
  const store = new AsciiArtStore(directory, 450);
  const art = await store.load('sample');
  assert.equal(art.content, content);
  assert.equal(art.characterCount, Array.from(content).length);
  assert.deepEqual(await store.list(), ['sample']);
  await fs.rm(directory, { recursive: true, force: true });
});

test('Große Art wird für Chat kontrolliert in Zeilenblöcke geteilt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-art-limit-'));
  await fs.writeFile(path.join(directory, 'big.txt'), 'abc\ndef\nghi', 'utf8');
  const store = new AsciiArtStore(directory, 7);
  assert.deepEqual(await store.splitForChat('big'), ['abc\ndef', 'ghi']);
  await assert.rejects(() => store.loadForChat('big'), /überschreitet/);
  await fs.rm(directory, { recursive: true, force: true });
});
