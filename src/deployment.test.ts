import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Database } from './database.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backupScript = path.join(projectRoot, 'scripts', 'backup.mjs');
const restoreScript = path.join(projectRoot, 'scripts', 'restore.mjs');

test('Deployment-Backup wird geprüft und Restore sichert den vorherigen Zielstand', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yannick-backup-restore-'));
  const source = path.join(directory, 'source.sqlite');
  const target = path.join(directory, 'target.sqlite');
  const backups = path.join(directory, 'backups');
  const original = new Database(source); original.setActive(true, 100); original.applyPlay('alice', 'Alice', 25, 200, 1000); original.close();
  const current = new Database(target); current.applyPlay('bob', 'Bob', 1, 200, 1000); current.close();
  try {
    const env = { ...process.env, DATABASE_PATH: source, BACKUP_DIR: backups };
    const backupOutput = execFileSync(process.execPath, [backupScript], { cwd: projectRoot, env, encoding: 'utf8' });
    const backupPath = backupOutput.match(/Backup erstellt und geprüft: (.+)/u)?.[1];
    assert.ok(backupPath && fs.existsSync(backupPath));
    assert.deepEqual(fs.readdirSync(backups), [path.basename(backupPath)], 'SQLite-Backup soll ohne laufende WAL-Nebendateien transportierbar sein');
    const restoreOutput = execFileSync(process.execPath, [restoreScript, backupPath], {
      cwd: projectRoot, env: { ...process.env, DATABASE_PATH: target }, encoding: 'utf8',
    });
    assert.match(restoreOutput, /Wiederherstellung geprüft und abgeschlossen/u);
    assert.match(restoreOutput, /Vorheriger Datenstand separat gesichert/u);
    const restored = new Database(target);
    assert.equal(restored.getPlayer('alice').pumpkins, 25);
    assert.equal(restored.getPlayer('bob').pumpkins, 0);
    restored.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
