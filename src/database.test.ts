import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from './database.js';

test('SQLite-Punktestand und Cooldown überleben einen Neustart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-halloween-'));
  const filePath = path.join(directory, 'halloween.sqlite');
  const first = new Database(filePath, true);
  const result = first.applyPlay('viewer-1', 'Ada', 12, 1_000, 900_000);
  assert.equal(result.accepted, true);
  first.close();
  const second = new Database(filePath, true);
  assert.equal(second.getPlayer('viewer-1').pumpkins, 12);
  const cooldown = second.applyPlay('viewer-1', 'Ada', 1, 1_001, 900_000);
  assert.equal(cooldown.accepted, false);
  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Event-IDs werden dedupliziert', () => {
  const database = new Database(':memory:', true);
  assert.equal(database.markEventProcessed('event-1', 1), true);
  assert.equal(database.markEventProcessed('event-1', 2), false);
  database.close();
});

test('Backup wird erstellt und mit restriktiven Rechten gespeichert', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-halloween-backup-'));
  const filePath = path.join(directory, 'halloween.sqlite');
  const backupPath = path.join(directory, 'backups', 'copy.sqlite');
  const database = new Database(filePath, true);
  await database.backup(backupPath);
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
