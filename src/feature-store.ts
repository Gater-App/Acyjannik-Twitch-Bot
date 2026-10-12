import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type { Player } from './types.js';

export interface SeasonalEvent {
  id: string;
  name: string;
  emoji: string;
  active: boolean;
  startAt: number | null;
  endAt: number | null;
  timezone: string;
  currency: string;
  cooldownMs: number;
  command: string;
  archivedAt: number | null;
  weights: Record<string, number>;
  texts: Record<string, string>;
}

export interface CustomCommand {
  name: string;
  response: string;
  enabled: boolean;
  permission: 'everyone' | 'moderator' | 'broadcaster';
  cooldownMs: number;
  alias: string | null;
  expiresAt: number | null;
  modsMayManage: boolean;
}

interface EventRow {
  id: string; name: string; emoji: string; active: number; start_at: number | null; end_at: number | null;
  timezone: string; currency: string; cooldown_ms: number; command_name: string; archived_at: number | null;
  weights_json: string; texts_json: string;
}

interface CommandRow {
  name: string; response: string; enabled: number; permission: string; cooldown_ms: number;
  alias: string | null; expires_at: number | null; mods_may_manage: number;
}

const DEFAULT_8BALL = [
  'Auf jeden Fall!', 'Sieht sehr gut aus.', 'Die Zeichen stehen günstig.', 'Ganz klar: ja.',
  'Darauf kannst du wetten.', 'Ich denke schon.', 'Wahrscheinlich.', 'Frage später noch einmal.',
  'Konzentriere dich und frag erneut.', 'Das ist gerade schwer zu sagen.', 'Meine Quellen sind uneins.',
  'Eher nicht.', 'Die Aussichten sind schlecht.', 'Nein.', 'Ganz sicher nicht.',
  'Nur der Chat kennt die Antwort.', 'Der Würfel sagt: vielleicht.', 'Heute lieber nicht.',
  'Ein überraschendes Ja!', 'Die Sterne sagen: später.', 'Frag den Boss im nächsten Kampf.',
  'Das Orakel braucht eine Pause.',
];

const RESERVED_COMMANDS = new Set([
  'trickortreat', 'pumpkins', 'top', 'halloween', 'starthalloween', 'endhalloween', 'resethalloween',
  'gift', 'egghunt', 'eventscore', 'eventtop', 'startevent', 'endevent', 'level', 'xptop', 'rank',
  '8ball', 'rps', 'guess', 'startguess', 'duel', 'accept', 'cancelduel', 'startboss', 'attack',
  'boss', 'bosstop', 'endboss', 'addcommand', 'setcommand', 'delcommand', 'help',
]);

export class FeatureStore {
  private readonly db: BetterSqlite3.Database;

  constructor(filePath: string) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, pumpkins INTEGER NOT NULL DEFAULT 0 CHECK (pumpkins >= 0), updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cooldowns (user_id TEXT PRIMARY KEY, last_played_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL CHECK (active IN (0,1)), changed_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO game_state(id,active,changed_at) VALUES(1,0,${Date.now()});
    `);
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const applied = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if ((applied.version ?? 0) >= 1) return;
    const migration = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS xp_users (
          user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0), updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS xp_ledger (
          event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS xp_ledger_user_time ON xp_ledger(user_id, created_at);
        CREATE TABLE IF NOT EXISTS xp_activity (
          user_id TEXT PRIMARY KEY, last_xp_at INTEGER NOT NULL, fingerprint TEXT NOT NULL, fingerprint_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feature_cooldowns (
          feature TEXT NOT NULL, user_id TEXT NOT NULL, last_used_at INTEGER NOT NULL, PRIMARY KEY(feature, user_id)
        );
        CREATE TABLE IF NOT EXISTS feature_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS seasonal_events (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
          start_at INTEGER, end_at INTEGER, timezone TEXT NOT NULL DEFAULT 'Europe/Berlin', currency TEXT NOT NULL,
          cooldown_ms INTEGER NOT NULL DEFAULT 900000, command_name TEXT NOT NULL, weights_json TEXT NOT NULL DEFAULT '{}',
          texts_json TEXT NOT NULL DEFAULT '{}', archived_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_primary_event ON seasonal_events(active) WHERE active = 1;
        CREATE TABLE IF NOT EXISTS seasonal_scores (
          event_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
          updated_at INTEGER NOT NULL, PRIMARY KEY(event_id, user_id), FOREIGN KEY(event_id) REFERENCES seasonal_events(id)
        );
        CREATE TABLE IF NOT EXISTS seasonal_cooldowns (
          event_id TEXT NOT NULL, user_id TEXT NOT NULL, last_played_at INTEGER NOT NULL, PRIMARY KEY(event_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS feature_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS duels (
          id TEXT PRIMARY KEY, challenger_id TEXT NOT NULL, challenger_name TEXT NOT NULL, challenged_id TEXT NOT NULL,
          challenged_name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          winner_id TEXT, resolved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS duel_participants_status ON duels(status, challenger_id, challenged_id);
        CREATE TABLE IF NOT EXISTS boss_fights (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, max_hp INTEGER NOT NULL, hp INTEGER NOT NULL, status TEXT NOT NULL,
          started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, finished_at INTEGER, reward_granted INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_boss ON boss_fights(status) WHERE status = 'active';
        CREATE TABLE IF NOT EXISTS boss_participants (
          boss_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL, damage INTEGER NOT NULL DEFAULT 0,
          attacks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(boss_id, user_id), FOREIGN KEY(boss_id) REFERENCES boss_fights(id)
        );
        CREATE TABLE IF NOT EXISTS custom_commands (
          name TEXT PRIMARY KEY, response TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          permission TEXT NOT NULL DEFAULT 'everyone', cooldown_ms INTEGER NOT NULL DEFAULT 0, alias TEXT,
          expires_at INTEGER, mods_may_manage INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS admin_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
          details_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS community_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS community_events_time ON community_events(created_at);
        INSERT OR IGNORE INTO seasonal_events(id,name,emoji,active,currency,cooldown_ms,command_name,timezone)
          SELECT 'halloween','Halloween','🎃',active,'Kürbisse',900000,'trickortreat','Europe/Berlin' FROM game_state WHERE id=1;
        INSERT OR IGNORE INTO seasonal_events(id,name,emoji,active,currency,cooldown_ms,command_name,timezone)
          VALUES ('christmas','Weihnachten','🎄',0,'Geschenke',900000,'gift','Europe/Berlin');
        INSERT OR IGNORE INTO seasonal_events(id,name,emoji,active,currency,cooldown_ms,command_name,timezone)
          VALUES ('easter','Ostern','🐣',0,'Ostereier',900000,'egghunt','Europe/Berlin');
        UPDATE seasonal_events SET weights_json='{"GIFT":55,"JACKPOT":5,"EMPTY_HOUSE":40}' WHERE id='christmas' AND weights_json='{}';
        UPDATE seasonal_events SET weights_json='{"EGG":60,"GOLDEN_EGG":3,"EMPTY_HOUSE":37}' WHERE id='easter' AND weights_json='{}';
        UPDATE seasonal_events SET weights_json='{"TREAT":55,"TRICK":15,"JACKPOT":5,"GHOST":8,"WITCH":8,"EMPTY_HOUSE":8,"GOLDEN_PUMPKIN":1}' WHERE id='halloween' AND weights_json='{}';
        INSERT OR IGNORE INTO seasonal_scores(event_id,user_id,display_name,points,updated_at)
          SELECT 'halloween',user_id,display_name,pumpkins,updated_at FROM players;
        INSERT OR IGNORE INTO seasonal_cooldowns(event_id,user_id,last_played_at)
          SELECT 'halloween',user_id,last_played_at FROM cooldowns;
        INSERT OR IGNORE INTO feature_config(key,value) VALUES
          ('modules','{"xp":true,"events":true,"eightBall":true,"rps":true,"guess":true,"duels":true,"boss":true,"customCommands":true}'),
          ('8ball_answers', '${JSON.stringify(DEFAULT_8BALL)}'),
          ('xp_settings', '{"activityXp":5,"activityCooldownMs":60000,"dailyGameCap":100,"rpsWinXp":10,"guessWinXp":20,"duelWinXp":15,"levelBase":100}'),
          ('game_settings', '{"guessMin":1,"guessMax":100,"guessTimeoutMs":120000,"guessAttempts":5,"duelTtlMs":60000,"bossHp":1000,"bossDurationMs":900000,"attackMin":20,"attackMax":60,"attackCooldownMs":10000,"bossWinXp":30,"bossTopBonusXp":10}');
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (1, unixepoch()*1000);
      `);
    });
    migration();
  }

  config<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM feature_config WHERE key=?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }

  setConfig(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO feature_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  awardXp(eventId: string, userId: string, displayName: string, amount: number, reason: string, now: number, dailyCap?: number): number {
    if (!Number.isInteger(amount) || amount <= 0) return 0;
    return this.db.transaction(() => this.awardXpInside(eventId, userId, displayName, amount, reason, now, dailyCap))();
  }

  private awardXpInside(eventId: string, userId: string, displayName: string, amount: number, reason: string, now: number, dailyCap?: number): number {
    if (dailyCap !== undefined) {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      const earned = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM xp_ledger WHERE user_id=? AND reason LIKE 'bonus:%' AND created_at>=?")
        .get(userId, start.getTime()) as { total: number };
      amount = Math.min(amount, Math.max(0, dailyCap - earned.total));
    }
    if (amount <= 0) return 0;
    const inserted = this.db.prepare('INSERT OR IGNORE INTO xp_ledger(event_id,user_id,amount,reason,created_at) VALUES(?,?,?,?,?)')
      .run(eventId, userId, amount, reason, now);
    if (!inserted.changes) return 0;
    this.db.prepare(`INSERT INTO xp_users(user_id,display_name,xp,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,xp=xp_users.xp+excluded.xp,updated_at=excluded.updated_at`)
      .run(userId, displayName, amount, now);
    return amount;
  }

  awardActivity(userId: string, displayName: string, fingerprint: string, eventId: string, now: number, xp: number, cooldownMs: number): number {
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT last_xp_at,fingerprint,fingerprint_at FROM xp_activity WHERE user_id=?').get(userId) as
        { last_xp_at: number; fingerprint: string; fingerprint_at: number } | undefined;
      this.db.prepare(`INSERT INTO xp_activity(user_id,last_xp_at,fingerprint,fingerprint_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET fingerprint=excluded.fingerprint,fingerprint_at=excluded.fingerprint_at`)
        .run(userId, previous?.last_xp_at ?? 0, fingerprint, now);
      if (previous && previous.fingerprint === fingerprint && now - previous.fingerprint_at < 300_000) return 0;
      if (previous && now - previous.last_xp_at < cooldownMs) return 0;
      const awarded = this.awardXpInside(`activity:${eventId}`, userId, displayName, xp, 'activity', now);
      if (awarded > 0) this.db.prepare('UPDATE xp_activity SET last_xp_at=? WHERE user_id=?').run(now, userId);
      return awarded;
    })();
  }

  xp(userId: string): { xp: number; displayName: string } {
    const row = this.db.prepare('SELECT xp,display_name FROM xp_users WHERE user_id=?').get(userId) as { xp: number; display_name: string } | undefined;
    return { xp: row?.xp ?? 0, displayName: row?.display_name ?? userId };
  }

  findUser(loginOrName: string): { userId: string; displayName: string; xp: number } | undefined {
    const row = this.db.prepare('SELECT user_id,display_name,xp FROM xp_users WHERE lower(display_name)=lower(?) OR lower(user_id)=lower(?) LIMIT 1')
      .get(loginOrName.replace(/^@/u, ''), loginOrName.replace(/^@/u, '')) as { user_id: string; display_name: string; xp: number } | undefined;
    return row ? { userId: row.user_id, displayName: row.display_name, xp: row.xp } : undefined;
  }

  xpTop(limit = 10): Array<{ userId: string; displayName: string; xp: number }> {
    const rows = this.db.prepare('SELECT user_id,display_name,xp FROM xp_users ORDER BY xp DESC,updated_at ASC LIMIT ?').all(limit) as
      Array<{ user_id: string; display_name: string; xp: number }>;
    return rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, xp: row.xp }));
  }

  xpRank(userId: string): number {
    const user = this.db.prepare('SELECT xp FROM xp_users WHERE user_id=?').get(userId) as { xp: number } | undefined;
    if (!user) return 0;
    const row = this.db.prepare('SELECT 1 + COUNT(*) AS rank FROM xp_users WHERE xp > ?').get(user.xp) as { rank: number };
    return row.rank;
  }

  useCooldown(feature: string, userId: string, now: number, cooldownMs: number): number {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT last_used_at FROM feature_cooldowns WHERE feature=? AND user_id=?').get(feature, userId) as { last_used_at: number } | undefined;
      if (row && now - row.last_used_at < cooldownMs) return cooldownMs - (now - row.last_used_at);
      this.db.prepare(`INSERT INTO feature_cooldowns(feature,user_id,last_used_at) VALUES(?,?,?)
        ON CONFLICT(feature,user_id) DO UPDATE SET last_used_at=excluded.last_used_at`).run(feature, userId, now);
      return 0;
    })();
  }

  events(): SeasonalEvent[] {
    const rows = this.db.prepare('SELECT * FROM seasonal_events ORDER BY id').all() as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  event(id: string): SeasonalEvent | undefined {
    const row = this.db.prepare('SELECT * FROM seasonal_events WHERE id=?').get(id) as EventRow | undefined;
    return row ? this.toEvent(row) : undefined;
  }

  activeEvent(): SeasonalEvent | undefined {
    const row = this.db.prepare('SELECT * FROM seasonal_events WHERE active=1').get() as EventRow | undefined;
    return row ? this.toEvent(row) : undefined;
  }

  saveEvent(event: Omit<SeasonalEvent, 'archivedAt'> & { archivedAt?: number | null }): void {
    if (!/^[a-z0-9_-]{2,40}$/u.test(event.id) || !/^[a-z0-9_]{2,32}$/u.test(normalizeCommand(event.command))
      || (event.id === 'halloween' && normalizeCommand(event.command) !== 'trickortreat')) throw new Error('Ungültige Event-ID oder Befehl.');
    if (!event.name.trim() || event.name.length > 80 || !event.currency.trim() || event.currency.length > 32
      || !Number.isInteger(event.cooldownMs) || event.cooldownMs < 0 || event.cooldownMs > 86_400_000
      || (event.startAt !== null && (!Number.isSafeInteger(event.startAt) || event.startAt < 1))
      || (event.endAt !== null && (!Number.isSafeInteger(event.endAt) || event.endAt < 1))
      || (event.startAt !== null && event.endAt !== null && event.endAt <= event.startAt)) throw new Error('Ungültige Event-Einstellungen.');
    if (Object.entries(event.weights || {}).length > 32 || Object.entries(event.weights || {}).some(([key, value]) => !/^[A-Z_]{2,32}$/u.test(key) || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
      throw new Error('Ungültige Event-Gewichtung.');
    }
    if (Object.entries(event.texts || {}).length > 32 || Object.entries(event.texts || {}).some(([key, value]) => !/^[A-Z_]{2,32}$|^default$/u.test(key) || typeof value !== 'string' || value.length > 500)) {
      throw new Error('Ungültige Event-Texte.');
    }
    try { new Intl.DateTimeFormat('de-DE', { timeZone: event.timezone }); } catch { throw new Error('Ungültige Event-Zeitzone.'); }
    this.db.prepare(`INSERT INTO seasonal_events(id,name,emoji,active,start_at,end_at,timezone,currency,cooldown_ms,command_name,weights_json,texts_json,archived_at)
      VALUES(@id,@name,@emoji,@active,@startAt,@endAt,@timezone,@currency,@cooldownMs,@command,@weights,@texts,@archivedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,emoji=excluded.emoji,start_at=excluded.start_at,end_at=excluded.end_at,
      timezone=excluded.timezone,currency=excluded.currency,cooldown_ms=excluded.cooldown_ms,command_name=excluded.command_name,
      weights_json=excluded.weights_json,texts_json=excluded.texts_json`)
      .run({ ...event, active: event.active ? 1 : 0, command: normalizeCommand(event.command), weights: JSON.stringify(event.weights ?? {}),
        texts: JSON.stringify(event.texts ?? {}), archivedAt: event.archivedAt ?? null });
  }

  saveEvents(events: SeasonalEvent[]): void {
    this.db.transaction(() => { for (const event of events) this.saveEvent(event); })();
  }

  syncLegacyHalloween(now = Date.now()): void {
    this.db.transaction(() => {
      const state = this.db.prepare('SELECT active FROM game_state WHERE id=1').get() as { active: number } | undefined;
      if (!state) return;
      if (state.active) {
        const current = this.activeEvent();
        if (!current || current.id === 'halloween') {
          this.db.prepare("UPDATE seasonal_events SET active=CASE WHEN id='halloween' THEN 1 ELSE 0 END WHERE active=1 OR id='halloween'").run();
        }
      } else {
        this.db.prepare("UPDATE seasonal_events SET active=0,archived_at=COALESCE(archived_at,?) WHERE id='halloween'").run(now);
      }
      this.db.prepare(`INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at)
        SELECT 'halloween',user_id,display_name,pumpkins,updated_at FROM players WHERE 1
        ON CONFLICT(event_id,user_id) DO UPDATE SET display_name=excluded.display_name,points=excluded.points,updated_at=excluded.updated_at`).run();
      this.db.prepare(`INSERT INTO seasonal_cooldowns(event_id,user_id,last_played_at)
        SELECT 'halloween',user_id,last_played_at FROM cooldowns WHERE 1
        ON CONFLICT(event_id,user_id) DO UPDATE SET last_played_at=excluded.last_played_at`).run();
    })();
  }

  setEventActive(id: string, active: boolean, now: number): boolean {
    return this.db.transaction(() => {
      const event = this.event(id);
      if (!event) return false;
      if (event.active === active) return true;
      if (active) {
        const current = this.activeEvent();
        if (current && current.id !== id) return false;
      }
      this.db.prepare('UPDATE seasonal_events SET active=?,archived_at=? WHERE id=?').run(active ? 1 : 0, active ? null : now, id);
      if (id === 'halloween') this.db.prepare('UPDATE game_state SET active=?,changed_at=? WHERE id=1').run(active ? 1 : 0, now);
      this.recordCommunityEvent(active ? 'seasonal.event.started' : 'seasonal.event.ended', { id, name: event.name, emoji: event.emoji }, now);
      return true;
    })();
  }

  playEvent(id: string, userId: string, displayName: string, delta: number, now: number):
    { ok: true; points: number } | { ok: false; reason: 'inactive' | 'cooldown'; remainingMs?: number } {
    return this.db.transaction(() => {
      const event = this.event(id);
      if (!event?.active) return { ok: false as const, reason: 'inactive' as const };
      if ((event.startAt && now < event.startAt) || (event.endAt && now >= event.endAt)) return { ok: false as const, reason: 'inactive' as const };
      const cooldown = this.db.prepare('SELECT last_played_at FROM seasonal_cooldowns WHERE event_id=? AND user_id=?').get(id, userId) as { last_played_at: number } | undefined;
      if (cooldown && now - cooldown.last_played_at < event.cooldownMs) return { ok: false as const, reason: 'cooldown' as const, remainingMs: event.cooldownMs - (now - cooldown.last_played_at) };
      const row = this.db.prepare('SELECT points FROM seasonal_scores WHERE event_id=? AND user_id=?').get(id, userId) as { points: number } | undefined;
      const points = Math.max(0, (row?.points ?? 0) + delta);
      this.db.prepare(`INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(event_id,user_id) DO UPDATE SET display_name=excluded.display_name,points=excluded.points,updated_at=excluded.updated_at`)
        .run(id, userId, displayName, points, now);
      this.db.prepare(`INSERT INTO seasonal_cooldowns(event_id,user_id,last_played_at) VALUES(?,?,?)
        ON CONFLICT(event_id,user_id) DO UPDATE SET last_played_at=excluded.last_played_at`).run(id, userId, now);
      if (id === 'halloween') {
        this.db.prepare(`INSERT INTO players(user_id,display_name,pumpkins,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,pumpkins=excluded.pumpkins,updated_at=excluded.updated_at`)
          .run(userId, displayName, points, now);
        this.db.prepare(`INSERT INTO cooldowns(user_id,last_played_at) VALUES(?,?)
          ON CONFLICT(user_id) DO UPDATE SET last_played_at=excluded.last_played_at`).run(userId, now);
      }
      this.recordCommunityEvent('seasonal.score.changed', { eventId: id, userId, displayName, points, delta }, now);
      return { ok: true as const, points };
    })();
  }

  eventTop(id: string, limit = 10): Player[] {
    const rows = this.db.prepare('SELECT user_id,display_name,points,updated_at FROM seasonal_scores WHERE event_id=? ORDER BY points DESC,updated_at ASC LIMIT ?').all(id, limit) as
      Array<{ user_id: string; display_name: string; points: number; updated_at: number }>;
    return rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, pumpkins: row.points, updatedAt: row.updated_at }));
  }

  score(id: string, userId: string): number {
    const row = this.db.prepare('SELECT points FROM seasonal_scores WHERE event_id=? AND user_id=?').get(id, userId) as { points: number } | undefined;
    return row?.points ?? 0;
  }

  state<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM feature_state WHERE key=?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }

  setState(key: string, value: unknown, now: number): void {
    this.db.prepare('INSERT INTO feature_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(key, JSON.stringify(value), now);
  }

  clearState(key: string, now: number): void { this.setState(key, null, now); }

  createDuel(challengerId: string, challengerName: string, challengedId: string, challengedName: string, now: number, ttlMs: number):
    { ok: true; id: string } | { ok: false; reason: 'self' | 'busy' } {
    return this.db.transaction(() => {
      if (challengerId === challengedId) return { ok: false as const, reason: 'self' as const };
      this.expireDuels(now);
      const busy = this.db.prepare("SELECT 1 FROM duels WHERE status='pending' AND (challenger_id IN (?,?) OR challenged_id IN (?,?)) LIMIT 1")
        .get(challengerId, challengedId, challengerId, challengedId);
      if (busy) return { ok: false as const, reason: 'busy' as const };
      const id = `duel-${now}-${randomUUID()}`;
      this.db.prepare('INSERT INTO duels(id,challenger_id,challenger_name,challenged_id,challenged_name,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, challengerId, challengerName, challengedId, challengedName, 'pending', now, now + ttlMs);
      return { ok: true as const, id };
    })();
  }

  acceptDuel(userId: string, now: number, dailyCap: number, xpReward: number):
    { status: 'accepted'; winnerName: string; loserName: string; winnerId: string } | { status: 'missing' | 'expired' } {
    return this.db.transaction(() => {
      const duel = this.db.prepare("SELECT * FROM duels WHERE challenged_id=? AND status='pending' ORDER BY created_at LIMIT 1").get(userId) as
        { id: string; challenger_id: string; challenger_name: string; challenged_name: string; expires_at: number } | undefined;
      if (!duel) return { status: 'missing' as const };
      if (duel.expires_at <= now) {
        this.db.prepare("UPDATE duels SET status='expired' WHERE id=?").run(duel.id);
        return { status: 'expired' as const };
      }
      this.expireDuels(now);
      const winnerIsChallenger = randomInt(0, 2) === 0;
      const winnerId = winnerIsChallenger ? duel.challenger_id : userId;
      const winnerName = winnerIsChallenger ? duel.challenger_name : duel.challenged_name;
      const loserName = winnerIsChallenger ? duel.challenged_name : duel.challenger_name;
      this.db.prepare("UPDATE duels SET status='resolved',winner_id=?,resolved_at=? WHERE id=? AND status='pending'").run(winnerId, now, duel.id);
      this.awardXpInside(`bonus:duel:${duel.id}`, winnerId, winnerName, xpReward, 'bonus:duel', now, dailyCap);
      this.recordCommunityEvent('duel.resolved', { duelId: duel.id, winnerId, winnerName, loserName }, now);
      return { status: 'accepted' as const, winnerName, loserName, winnerId };
    })();
  }

  cancelDuel(userId: string, now: number): boolean {
    return this.db.prepare("UPDATE duels SET status='cancelled',resolved_at=? WHERE challenger_id=? AND status='pending'").run(now, userId).changes > 0;
  }

  private expireDuels(now: number): void {
    this.db.prepare("UPDATE duels SET status='expired',resolved_at=? WHERE status='pending' AND expires_at<=?").run(now, now);
  }

  startBoss(id: string, name: string, hp: number, durationMs: number, now: number): boolean {
    try {
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO boss_fights(id,name,max_hp,hp,status,started_at,expires_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, name, hp, hp, 'active', now, now + durationMs);
        this.recordCommunityEvent('boss.started', { id, name, hp, expiresAt: now + durationMs }, now);
      })();
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return false;
      throw error;
    }
  }

  activeBoss(now: number): { id: string; name: string; maxHp: number; hp: number; expiresAt: number } | undefined {
    const expired = this.db.prepare("SELECT id,name FROM boss_fights WHERE status='active' AND expires_at<=?").get(now) as { id: string; name: string } | undefined;
    if (expired) this.db.transaction(() => {
      this.db.prepare("UPDATE boss_fights SET status='timeout',finished_at=? WHERE id=? AND status='active'").run(now, expired.id);
      this.recordCommunityEvent('boss.timeout', { bossId: expired.id, name: expired.name }, now);
    })();
    const row = this.db.prepare("SELECT id,name,max_hp,hp,expires_at FROM boss_fights WHERE status='active'").get() as
      { id: string; name: string; max_hp: number; hp: number; expires_at: number } | undefined;
    return row ? { id: row.id, name: row.name, maxHp: row.max_hp, hp: row.hp, expiresAt: row.expires_at } : undefined;
  }

  attackBoss(userId: string, displayName: string, damage: number, now: number, eventId: string, xpOnHit: number, winXp: number, topBonusXp: number, dailyCap = 100):
    { status: 'missing' | 'hit' | 'defeated'; name?: string; hp?: number; damage?: number; winner?: string } {
    return this.db.transaction(() => {
      const boss = this.db.prepare("SELECT id,name,max_hp,hp,expires_at FROM boss_fights WHERE status='active'").get() as
        { id: string; name: string; max_hp: number; hp: number; expires_at: number } | undefined;
      if (!boss || boss.expires_at <= now) {
        if (boss) this.db.prepare("UPDATE boss_fights SET status='timeout',finished_at=? WHERE id=?").run(now, boss.id);
        return { status: 'missing' as const };
      }
      const actualDamage = Math.min(damage, boss.hp);
      const hp = boss.hp - actualDamage;
      this.db.prepare(`INSERT INTO boss_participants(boss_id,user_id,display_name,damage,attacks) VALUES(?,?,?,?,1)
        ON CONFLICT(boss_id,user_id) DO UPDATE SET display_name=excluded.display_name,damage=boss_participants.damage+excluded.damage,attacks=boss_participants.attacks+1`)
        .run(boss.id, userId, displayName, actualDamage);
      const participant = this.db.prepare('SELECT damage FROM boss_participants WHERE boss_id=? AND user_id=?').get(boss.id, userId) as { damage: number };
      this.awardXpInside(`bonus:${eventId}`, userId, displayName, xpOnHit, 'bonus:boss-participation', now, dailyCap);
      if (hp > 0) {
        this.db.prepare("UPDATE boss_fights SET hp=? WHERE id=? AND status='active'").run(hp, boss.id);
        this.recordCommunityEvent('boss.attack', { bossId: boss.id, name: boss.name, userId, displayName, damage: actualDamage, hp }, now);
        return { status: 'hit' as const, name: boss.name, hp, damage: actualDamage };
      }
      const defeated = this.db.prepare("UPDATE boss_fights SET hp=0,status='defeated',finished_at=?,reward_granted=1 WHERE id=? AND status='active' AND reward_granted=0")
        .run(now, boss.id);
      if (defeated.changes) {
        const participants = this.db.prepare('SELECT user_id,display_name,damage FROM boss_participants WHERE boss_id=?').all(boss.id) as
          Array<{ user_id: string; display_name: string; damage: number }>;
        for (const p of participants) this.awardXpInside(`bonus:boss-win:${boss.id}:${p.user_id}`, p.user_id, p.display_name, winXp, 'bonus:boss-win', now, dailyCap);
        const top = participants.sort((a, b) => b.damage - a.damage)[0];
        if (top) this.awardXpInside(`bonus:boss-top:${boss.id}:${top.user_id}`, top.user_id, top.display_name, topBonusXp, 'bonus:boss-top', now, dailyCap);
        this.recordCommunityEvent('boss.defeated', { bossId: boss.id, name: boss.name, userId, displayName, damage: actualDamage, participants: participants.length }, now);
      }
      return { status: 'defeated' as const, name: boss.name, hp: 0, damage: actualDamage, winner: displayName };
    })();
  }

  bossTop(limit = 5): Array<{ displayName: string; damage: number }> {
    const boss = this.db.prepare("SELECT id FROM boss_fights WHERE status='active' ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (!boss) return [];
    const rows = this.db.prepare('SELECT display_name,damage FROM boss_participants WHERE boss_id=? ORDER BY damage DESC LIMIT ?').all(boss.id, limit) as
      Array<{ display_name: string; damage: number }>;
    return rows.map((row) => ({ displayName: row.display_name, damage: row.damage }));
  }

  endBoss(now: number): boolean {
    return this.db.transaction(() => {
      const boss = this.db.prepare("SELECT id,name FROM boss_fights WHERE status='active'").get() as { id: string; name: string } | undefined;
      if (!boss) return false;
      const result = this.db.prepare("UPDATE boss_fights SET status='ended',finished_at=? WHERE id=? AND status='active'").run(now, boss.id);
      if (result.changes) this.recordCommunityEvent('boss.ended', { bossId: boss.id, name: boss.name }, now);
      return result.changes > 0;
    })();
  }

  addCustomCommand(command: CustomCommand): void {
    const name = normalizeCommand(command.name);
    const alias = command.alias ? normalizeCommand(command.alias) : null;
    const response = command.response.trim();
    if (!/^[a-z0-9_]{1,25}$/u.test(name) || RESERVED_COMMANDS.has(name) || (alias && (!/^[a-z0-9_]{1,25}$/u.test(alias) || RESERVED_COMMANDS.has(alias)))) throw new Error('Reservierter oder ungültiger Befehl.');
    if (!['everyone','moderator','broadcaster'].includes(command.permission) || !response || response.length > 1000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(response)
      || response.replace(/\{(?:user|channel|game|uptime)\}/gu, '').match(/[{}]/u)) throw new Error('Antwort enthält ungültige Platzhalter oder Zeichen.');
    const collision = alias && this.db.prepare('SELECT 1 FROM custom_commands WHERE (name=? OR alias=?) AND name<>?').get(alias, alias, name);
    const nameCollision = this.db.prepare('SELECT 1 FROM custom_commands WHERE alias=? AND name<>?').get(name, name);
    if ((collision && alias !== name) || nameCollision) throw new Error('Befehl oder Alias existiert bereits.');
    this.db.prepare(`INSERT INTO custom_commands(name,response,enabled,permission,cooldown_ms,alias,expires_at,mods_may_manage)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET response=excluded.response,enabled=excluded.enabled,
      permission=excluded.permission,cooldown_ms=excluded.cooldown_ms,alias=excluded.alias,expires_at=excluded.expires_at,mods_may_manage=excluded.mods_may_manage`)
      .run(name, response, command.enabled ? 1 : 0, command.permission, Math.max(0, command.cooldownMs), alias, command.expiresAt, command.modsMayManage ? 1 : 0);
  }

  customCommand(name: string, now: number): CustomCommand | undefined {
    const normalized = normalizeCommand(name);
    const row = this.db.prepare('SELECT * FROM custom_commands WHERE name=? OR alias=? LIMIT 1').get(normalized, normalized) as CommandRow | undefined;
    if (!row || !row.enabled || (row.expires_at !== null && row.expires_at <= now)) return undefined;
    return this.toCommand(row);
  }

  customCommands(): CustomCommand[] {
    const rows = this.db.prepare('SELECT * FROM custom_commands ORDER BY name').all() as CommandRow[];
    return rows.map((row) => this.toCommand(row));
  }

  deleteCustomCommand(name: string): boolean {
    const normalized = normalizeCommand(name);
    return this.db.prepare('DELETE FROM custom_commands WHERE name=? OR alias=?').run(normalized, normalized).changes > 0;
  }

  adminAudit(actorId: string, action: string, target: string, details: unknown, now: number): void {
    this.db.prepare('INSERT INTO admin_audit(actor_id,action,target,details_json,created_at) VALUES(?,?,?,?,?)')
      .run(actorId, action, target, JSON.stringify(details ?? {}), now);
  }

  recordCommunityEvent(type: string, payload: unknown, now: number): void {
    this.db.prepare('INSERT INTO community_events(type,payload_json,created_at) VALUES(?,?,?)').run(type, JSON.stringify(payload ?? {}), now);
    this.db.prepare('DELETE FROM community_events WHERE id <= (SELECT MAX(id)-10000 FROM community_events)').run();
  }

  communityEventsAfter(id: number, limit = 100): Array<{ id: number; type: string; payload: unknown; createdAt: number }> {
    const rows = this.db.prepare('SELECT id,type,payload_json,created_at FROM community_events WHERE id>? ORDER BY id LIMIT ?').all(id, Math.min(500, Math.max(1, limit))) as
      Array<{ id: number; type: string; payload_json: string; created_at: number }>;
    return rows.map((row) => {
      let payload: unknown = {};
      try { payload = JSON.parse(row.payload_json) as unknown; } catch { /* Ignore invalid historical rows. */ }
      return { id: row.id, type: row.type, payload, createdAt: row.created_at };
    });
  }

  adjustXp(userId: string, displayName: string, amount: number, actorId: string, reason: string, now: number): void {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000) throw new Error('Ungültige XP-Korrektur.');
    this.db.transaction(() => {
      const current = this.xp(userId).xp;
      const next = Math.max(0, current + amount);
      this.db.prepare(`INSERT INTO xp_users(user_id,display_name,xp,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,xp=excluded.xp,updated_at=excluded.updated_at`).run(userId, displayName, next, now);
      if (next !== current) this.db.prepare('INSERT INTO xp_ledger(event_id,user_id,amount,reason,created_at) VALUES(?,?,?,?,?)')
        .run(`admin-adjust:${randomUUID()}`, userId, next - current, 'admin-adjust', now);
      this.adminAudit(actorId, 'xp-adjust', userId, { amount, reason, result: next }, now);
    })();
  }

  users(search = '', limit = 25): Array<{ userId: string; displayName: string; xp: number }> {
    const rows = this.db.prepare('SELECT user_id,display_name,xp FROM xp_users WHERE ?="" OR lower(user_id) LIKE lower(?) OR lower(display_name) LIKE lower(?) ORDER BY xp DESC LIMIT ?')
      .all(search, `%${search}%`, `%${search}%`, limit) as Array<{ user_id: string; display_name: string; xp: number }>;
    return rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, xp: row.xp }));
  }

  overview(): Record<string, unknown> {
    const users = (this.db.prepare('SELECT COUNT(*) AS value FROM xp_users').get() as { value: number }).value;
    const xpToday = (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS value FROM xp_ledger WHERE created_at>=strftime('%s','now','start of day')*1000").get() as { value: number }).value;
    const boss = this.activeBoss(Date.now());
    return { users, xpToday, event: this.activeEvent() ?? null, boss: boss ?? null, modules: this.config('modules', {}) };
  }

  close(): void { this.db.close(); }

  private toEvent(row: EventRow): SeasonalEvent {
    return { id: row.id, name: row.name, emoji: row.emoji, active: row.active === 1, startAt: row.start_at, endAt: row.end_at,
      timezone: row.timezone, currency: row.currency, cooldownMs: row.cooldown_ms, command: row.command_name, archivedAt: row.archived_at,
      weights: parseJsonObject<number>(row.weights_json), texts: parseJsonObject<string>(row.texts_json) };
  }

  private toCommand(row: CommandRow): CustomCommand {
    return { name: row.name, response: row.response, enabled: row.enabled === 1, permission: row.permission as CustomCommand['permission'],
      cooldownMs: row.cooldown_ms, alias: row.alias, expiresAt: row.expires_at, modsMayManage: row.mods_may_manage === 1 };
  }
}

function normalizeCommand(name: string): string {
  return name.trim().toLowerCase().replace(/^!/u, '');
}

function parseJsonObject<T extends string | number>(value: string): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, T> : {};
  } catch { return {}; }
}
