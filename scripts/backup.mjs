import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

const source = path.resolve(process.env.DATABASE_PATH || 'data/halloween.sqlite');
const destinationDir = path.resolve(process.env.BACKUP_DIR || 'backups');
if (!fs.existsSync(source)) throw new Error(`SQLite-Datenbank nicht gefunden: ${source}`);
fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const destination = path.join(destinationDir, `community-bot-${stamp}.sqlite`);
const db = new BetterSqlite3(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(destination);
  fs.chmodSync(destination, 0o600);
  const check = new BetterSqlite3(destination, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error('Backup-Integritätsprüfung fehlgeschlagen.');
  } finally { check.close(); }
  const compact = new BetterSqlite3(destination);
  try { compact.pragma('wal_checkpoint(TRUNCATE)'); compact.pragma('journal_mode = DELETE'); } finally { compact.close(); }
  fs.rmSync(`${destination}-wal`, { force: true });
  fs.rmSync(`${destination}-shm`, { force: true });
  process.stdout.write(`Backup erstellt und geprüft: ${destination}\n`);
} finally { db.close(); }
