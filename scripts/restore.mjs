import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';

const source = process.argv[2] ? path.resolve(process.argv[2]) : '';
const target = path.resolve(process.env.DATABASE_PATH || 'data/halloween.sqlite');
if (!source || !fs.existsSync(source)) throw new Error('Aufruf: node scripts/restore.mjs /pfad/zum/backup.sqlite');
if (path.basename(target) === path.parse(target).root || !target.endsWith('.sqlite')) throw new Error('DATABASE_PATH muss auf eine konkrete .sqlite-Datei zeigen.');
if (source === target) throw new Error('Backup- und Zieldatei dürfen nicht identisch sein.');
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
const temp = `${target}.restore-${randomUUID()}`;
const input = new BetterSqlite3(source, { readonly: true, fileMustExist: true });
try {
  const integrity = input.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error('Das Quell-Backup ist beschädigt; Wiederherstellung abgebrochen.');
  await input.backup(temp);
} finally { input.close(); }
fs.chmodSync(temp, 0o600);
const verification = new BetterSqlite3(temp, { readonly: true, fileMustExist: true });
try {
  if (verification.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Kopie konnte nicht verifiziert werden.');
} finally { verification.close(); }
const compact = new BetterSqlite3(temp);
try { compact.pragma('wal_checkpoint(TRUNCATE)'); compact.pragma('journal_mode = DELETE'); } finally { compact.close(); }
fs.rmSync(`${temp}-wal`, { force: true });
fs.rmSync(`${temp}-shm`, { force: true });

let safetyCopy = '';
if (fs.existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  safetyCopy = `${target}.before-restore-${stamp}.sqlite`;
  const current = new BetterSqlite3(target, { readonly: true, fileMustExist: true });
  try { await current.backup(safetyCopy); } finally { current.close(); }
  fs.chmodSync(safetyCopy, 0o600);
  const safetyDb = new BetterSqlite3(safetyCopy);
  try { safetyDb.pragma('wal_checkpoint(TRUNCATE)'); safetyDb.pragma('journal_mode = DELETE'); } finally { safetyDb.close(); }
  fs.rmSync(`${safetyCopy}-wal`, { force: true });
  fs.rmSync(`${safetyCopy}-shm`, { force: true });
}
fs.rmSync(`${target}-wal`, { force: true });
fs.rmSync(`${target}-shm`, { force: true });
fs.renameSync(temp, target);
fs.chmodSync(target, 0o600);
process.stdout.write(`Wiederherstellung geprüft und abgeschlossen: ${target}\n`);
if (safetyCopy) process.stdout.write(`Vorheriger Datenstand separat gesichert: ${safetyCopy}\n`);
