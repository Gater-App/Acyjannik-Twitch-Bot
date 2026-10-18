import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Player } from './types.js';

interface PlayerRow {
  user_id: string;
  display_name: string;
  pumpkins: number;
  updated_at: number;
}

export class Database {
  private readonly db: BetterSqlite3.Database;
  private readonly filePath: string;

  constructor(filePath: string, activeOnStart = false) {
    this.filePath = filePath;
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        pumpkins INTEGER NOT NULL DEFAULT 0 CHECK (pumpkins >= 0),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cooldowns (
        user_id TEXT PRIMARY KEY,
        last_played_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        changed_at INTEGER NOT NULL
      );
    `);
    this.db.prepare(
      'INSERT OR IGNORE INTO game_state (id, active, changed_at) VALUES (1, ?, ?)',
    ).run(activeOnStart ? 1 : 0, Date.now());
  }

  get isActive(): boolean {
    const row = this.db.prepare('SELECT active FROM game_state WHERE id = 1').get() as { active: number } | undefined;
    return row?.active === 1;
  }

  setActive(active: boolean, now = Date.now()): void {
    this.db.prepare('UPDATE game_state SET active = ?, changed_at = ? WHERE id = 1').run(active ? 1 : 0, now);
  }

  getPlayer(userId: string): Player {
    const row = this.db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId) as PlayerRow | undefined;
    return row ? this.toPlayer(row) : { userId, displayName: userId, pumpkins: 0, updatedAt: 0 };
  }

  topPlayers(limit = 10): Player[] {
    const rows = this.db.prepare(
      'SELECT * FROM players ORDER BY pumpkins DESC, updated_at ASC, display_name COLLATE NOCASE ASC LIMIT ?',
    ).all(limit) as PlayerRow[];
    return rows.map((row) => this.toPlayer(row));
  }

  applyPlay(userId: string, displayName: string, delta: number, now: number, cooldownMs: number,
    delivery?: { eventId: string; replyParentMessageId?: string; category?: 'season' | 'halloween'; format: (player: Player) => string }):
    { accepted: true; player: Player } | { accepted: false; remainingMs: number } {
    const transaction = this.db.transaction(() => {
      const last = this.db.prepare('SELECT last_played_at FROM cooldowns WHERE user_id = ?').get(userId) as
        { last_played_at: number } | undefined;
      if (last) {
        const remainingMs = cooldownMs - (now - last.last_played_at);
        if (remainingMs > 0) return { accepted: false as const, remainingMs };
      }

      const existing = this.db.prepare('SELECT pumpkins FROM players WHERE user_id = ?').get(userId) as
        { pumpkins: number } | undefined;
      const pumpkins = Math.max(0, (existing?.pumpkins ?? 0) + delta);
      this.db.prepare(`
        INSERT INTO players (user_id, display_name, pumpkins, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name,
          pumpkins = excluded.pumpkins, updated_at = excluded.updated_at
      `).run(userId, displayName, pumpkins, now);
      this.db.prepare(`
        INSERT INTO cooldowns (user_id, last_played_at) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET last_played_at = excluded.last_played_at
      `).run(userId, now);
      const player = { userId, displayName, pumpkins, updatedAt: now };
      if (delivery) {
        const message = delivery.format(player);
        this.db.prepare("INSERT INTO chat_delivery_outbox(event_id,user_id,message,reply_parent_message_id,category,status,attempts,available_at,expires_at,created_at) VALUES(?,?,?,?,?,'pending',0,?,?,?)")
          .run(delivery.eventId, userId, message, delivery.replyParentMessageId ?? null, delivery.category ?? 'halloween', now, now + 5 * 60_000, now);
      }
      return { accepted: true as const, player };
    });
    return transaction() as { accepted: true; player: Player } | { accepted: false; remainingMs: number };
  }

  markEventProcessed(eventId: string, now = Date.now()): boolean {
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)',
    ).run(eventId, now);
    return result.changes === 1;
  }

  async backup(destination: string): Promise<void> {
    if (this.filePath === ':memory:') throw new Error('Ein In-Memory-Testdatensatz kann nicht gesichert werden.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await this.db.backup(destination);
    fs.chmodSync(destination, 0o600);
  }

  resetScores(now = Date.now()): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cooldowns').run();
      this.db.prepare('UPDATE players SET pumpkins = 0, updated_at = ?').run(now);
    });
    transaction();
  }

  close(): void {
    this.db.close();
  }

  private toPlayer(row: PlayerRow): Player {
    return { userId: row.user_id, displayName: row.display_name, pumpkins: row.pumpkins, updatedAt: row.updated_at };
  }
}
