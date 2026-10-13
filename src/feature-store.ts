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

export type QuestStatus = 'pending' | 'approved' | 'active' | 'completed' | 'failed' | 'rejected' | 'canceled';
export type QuestSource = 'chat' | 'channel_points' | 'dashboard';
export type PollStatus = 'active' | 'ended' | 'canceled';
export type WidgetType = 'quest' | 'poll' | 'imposter' | 'detective' | 'pet' | 'drop' | 'wheel';
export type SparkStatus = 'detected' | 'pending_approval' | 'approved' | 'rejected' | 'expired' | 'executed' | 'canceled';
export interface SparkProposal {
  id: string; channelId: string; topicId: string; topicLabel: string; score: number; participants: number;
  messages: number; actionType: 'poll' | 'quest' | 'challenge'; status: SparkStatus; createdAt: number;
  expiresAt: number; decidedBy: string | null; rejectionReason: string | null;
}

export interface QuestRecord {
  id: string;
  submitterUserId: string;
  displayName: string;
  title: string;
  source: QuestSource;
  game: string | null;
  submittedAt: number;
  status: QuestStatus;
  moderationStatus: 'pending' | 'approved' | 'rejected' | 'canceled';
  approvedAt: number | null;
  activatedAt: number | null;
  completedAt: number | null;
  expiresAt: number | null;
  queuedNext: boolean;
  updatedAt: number;
}

export type ChannelRedemptionStatus = 'pending' | 'fulfilled' | 'cancel_pending' | 'fulfillment_pending' | 'canceled' | 'manual' | 'failed';
export interface ChannelRedemptionRecord {
  redemptionId: string; rewardId: string; userId: string; displayName: string; userInput: string; redeemedAt: number;
  status: ChannelRedemptionStatus; questId: string | null; questStatus: QuestStatus | null; lastError: string | null; updatedAt: number;
}

export interface PollOptionResult { label: string; votes: number; percent: number; questId?: string; }
export interface PollRecord {
  id: string;
  type: 'chat' | 'quest';
  question: string;
  options: PollOptionResult[];
  status: PollStatus;
  startsAt: number;
  endsAt: number;
  endedAt: number | null;
  winnerOption: number | null;
  tied: boolean;
  allowVoteChange: boolean;
  totalVotes: number;
}

export interface QuestPolicy {
  maxLength: number; queueLimit: number; maxOpenPerUser: number; cooldownMs: number;
  activeDurationMs: number; completionXp: number;
}

export interface QuestSubmission {
  submitterUserId: string; displayName: string; title: string; source: QuestSource;
  game?: string | null; sourceEventId?: string | null; redemptionId?: string | null;
}

export interface PollOptionInput { label: string; questId?: string; }
export interface PollCreateInput {
  id?: string; type: 'chat' | 'quest'; question: string; options: PollOptionInput[];
  durationMs: number; allowVoteChange: boolean; createdBy: string; now: number;
}

export type QuestSubmitResult =
  | { ok: true; quest: QuestRecord }
  | { ok: false; reason: 'duplicate' | 'cooldown' | 'user-limit' | 'queue-limit'; remainingMs?: number };
export type QuestTransitionResult =
  | { ok: true; quest: QuestRecord; rewardedXp: number }
  | { ok: false; reason: 'missing' | 'invalid-transition' | 'active-exists' | 'not-approved' };
export type PollVoteResult =
  | { ok: true; poll: PollRecord; changed: boolean }
  | { ok: false; reason: 'missing' | 'ended' | 'invalid-option' | 'already-voted' | 'duplicate' | 'ignored' };

interface QuestRow {
  id: string; submitter_user_id: string; display_name: string; title: string; source: QuestSource; game: string | null;
  submitted_at: number; status: QuestStatus; moderation_status: QuestRecord['moderationStatus']; approved_at: number | null;
  activated_at: number | null; completed_at: number | null; expires_at: number | null; queued_next: number; updated_at: number;
}

interface PollRow {
  id: string; poll_type: 'chat' | 'quest'; question: string; options_json: string; status: PollStatus;
  starts_at: number; ends_at: number; ended_at: number | null; winner_option: number | null; tied: number;
  allow_vote_change: number; linked_quest_ids_json: string;
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
  'quest', 'quests', 'myquest', 'questhelp', 'questqueue', 'approvequest', 'rejectquest', 'skipquest', 'poll', 'vote', 'pollresults',
  'spark','sparks','sparkhelp','sparkapprove','sparkreject','sparkpause','sparkresume','sparktopics',
  'imposter','imposterstatus','joinimposter','leaveimposter','startimposter','closeimposter','cancelimposter','sus',
  'quoteoptin','quoteoptout','savequote','myquotes','deletequote','detektiv','startdetektiv','wer','quote','skipdetektiv','enddetektiv',
  'pet','feed','play','petcare','petstats','petname','pethelp','petevolution','setpetname','petpause','petresume',
  'claim','drop','dropstats','drops','startdrop','canceldrop','dropconfig','wheel','spin','wheelstatus','startwheel','cancelwheel','wheelpause','wheelresume',
]);

export class FeatureStore {
  private readonly db: BetterSqlite3.Database;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
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
    let currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0;
    if (currentVersion < 1) {
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
      currentVersion = 1;
    }
    if (currentVersion < 2) {
      if (currentVersion > 0) this.backupBeforeMigration(2);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE quests (
            id TEXT PRIMARY KEY,
            submitter_user_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 240),
            source TEXT NOT NULL CHECK(source IN ('chat','channel_points','dashboard')),
            game TEXT,
            source_event_id TEXT UNIQUE,
            redemption_id TEXT UNIQUE,
            submitted_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','approved','active','completed','failed','rejected','canceled')),
            moderation_status TEXT NOT NULL CHECK(moderation_status IN ('pending','approved','rejected','canceled')),
            moderated_by TEXT,
            approved_at INTEGER,
            activated_at INTEGER,
            completed_at INTEGER,
            expires_at INTEGER,
            queued_next INTEGER NOT NULL DEFAULT 0 CHECK(queued_next IN (0,1)),
            reward_xp INTEGER NOT NULL DEFAULT 0 CHECK(reward_xp >= 0),
            reward_granted_at INTEGER,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX quests_queue_order ON quests(status, submitted_at);
          CREATE INDEX quests_submitter_status ON quests(submitter_user_id, status, submitted_at);
          CREATE UNIQUE INDEX one_active_quest ON quests(status) WHERE status='active';
          CREATE UNIQUE INDEX one_selected_quest ON quests(queued_next) WHERE queued_next=1;
          CREATE TABLE quest_cooldowns (user_id TEXT PRIMARY KEY, last_submitted_at INTEGER NOT NULL);

          CREATE TABLE polls (
            id TEXT PRIMARY KEY,
            poll_type TEXT NOT NULL CHECK(poll_type IN ('chat','quest')),
            question TEXT NOT NULL CHECK(length(question) BETWEEN 3 AND 240),
            options_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','ended','canceled')),
            starts_at INTEGER NOT NULL,
            ends_at INTEGER NOT NULL,
            ended_at INTEGER,
            winner_option INTEGER,
            tied INTEGER NOT NULL DEFAULT 0 CHECK(tied IN (0,1)),
            allow_vote_change INTEGER NOT NULL DEFAULT 1 CHECK(allow_vote_change IN (0,1)),
            created_by TEXT NOT NULL,
            linked_quest_ids_json TEXT NOT NULL DEFAULT '[]'
          );
          CREATE UNIQUE INDEX one_active_poll ON polls(status) WHERE status='active';
          CREATE INDEX polls_history ON polls(starts_at DESC);
          CREATE TABLE poll_votes (
            poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            option_index INTEGER NOT NULL CHECK(option_index BETWEEN 0 AND 4),
            voted_at INTEGER NOT NULL,
            PRIMARY KEY(poll_id,user_id)
          );
          CREATE INDEX poll_votes_option ON poll_votes(poll_id,option_index);
          CREATE TABLE poll_vote_events (
            event_id TEXT PRIMARY KEY,
            poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );

          CREATE TABLE widget_tokens (
            id TEXT PRIMARY KEY,
            widget_type TEXT NOT NULL CHECK(widget_type IN ('quest','poll')),
            token_hash TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER
          );
          CREATE INDEX widget_tokens_active ON widget_tokens(widget_type,revoked_at,expires_at);
          INSERT OR IGNORE INTO feature_config(key,value) VALUES
            ('quest_settings','{"enabled":true,"chatEnabled":true,"channelPointsEnabled":false,"maxLength":180,"queueLimit":100,"maxOpenPerUser":2,"cooldownMs":300000,"modsCanModerate":false,"modsCanSkip":false,"moderatorUserIds":[],"completionXp":25,"activeDurationMs":0}'),
            ('poll_settings','{"enabled":true,"durationMs":60000,"allowVoteChange":true,"ignoredUserIds":[]}'),
            ('widget_settings','{"theme":"violet","fontSize":34}');
          UPDATE feature_config SET value=json_set(value,'$.quests',true,'$.polls',true) WHERE key='modules';
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (2, unixepoch()*1000);
        `);
      })();
    }
    if (currentVersion < 3) {
      if (currentVersion > 0) this.backupBeforeMigration(3);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE spark_proposals (
            id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, topic_id TEXT NOT NULL, topic_label TEXT NOT NULL,
            score INTEGER NOT NULL, participant_count INTEGER NOT NULL, message_count INTEGER NOT NULL,
            action_type TEXT NOT NULL CHECK(action_type IN ('poll','quest','challenge')),
            status TEXT NOT NULL CHECK(status IN ('detected','pending_approval','approved','rejected','expired','executed','canceled')),
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_by TEXT, rejection_reason TEXT
          );
          CREATE INDEX spark_proposals_status_time ON spark_proposals(status,created_at DESC);
          CREATE UNIQUE INDEX spark_one_open_topic ON spark_proposals(channel_id,topic_id) WHERE status IN ('detected','pending_approval','approved');
          CREATE TABLE spark_cooldowns (channel_id TEXT NOT NULL, topic_id TEXT NOT NULL, until_at INTEGER NOT NULL,
            PRIMARY KEY(channel_id,topic_id));
          INSERT OR IGNORE INTO feature_config(key,value) VALUES
            ('spark_settings','{"enabled":false,"paused":false,"windowMs":600000,"minParticipants":3,"minMessages":5,"minScore":12,"globalCooldownMs":1200000,"topicCooldownMs":3600000,"proposalTtlMs":1800000,"maxPending":5,"chatSuggestionsEnabled":false,"pauseDuringPolls":true,"metadataRetentionMs":604800000}');
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (3, unixepoch()*1000);
        `);
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 4) {
      if (currentVersion > 0) this.backupBeforeMigration(4);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE channel_point_redemptions (
          redemption_id TEXT PRIMARY KEY, reward_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL,
          user_input TEXT NOT NULL, redeemed_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','fulfilled','cancel_pending','fulfillment_pending','canceled','manual','failed')),
          quest_id TEXT REFERENCES quests(id), last_error TEXT, updated_at INTEGER NOT NULL
        );
        CREATE INDEX channel_point_redemptions_status_time ON channel_point_redemptions(status,redeemed_at DESC);
        INSERT OR IGNORE INTO feature_config(key,value) VALUES
          ('channel_points_settings','{"enabled":false,"rewardId":null,"rewardTitle":"Quest für Jannik 🎯","cost":2000,"fulfillOnApproval":true}');
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (4, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 5) {
      if (currentVersion > 0) this.backupBeforeMigration(5);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE imposter_rounds(id TEXT PRIMARY KEY, phase TEXT NOT NULL, rule_id TEXT, rule_text TEXT,
          imposter_id TEXT, started_at INTEGER NOT NULL, phase_ends_at INTEGER, result_json TEXT, updated_at INTEGER NOT NULL);
        CREATE UNIQUE INDEX one_live_imposter_round ON imposter_rounds((1)) WHERE phase IN ('registration','role_distribution','playing','voting');
        CREATE TABLE imposter_players(round_id TEXT NOT NULL REFERENCES imposter_rounds(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL, login TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
          PRIMARY KEY(round_id,user_id));
        CREATE TABLE imposter_votes(round_id TEXT NOT NULL REFERENCES imposter_rounds(id) ON DELETE CASCADE,
          voter_id TEXT NOT NULL, target_id TEXT NOT NULL, voted_at INTEGER NOT NULL, PRIMARY KEY(round_id,voter_id));
        CREATE TABLE detective_quotes(id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_login TEXT NOT NULL, author_name TEXT NOT NULL,
          text TEXT NOT NULL, submitted_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
          uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, expires_at INTEGER);
        CREATE INDEX detective_quotes_author ON detective_quotes(author_id,status);
        CREATE TABLE detective_rounds(id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES detective_quotes(id) ON DELETE CASCADE,
          phase TEXT NOT NULL, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, result_json TEXT, updated_at INTEGER NOT NULL);
        CREATE UNIQUE INDEX one_live_detective_round ON detective_rounds((1)) WHERE phase IN ('playing','results');
        CREATE TABLE detective_guesses(round_id TEXT NOT NULL REFERENCES detective_rounds(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL, display_name TEXT NOT NULL, target_id TEXT NOT NULL, guessed_at INTEGER NOT NULL,
          PRIMARY KEY(round_id,user_id));
        CREATE TABLE mini_game_awards(event_id TEXT PRIMARY KEY, game TEXT NOT NULL, round_id TEXT NOT NULL,
          user_id TEXT NOT NULL, xp INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE mini_game_consent(user_id TEXT PRIMARY KEY, opted_in_at INTEGER NOT NULL);
        INSERT OR IGNORE INTO feature_config(key,value) VALUES
          ('mini_game_settings','{"enabled":false,"imposter":{"minPlayers":4,"maxPlayers":20,"registrationMs":120000,"playMs":180000,"votingMs":45000,"cooldownMs":600000,"allowVoteChange":false,"noSelfVote":true,"winXp":20,"participationXp":5,"rules":[]},"detective":{"roundMs":30000,"quoteRetentionDays":90,"winXp":10,"dailyXpCap":50,"allowGuessChange":false}}');
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (5, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 6) {
      if (currentVersion === 5) this.backupBeforeMigration(6);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS widget_tokens (
          id TEXT PRIMARY KEY, widget_type TEXT NOT NULL CHECK(widget_type IN ('quest','poll')),
          token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER
        );
        CREATE TABLE widget_tokens_v6 (
          id TEXT PRIMARY KEY,
          widget_type TEXT NOT NULL CHECK(widget_type IN ('quest','poll','imposter','detective')),
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          revoked_at INTEGER
        );
        INSERT INTO widget_tokens_v6 SELECT * FROM widget_tokens;
        DROP TABLE widget_tokens;
        ALTER TABLE widget_tokens_v6 RENAME TO widget_tokens;
        CREATE INDEX widget_tokens_active ON widget_tokens(widget_type,revoked_at,expires_at);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (6, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 7) {
      if (currentVersion === 6) this.backupBeforeMigration(7);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS community_pet(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,level INTEGER NOT NULL DEFAULT 1 CHECK(level>=1),
          xp INTEGER NOT NULL DEFAULT 0 CHECK(xp>=0),hunger INTEGER NOT NULL DEFAULT 70 CHECK(hunger BETWEEN 0 AND 100),
          happiness INTEGER NOT NULL DEFAULT 70 CHECK(happiness BETWEEN 0 AND 100),energy INTEGER NOT NULL DEFAULT 70 CHECK(energy BETWEEN 0 AND 100),
          stage TEXT NOT NULL DEFAULT 'egg',paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),animation TEXT NOT NULL DEFAULT 'idle',updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS community_pet_interactions(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS pet_interactions_user_time ON community_pet_interactions(user_id,created_at);
        CREATE TABLE IF NOT EXISTS mystery_drops(id TEXT PRIMARY KEY,rarity TEXT NOT NULL,status TEXT NOT NULL,starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,
          result_json TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT 0,resolved_at INTEGER);
        CREATE UNIQUE INDEX IF NOT EXISTS mystery_one_open ON mystery_drops(status) WHERE status IN ('announced','claiming','resolving');
        CREATE TABLE IF NOT EXISTS mystery_claims(drop_id TEXT NOT NULL REFERENCES mystery_drops(id) ON DELETE CASCADE,user_id TEXT NOT NULL,display_name TEXT NOT NULL,
          claimed_at INTEGER NOT NULL,reward_xp INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(drop_id,user_id));
        CREATE TABLE IF NOT EXISTS chaos_wheel_challenges(id TEXT PRIMARY KEY,title TEXT NOT NULL,weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 1000),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
        CREATE TABLE IF NOT EXISTS chaos_wheel_spins(id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,resolved_at INTEGER);
        INSERT OR IGNORE INTO feature_config(key,value) VALUES
          ('arcade_settings','{"petEnabled":false,"dropsEnabled":false,"wheelEnabled":false,"autoDrops":false,"petCooldownMs":120000,"dropDurationMs":60000,"wheelCooldownMs":300000}');
        INSERT OR IGNORE INTO community_pet(id,name,updated_at) VALUES(1,'Fünkchen',unixepoch()*1000);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (7, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 8) {
      if (currentVersion === 7) this.backupBeforeMigration(8);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE widget_tokens_v8(id TEXT PRIMARY KEY,widget_type TEXT NOT NULL CHECK(widget_type IN ('quest','poll','imposter','detective','pet','drop','wheel')),
          token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER);
        INSERT INTO widget_tokens_v8 SELECT * FROM widget_tokens;
        DROP TABLE widget_tokens;
        ALTER TABLE widget_tokens_v8 RENAME TO widget_tokens;
        CREATE INDEX widget_tokens_active ON widget_tokens(widget_type,revoked_at,expires_at);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (8, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 9) {
      if (currentVersion > 0) this.backupBeforeMigration(9);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS first_chat_seen(user_id TEXT PRIMARY KEY,first_seen_at INTEGER NOT NULL);
        INSERT OR IGNORE INTO first_chat_seen(user_id,first_seen_at) SELECT user_id,updated_at FROM xp_users;
        INSERT OR IGNORE INTO feature_config(key,value) VALUES
          ('first_chat_welcome','{"enabled":false,"message":"Willkommen im Chat, {user}! 🎮 Schreib !help, wenn du die Community-Befehle sehen möchtest."}');
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (9, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 10) {
      if (currentVersion > 0) this.backupBeforeMigration(10);
      const challengeColumns = new Set((this.db.prepare('PRAGMA table_info(chaos_wheel_challenges)').all() as Array<{name:string}>).map((column)=>column.name));
      const spinColumns = new Set((this.db.prepare('PRAGMA table_info(chaos_wheel_spins)').all() as Array<{name:string}>).map((column)=>column.name));
      const dropColumns = new Set((this.db.prepare('PRAGMA table_info(mystery_drops)').all() as Array<{name:string}>).map((column)=>column.name));
      this.db.transaction(() => {
        if (!challengeColumns.has('action_type')) this.db.exec("ALTER TABLE chaos_wheel_challenges ADD COLUMN action_type TEXT NOT NULL DEFAULT 'manual_challenge' CHECK(action_type IN ('manual_challenge','start_mystery_drop','boost_pet'))");
        if (!spinColumns.has('action_type')) this.db.exec("ALTER TABLE chaos_wheel_spins ADD COLUMN action_type TEXT NOT NULL DEFAULT 'manual_challenge' CHECK(action_type IN ('manual_challenge','start_mystery_drop','boost_pet'))");
        if (!dropColumns.has('source_spin_id')) this.db.exec('ALTER TABLE mystery_drops ADD COLUMN source_spin_id TEXT');
        // One-time compatibility mapping for built-in rows created before wheel actions existed;
        // runtime execution uses only action_type, never challenge text.
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS mystery_drop_source_spin ON mystery_drops(source_spin_id) WHERE source_spin_id IS NOT NULL;
          UPDATE chaos_wheel_challenges SET action_type='start_mystery_drop' WHERE title='Mystery Drop für den Chat' AND action_type='manual_challenge';
          UPDATE chaos_wheel_challenges SET action_type='boost_pet' WHERE title='Der Drache bekommt einen Energieschub!' AND action_type='manual_challenge';
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (10, unixepoch()*1000);
        `);
      })();
    }
  }

  private backupBeforeMigration(version: number): void {
    if (this.filePath === ':memory:' || !fs.existsSync(this.filePath) || fs.statSync(this.filePath).size === 0) return;
    const backupDirectory = path.resolve(path.dirname(this.filePath), '..', 'backups');
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(backupDirectory, `before-feature-migration-v${version}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}.sqlite`);
    const quoted = destination.replace(/'/gu, "''");
    this.db.exec(`VACUUM INTO '${quoted}'`);
    fs.chmodSync(destination, 0o600);
  }

  /** Shared connection for feature modules; all mutations must remain transactional. */
  miniGameTransaction<T>(operation: (db: BetterSqlite3.Database) => T): T { return this.db.transaction(() => operation(this.db))(); }
  miniGameQuery<T>(operation: (db: BetterSqlite3.Database) => T): T { return operation(this.db); }

  config<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM feature_config WHERE key=?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }

  setConfig(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO feature_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  markFirstChat(userId:string,now:number,retentionMs=31_536_000_000):boolean {
    return this.db.transaction(()=>{
      this.db.prepare('DELETE FROM first_chat_seen WHERE first_seen_at<?').run(now-retentionMs);
      return this.db.prepare('INSERT OR IGNORE INTO first_chat_seen(user_id,first_seen_at) VALUES(?,?)').run(userId,now).changes===1;
    })();
  }

  createSparkProposal(input: Omit<SparkProposal, 'status' | 'decidedBy' | 'rejectionReason'>, maxPending: number,
    globalCooldownMs: number, topicCooldownMs: number): SparkProposal | undefined {
    return this.db.transaction(() => {
      this.expireSparkProposals(input.createdAt);
      const open = this.db.prepare("SELECT 1 FROM spark_proposals WHERE channel_id=? AND topic_id=? AND status IN ('detected','pending_approval','approved')").get(input.channelId, input.topicId);
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM spark_proposals WHERE status='pending_approval'").get() as { count: number };
      const cooldown = this.db.prepare('SELECT until_at FROM spark_cooldowns WHERE channel_id=? AND topic_id IN (?,\'*\') AND until_at>? ORDER BY until_at DESC LIMIT 1')
        .get(input.channelId, input.topicId, input.createdAt) as { until_at: number } | undefined;
      if (open || pending.count >= maxPending || cooldown) return undefined;
      this.db.prepare(`INSERT INTO spark_proposals(id,channel_id,topic_id,topic_label,score,participant_count,message_count,action_type,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,'pending_approval',?,?)`).run(input.id,input.channelId,input.topicId,input.topicLabel,input.score,
          input.participants,input.messages,input.actionType,input.createdAt,input.expiresAt);
      this.db.prepare(`INSERT INTO spark_cooldowns(channel_id,topic_id,until_at) VALUES(?,?,?) ON CONFLICT(channel_id,topic_id)
        DO UPDATE SET until_at=excluded.until_at`).run(input.channelId, input.topicId, input.createdAt + topicCooldownMs);
      this.db.prepare(`INSERT INTO spark_cooldowns(channel_id,topic_id,until_at) VALUES(?,'*',?) ON CONFLICT(channel_id,topic_id)
        DO UPDATE SET until_at=MAX(until_at,excluded.until_at)`).run(input.channelId, input.createdAt + globalCooldownMs);
      this.recordCommunityEvent('spark.proposal.created',{id:input.id,topicId:input.topicId,actionType:input.actionType},input.createdAt);
      return { ...input, status:'pending_approval' as const, decidedBy:null, rejectionReason:null };
    })();
  }

  sparkProposals(status: SparkStatus | 'all' = 'all', limit = 50): SparkProposal[] {
    const rows = this.db.prepare(`SELECT * FROM spark_proposals WHERE (?='all' OR status=?) ORDER BY created_at DESC LIMIT ?`)
      .all(status,status,Math.max(1,Math.min(100,limit))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id:String(r.id),channelId:String(r.channel_id),topicId:String(r.topic_id),topicLabel:String(r.topic_label),
      score:Number(r.score),participants:Number(r.participant_count),messages:Number(r.message_count),actionType:r.action_type as SparkProposal['actionType'],
      status:r.status as SparkStatus,createdAt:Number(r.created_at),expiresAt:Number(r.expires_at),decidedBy:r.decided_by ? String(r.decided_by) : null,
      rejectionReason:r.rejection_reason ? String(r.rejection_reason) : null }));
  }

  sparkProposal(id: string): SparkProposal | undefined { return this.sparkProposals('all',100).find((proposal) => proposal.id === id); }

  decideSparkProposal(id: string, status: Extract<SparkStatus,'approved'|'rejected'|'expired'|'executed'|'canceled'>,
    actorId: string | null, now: number, reason: string | null = null): boolean {
    const proposal = this.sparkProposal(id);
    if (!proposal || proposal.expiresAt <= now) { if (proposal) this.expireSparkProposals(now); return false; }
    const allowed: Record<typeof status, SparkStatus[]> = {
      approved:['pending_approval'], rejected:['pending_approval','approved'], expired:['pending_approval','approved'],
      executed:['approved'], canceled:['pending_approval','approved'],
    };
    if (!allowed[status].includes(proposal.status)) return false;
    const changed = this.db.prepare('UPDATE spark_proposals SET status=?,decided_by=?,rejection_reason=? WHERE id=? AND status=? AND expires_at>?')
      .run(status,actorId,reason,id,proposal.status,now).changes > 0;
    if (changed) this.recordCommunityEvent(`spark.proposal.${status}`,{id,topicId:proposal.topicId},now);
    return changed;
  }

  expireSparkProposals(now: number): number {
    return this.db.prepare("UPDATE spark_proposals SET status='expired' WHERE status IN ('pending_approval','approved') AND expires_at<=?").run(now).changes;
  }

  pruneSparkMetadata(now: number, retentionMs: number): number {
    return this.db.prepare("DELETE FROM spark_proposals WHERE status IN ('rejected','expired','executed','canceled') AND created_at<?")
      .run(now - retentionMs).changes;
  }

  sparkCooldowns(now: number): Array<{ channelId: string; topicId: string; untilAt: number }> {
    return (this.db.prepare('SELECT channel_id,topic_id,until_at FROM spark_cooldowns WHERE until_at>?').all(now) as Array<{channel_id:string;topic_id:string;until_at:number}>)
      .map((r) => ({channelId:r.channel_id,topicId:r.topic_id,untilAt:r.until_at}));
  }

  submitQuest(input: QuestSubmission, policy: QuestPolicy, now: number): QuestSubmitResult {
    return this.db.transaction(() => {
      if (input.sourceEventId && this.db.prepare('SELECT 1 FROM quests WHERE source_event_id=?').get(input.sourceEventId)) {
        return { ok: false as const, reason: 'duplicate' as const };
      }
      if (input.redemptionId && this.db.prepare('SELECT 1 FROM quests WHERE redemption_id=?').get(input.redemptionId)) {
        return { ok: false as const, reason: 'duplicate' as const };
      }
      const open = this.db.prepare("SELECT COUNT(*) AS count FROM quests WHERE submitter_user_id=? AND status IN ('pending','approved','active')")
        .get(input.submitterUserId) as { count: number };
      if (open.count >= policy.maxOpenPerUser) return { ok: false as const, reason: 'user-limit' as const };
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM quests WHERE status='pending'").get() as { count: number };
      if (pending.count >= policy.queueLimit) return { ok: false as const, reason: 'queue-limit' as const };
      const cooldown = this.db.prepare('SELECT last_submitted_at FROM quest_cooldowns WHERE user_id=?').get(input.submitterUserId) as { last_submitted_at: number } | undefined;
      if (cooldown && now - cooldown.last_submitted_at < policy.cooldownMs) {
        return { ok: false as const, reason: 'cooldown' as const, remainingMs: policy.cooldownMs - (now - cooldown.last_submitted_at) };
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO quests(id,submitter_user_id,display_name,title,source,game,source_event_id,redemption_id,
        submitted_at,status,moderation_status,reward_xp,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending','pending',?,?)`)
        .run(id, input.submitterUserId, input.displayName, input.title, input.source, input.game ?? null,
          input.sourceEventId ?? null, input.redemptionId ?? null, now, policy.completionXp, now);
      this.db.prepare(`INSERT INTO quest_cooldowns(user_id,last_submitted_at) VALUES(?,?)
        ON CONFLICT(user_id) DO UPDATE SET last_submitted_at=excluded.last_submitted_at`).run(input.submitterUserId, now);
      const quest = this.quest(id)!;
      this.recordCommunityEvent('quest.submitted', { id, source: input.source, status: 'pending' }, now);
      return { ok: true as const, quest };
    })();
  }

  acceptChannelRedemption(input: { redemptionId:string; rewardId:string; userId:string; displayName:string; userInput:string; redeemedAt:number },
    policy:QuestPolicy, now:number): { duplicate:true } | { duplicate:false; result:QuestSubmitResult } {
    return this.db.transaction(() => {
      const inserted=this.db.prepare(`INSERT OR IGNORE INTO channel_point_redemptions(redemption_id,reward_id,user_id,display_name,user_input,
        redeemed_at,status,updated_at) VALUES(?,?,?,?,?,?,'failed',?)`).run(input.redemptionId,input.rewardId,input.userId,input.displayName,input.userInput,input.redeemedAt,now);
      if (!inserted.changes) return {duplicate:true as const};
      const result=this.submitQuest({submitterUserId:input.userId,displayName:input.displayName,title:input.userInput,source:'channel_points',redemptionId:input.redemptionId},policy,now);
      if (result.ok) this.db.prepare("UPDATE channel_point_redemptions SET status='pending',quest_id=?,user_input='',last_error=NULL,updated_at=? WHERE redemption_id=?")
        .run(result.quest.id,now,input.redemptionId);
      else this.db.prepare('UPDATE channel_point_redemptions SET last_error=?,updated_at=? WHERE redemption_id=?')
        .run(`Quest konnte nicht angenommen werden: ${result.reason}`,now,input.redemptionId);
      return {duplicate:false as const,result};
    })();
  }

  recordManualChannelRedemption(input:{redemptionId:string;rewardId:string;userId:string;displayName:string;userInput:string;redeemedAt:number},reason:string,now:number):boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO channel_point_redemptions(redemption_id,reward_id,user_id,display_name,user_input,redeemed_at,status,last_error,updated_at)
      VALUES(?,?,?,?,?,?,'manual',?,?)`).run(input.redemptionId,input.rewardId,input.userId,input.displayName,
        Array.from(input.userInput).slice(0,500).join(''),input.redeemedAt,reason.slice(0,240),now).changes>0;
  }

  retryChannelRedemption(redemptionId:string,policy:QuestPolicy,now:number):QuestSubmitResult|undefined {
    return this.db.transaction(() => {
      const row=this.db.prepare("SELECT * FROM channel_point_redemptions WHERE redemption_id=? AND status IN ('failed','manual')")
        .get(redemptionId) as Record<string,unknown>|undefined;
      if(!row)return undefined;
      const result=this.submitQuest({submitterUserId:String(row.user_id),displayName:String(row.display_name),title:String(row.user_input),
        source:'channel_points',redemptionId},policy,now);
      if(result.ok)this.db.prepare("UPDATE channel_point_redemptions SET status='pending',quest_id=?,user_input='',last_error=NULL,updated_at=? WHERE redemption_id=?")
        .run(result.quest.id,now,redemptionId);
      else this.db.prepare('UPDATE channel_point_redemptions SET last_error=?,updated_at=? WHERE redemption_id=?')
        .run(`Quest konnte nicht angenommen werden: ${result.reason}`,now,redemptionId);
      return result;
    })();
  }

  channelRedemption(redemptionId:string):ChannelRedemptionRecord|undefined {
    const row=this.db.prepare('SELECT r.*,q.title AS quest_title,q.status AS quest_status FROM channel_point_redemptions r LEFT JOIN quests q ON q.id=r.quest_id WHERE r.redemption_id=?').get(redemptionId) as Record<string,unknown>|undefined;
    return row?toChannelRedemption(row):undefined;
  }

  channelRedemptionForQuest(questId:string):ChannelRedemptionRecord|undefined {
    const row=this.db.prepare('SELECT r.*,q.title AS quest_title,q.status AS quest_status FROM channel_point_redemptions r LEFT JOIN quests q ON q.id=r.quest_id WHERE r.quest_id=?').get(questId) as Record<string,unknown>|undefined;
    return row?toChannelRedemption(row):undefined;
  }

  channelRedemptions(limit=100):ChannelRedemptionRecord[] {
    return (this.db.prepare('SELECT r.*,q.title AS quest_title,q.status AS quest_status FROM channel_point_redemptions r LEFT JOIN quests q ON q.id=r.quest_id ORDER BY r.redeemed_at DESC LIMIT ?').all(Math.max(1,Math.min(500,limit))) as Array<Record<string,unknown>>).map(toChannelRedemption);
  }

  updateChannelRedemption(redemptionId:string,status:ChannelRedemptionStatus,lastError:string|null,now:number):boolean {
    return this.db.prepare('UPDATE channel_point_redemptions SET status=?,last_error=?,updated_at=? WHERE redemption_id=?')
      .run(status,lastError,now,redemptionId).changes>0;
  }

  quest(id: string): QuestRecord | undefined {
    const row = this.db.prepare('SELECT * FROM quests WHERE id=?').get(id) as QuestRow | undefined;
    return row ? this.toQuest(row) : undefined;
  }

  listQuests(filter: QuestStatus | 'all' = 'all', query = '', limit = 100): QuestRecord[] {
    const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
    const search = query.trim().slice(0, 80);
    const rows = this.db.prepare(`SELECT * FROM quests
      WHERE (?='all' OR status=?) AND (?='' OR lower(title) LIKE lower(?) OR lower(display_name) LIKE lower(?) OR id LIKE ?)
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
        queued_next DESC, submitted_at ASC LIMIT ?`)
      .all(filter, filter, search, `%${search}%`, `%${search}%`, `%${search}%`, safeLimit) as QuestRow[];
    return rows.map((row) => this.toQuest(row));
  }

  lastQuestForUser(userId: string): QuestRecord | undefined {
    const row = this.db.prepare('SELECT * FROM quests WHERE submitter_user_id=? ORDER BY submitted_at DESC LIMIT 1').get(userId) as QuestRow | undefined;
    return row ? this.toQuest(row) : undefined;
  }

  findPendingQuestByPrefix(prefix: string): QuestRecord | undefined {
    if (!/^[a-f0-9-]{4,36}$/iu.test(prefix)) return undefined;
    const rows = this.db.prepare("SELECT * FROM quests WHERE status='pending' AND lower(id) LIKE lower(?) LIMIT 2")
      .all(`${prefix}%`) as QuestRow[];
    return rows.length === 1 ? this.toQuest(rows[0]!) : undefined;
  }

  activeQuest(): QuestRecord | undefined {
    const row = this.db.prepare("SELECT * FROM quests WHERE status='active' LIMIT 1").get() as QuestRow | undefined;
    return row ? this.toQuest(row) : undefined;
  }

  approvedQuests(limit = 50): QuestRecord[] {
    const rows = this.db.prepare("SELECT * FROM quests WHERE status='approved' ORDER BY queued_next DESC, submitted_at ASC LIMIT ?")
      .all(Math.max(1, Math.min(100, limit))) as QuestRow[];
    return rows.map((row) => this.toQuest(row));
  }

  questSummary(): Record<string, number> {
    const rows = this.db.prepare('SELECT status,COUNT(*) AS count FROM quests GROUP BY status').all() as Array<{ status: QuestStatus; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  editQuest(id: string, title: string, game: string | null, actorId: string, now: number): boolean {
    if (!title.trim() || title.length > 240 || (game !== null && game.length > 80)) return false;
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT status FROM quests WHERE id=? AND status IN ('pending','approved')").get(id) as { status: QuestStatus } | undefined;
      if (!row) return false;
      this.db.prepare('UPDATE quests SET title=?,game=?,updated_at=? WHERE id=?').run(title, game, now, id);
      this.adminAudit(actorId, 'quest-edit', id, { game }, now);
      this.recordCommunityEvent('quest.edited', { id, status: row.status }, now);
      return true;
    })();
  }

  selectNextQuest(id: string, actorId: string, now: number): boolean {
    return this.db.transaction(() => {
      const quest = this.db.prepare("SELECT status FROM quests WHERE id=?").get(id) as { status: QuestStatus } | undefined;
      if (!quest || quest.status !== 'approved') return false;
      this.db.prepare('UPDATE quests SET queued_next=0,updated_at=? WHERE queued_next=1').run(now);
      this.db.prepare('UPDATE quests SET queued_next=1,updated_at=? WHERE id=? AND status=\'approved\'').run(now, id);
      this.adminAudit(actorId, 'quest-select-next', id, {}, now);
      this.recordCommunityEvent('quest.next.selected', { id }, now);
      return true;
    })();
  }

  transitionQuest(id: string, target: QuestStatus, actorId: string, now: number, policy: QuestPolicy): QuestTransitionResult {
    const allowed: Record<QuestStatus, QuestStatus[]> = {
      pending: ['approved', 'rejected', 'canceled'], approved: ['active', 'rejected', 'canceled'],
      active: ['completed', 'failed', 'canceled'], completed: [], failed: [], rejected: [], canceled: [],
    };
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM quests WHERE id=?').get(id) as QuestRow | undefined;
      if (!row) return { ok: false as const, reason: 'missing' as const };
      const current = this.toQuest(row);
      if (!allowed[current.status].includes(target)) return { ok: false as const, reason: 'invalid-transition' as const };
      if (target === 'active') {
        const another = this.db.prepare("SELECT 1 FROM quests WHERE status='active' AND id<>? LIMIT 1").get(id);
        if (another) return { ok: false as const, reason: 'active-exists' as const };
        if (current.status !== 'approved') return { ok: false as const, reason: 'not-approved' as const };
      }
      const moderation = target === 'approved' || target === 'active' || target === 'completed' || target === 'failed'
        ? 'approved' : target === 'rejected' ? 'rejected' : target === 'canceled' ? 'canceled' : 'pending';
      const expiresAt = target === 'active' && policy.activeDurationMs > 0 ? now + policy.activeDurationMs : null;
      const changed = this.db.prepare(`UPDATE quests SET status=?,moderation_status=?,moderated_by=?,
        approved_at=CASE WHEN ?='approved' AND approved_at IS NULL THEN ? ELSE approved_at END,
        activated_at=CASE WHEN ?='active' THEN ? ELSE activated_at END,
        completed_at=CASE WHEN ? IN ('completed','failed','canceled') THEN ? ELSE completed_at END,
        expires_at=?,queued_next=CASE WHEN ?='active' THEN 0 ELSE queued_next END,updated_at=?
        WHERE id=? AND status=?`).run(target, moderation, actorId,
        target, now, target, now, target, now, expiresAt, target, now, id, current.status);
      if (!changed.changes) return { ok: false as const, reason: 'invalid-transition' as const };
      let rewardedXp = 0;
      if (target === 'completed' && policy.completionXp > 0) {
        rewardedXp = this.awardXpInside(`quest:${id}:completion`, current.submitterUserId, current.displayName,
          policy.completionXp, 'quest:completion', now);
        if (rewardedXp > 0) this.db.prepare('UPDATE quests SET reward_granted_at=? WHERE id=?').run(now, id);
      }
      const finalQuest = this.quest(id)!;
      this.adminAudit(actorId, `quest-${target}`, id, { rewardedXp }, now);
      this.recordCommunityEvent('quest.status.changed', { id, status: target, title: target === 'active' ? current.title : undefined,
        displayName: target === 'active' ? current.displayName : undefined, game: target === 'active' ? current.game : undefined,
        rewardedXp }, now);
      return { ok: true as const, quest: finalQuest, rewardedXp };
    })();
  }

  expireQuests(now: number): number {
    return this.db.transaction(() => {
      const expired = this.db.prepare("SELECT id FROM quests WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?").all(now) as Array<{ id: string }>;
      for (const { id } of expired) {
        this.db.prepare("UPDATE quests SET status='failed',completed_at=?,updated_at=? WHERE id=? AND status='active'").run(now, now, id);
        this.recordCommunityEvent('quest.status.changed', { id, status: 'failed', reason: 'expired' }, now);
      }
      return expired.length;
    })();
  }

  createPoll(input: PollCreateInput): PollRecord | undefined {
    const id = input.id || randomUUID();
    if (!validViewerText(input.question, 240) || input.options.length < 2 || input.options.length > 5
      || input.options.some((option) => !validViewerText(option.label, 100, 1))
      || !Number.isSafeInteger(input.durationMs) || input.durationMs < 10_000 || input.durationMs > 86_400_000) return undefined;
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM polls WHERE status='active'").get()) return undefined;
      const linkedIds = input.options.map((option) => option.questId).filter((value): value is string => Boolean(value));
      if (input.type === 'quest' && (linkedIds.length !== input.options.length || new Set(linkedIds).size !== linkedIds.length)) return undefined;
      if (input.type === 'quest') {
        const placeholders = linkedIds.map(() => '?').join(',');
        const approved = this.db.prepare(`SELECT COUNT(*) AS count FROM quests WHERE status='approved' AND id IN (${placeholders})`).get(...linkedIds) as { count: number };
        if (approved.count !== linkedIds.length) return undefined;
      } else if (linkedIds.length) return undefined;
      this.db.prepare(`INSERT INTO polls(id,poll_type,question,options_json,status,starts_at,ends_at,allow_vote_change,created_by,linked_quest_ids_json)
        VALUES(?,?,?,?,'active',?,?,?,?,?)`)
        .run(id, input.type, input.question, JSON.stringify(input.options), input.now, input.now + input.durationMs,
          input.allowVoteChange ? 1 : 0, input.createdBy, JSON.stringify(linkedIds));
      this.recordCommunityEvent('poll.started', { id, type: input.type }, input.now);
      return this.poll(id);
    })();
  }

  activePoll(now = Date.now()): PollRecord | undefined {
    this.finishExpiredPolls(now);
    const row = this.db.prepare("SELECT * FROM polls WHERE status='active' LIMIT 1").get() as PollRow | undefined;
    return row ? this.toPoll(row) : undefined;
  }

  poll(id: string): PollRecord | undefined {
    const row = this.db.prepare('SELECT * FROM polls WHERE id=?').get(id) as PollRow | undefined;
    return row ? this.toPoll(row) : undefined;
  }

  pollHistory(limit = 25): PollRecord[] {
    const rows = this.db.prepare('SELECT * FROM polls ORDER BY starts_at DESC LIMIT ?').all(Math.max(1, Math.min(100, limit))) as PollRow[];
    return rows.map((row) => this.toPoll(row));
  }

  vote(pollId: string, userId: string, displayName: string, optionNumber: number, eventId: string, now: number,
    ignoredUserIds: string[] = []): PollVoteResult {
    return this.db.transaction(() => {
      if (ignoredUserIds.includes(userId)) return { ok: false as const, reason: 'ignored' as const };
      const pollRow = this.db.prepare('SELECT * FROM polls WHERE id=?').get(pollId) as PollRow | undefined;
      if (!pollRow || pollRow.status !== 'active') return { ok: false as const, reason: 'missing' as const };
      if (pollRow.ends_at <= now) { this.finishPollInside(pollId, now); return { ok: false as const, reason: 'ended' as const }; }
      const options = parsePollOptions(pollRow.options_json);
      if (!Number.isInteger(optionNumber) || optionNumber < 1 || optionNumber > options.length) return { ok: false as const, reason: 'invalid-option' as const };
      const event = this.db.prepare('INSERT OR IGNORE INTO poll_vote_events(event_id,poll_id,user_id,created_at) VALUES(?,?,?,?)')
        .run(eventId, pollId, userId, now);
      if (!event.changes) return { ok: false as const, reason: 'duplicate' as const };
      const existing = this.db.prepare('SELECT option_index FROM poll_votes WHERE poll_id=? AND user_id=?').get(pollId, userId) as { option_index: number } | undefined;
      if (existing && pollRow.allow_vote_change === 0) return { ok: false as const, reason: 'already-voted' as const };
      this.db.prepare(`INSERT INTO poll_votes(poll_id,user_id,display_name,option_index,voted_at) VALUES(?,?,?,?,?)
        ON CONFLICT(poll_id,user_id) DO UPDATE SET display_name=excluded.display_name,option_index=excluded.option_index,voted_at=excluded.voted_at`)
        .run(pollId, userId, displayName, optionNumber - 1, now);
      this.recordCommunityEvent(existing ? 'poll.vote.changed' : 'poll.vote.added', { id: pollId }, now);
      return { ok: true as const, poll: this.poll(pollId)!, changed: Boolean(existing) };
    })();
  }

  endPoll(id: string, now: number, canceled = false): PollRecord | undefined {
    return this.db.transaction(() => {
      const poll = this.db.prepare("SELECT id,status FROM polls WHERE id=? AND status='active'").get(id) as { id: string; status: PollStatus } | undefined;
      if (!poll) return this.poll(id);
      if (canceled) {
        this.db.prepare("UPDATE polls SET status='canceled',ended_at=? WHERE id=? AND status='active'").run(now, id);
        this.recordCommunityEvent('poll.canceled', { id }, now);
      } else this.finishPollInside(id, now);
      return this.poll(id);
    })();
  }

  finishExpiredPolls(now: number): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM polls WHERE status='active' AND ends_at<=?").all(now) as Array<{ id: string }>;
      for (const row of rows) this.finishPollInside(row.id, now);
      return rows.length;
    })();
  }

  choosePollWinner(id: string, optionNumber: number, actorId: string, now: number): boolean {
    return this.db.transaction(() => {
      const poll = this.db.prepare("SELECT * FROM polls WHERE id=? AND status='ended'").get(id) as PollRow | undefined;
      if (!poll) return false;
      const options = parsePollOptions(poll.options_json);
      if (!Number.isInteger(optionNumber) || optionNumber < 1 || optionNumber > options.length) return false;
      const option = options[optionNumber - 1];
      if (poll.poll_type === 'quest') {
        const quest = option?.questId ? this.quest(option.questId) : undefined;
        if (!quest || quest.status !== 'approved') return false;
        this.db.prepare('UPDATE quests SET queued_next=0,updated_at=? WHERE queued_next=1').run(now);
        this.db.prepare("UPDATE quests SET queued_next=1,updated_at=? WHERE id=? AND status='approved'").run(now, quest.id);
      }
      this.db.prepare('UPDATE polls SET winner_option=?,tied=0 WHERE id=? AND status=\'ended\'').run(optionNumber - 1, id);
      this.adminAudit(actorId, 'poll-winner-manual', id, { optionNumber }, now);
      this.recordCommunityEvent('poll.winner.selected', { id, optionNumber }, now);
      return true;
    })();
  }

  rotateWidgetToken(type: WidgetType, tokenHash: string, now: number, actorId: string): string {
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare('UPDATE widget_tokens SET revoked_at=? WHERE widget_type=? AND revoked_at IS NULL').run(now, type);
      this.db.prepare('INSERT INTO widget_tokens(id,widget_type,token_hash,created_at) VALUES(?,?,?,?)').run(id, type, tokenHash, now);
      this.adminAudit(actorId, 'widget-token-rotated', type, {}, now);
    })();
    return id;
  }

  revokeWidgetToken(type: WidgetType, now: number, actorId: string): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare('UPDATE widget_tokens SET revoked_at=? WHERE widget_type=? AND revoked_at IS NULL').run(now, type);
      if (result.changes) this.adminAudit(actorId, 'widget-token-revoked', type, {}, now);
      return result.changes > 0;
    })();
  }

  widgetTokenValid(type: WidgetType, tokenHash: string, now: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM widget_tokens WHERE widget_type=? AND token_hash=? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>?)`).get(type, tokenHash, now));
  }

  widgetTokenConfigured(type: WidgetType, now: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM widget_tokens WHERE widget_type=? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>?) LIMIT 1`).get(type, now));
  }

  widgetSnapshot(type: WidgetType, now: number): Record<string, unknown> {
    if (type === 'imposter') {
      const row = this.db.prepare("SELECT id,phase,phase_ends_at,result_json,updated_at FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting','results','finished') ORDER BY updated_at DESC LIMIT 1").get() as {id:string;phase:string;phase_ends_at:number|null;result_json:string|null;updated_at:number}|undefined;
      if (!row || (row.phase === 'finished' && now - row.updated_at>12_000)) return {type,visible:false,capturedAt:now};
      const count=(this.db.prepare('SELECT COUNT(*) n FROM imposter_players WHERE round_id=?').get(row.id) as {n:number}).n;
      const votes=(this.db.prepare('SELECT COUNT(*) n FROM imposter_votes WHERE round_id=?').get(row.id) as {n:number}).n;
      let result:Record<string,unknown>|null=null;
      if((row.phase==='results'||row.phase==='finished')&&row.result_json){const stored=JSON.parse(row.result_json) as {caught:boolean;neutral:boolean;imposterId:string;rule:string;tie:boolean;votes:number};
        const player=this.db.prepare('SELECT display_name FROM imposter_players WHERE round_id=? AND user_id=?').get(row.id,stored.imposterId) as {display_name:string}|undefined;
        result={caught:stored.caught,neutral:stored.neutral,imposterName:player?.display_name||'Unbekannt',rule:stored.rule,tie:stored.tie,votes:stored.votes};}
      return {type,visible:true,game:{phase:row.phase,participants:count,votes,endsAt:row.phase_ends_at,result},capturedAt:now};
    }
    if (type === 'detective') {
      const row=this.db.prepare("SELECT r.phase,r.ends_at,r.updated_at,q.text,r.result_json FROM detective_rounds r JOIN detective_quotes q ON q.id=r.quote_id WHERE r.phase IN ('playing','results','finished') ORDER BY r.updated_at DESC LIMIT 1").get() as {phase:string;ends_at:number;updated_at:number;text:string;result_json:string|null}|undefined;
      if(!row||(row.phase==='finished'&&now-row.updated_at>12_000))return {type,visible:false,capturedAt:now};
      const guesses=(this.db.prepare("SELECT COUNT(*) n FROM detective_guesses g JOIN detective_rounds r ON r.id=g.round_id WHERE r.phase IN ('playing','finished') AND r.updated_at=(SELECT MAX(updated_at) FROM detective_rounds)").get() as {n:number}).n;
      let result:Record<string,unknown>|null=null;if((row.phase==='results'||row.phase==='finished')&&row.result_json){const stored=JSON.parse(row.result_json) as {authorName:string;winners:Array<{display_name:string}>};result={authorName:stored.authorName,winners:stored.winners.map(w=>w.display_name)};}
      return {type,visible:true,game:{phase:row.phase,text:row.text,endsAt:row.ends_at,guesses,result},capturedAt:now};
    }
    if (type === 'quest') {
      const active = this.activeQuest();
      if (active) return { type, visible: true, quest: publicQuest(active), capturedAt: now };
      const recent = this.db.prepare("SELECT * FROM quests WHERE status IN ('completed','failed','canceled') AND updated_at>=? ORDER BY updated_at DESC LIMIT 1")
        .get(now - 12_000) as QuestRow | undefined;
      return { type, visible: Boolean(recent), quest: recent ? publicQuest(this.toQuest(recent)) : null, capturedAt: now };
    }
    const activePoll = this.activePoll(now);
    if (activePoll) return { type, visible: true, poll: publicPoll(activePoll), capturedAt: now };
    const recent = this.db.prepare("SELECT * FROM polls WHERE status='ended' AND ended_at>=? ORDER BY ended_at DESC LIMIT 1")
      .get(now - 15_000) as PollRow | undefined;
    return { type, visible: Boolean(recent), poll: recent ? publicPoll(this.toPoll(recent)) : null, capturedAt: now };
  }

  private finishPollInside(id: string, now: number): void {
    const row = this.db.prepare("SELECT * FROM polls WHERE id=? AND status='active'").get(id) as PollRow | undefined;
    if (!row) return;
    const options = parsePollOptions(row.options_json);
    const counts = this.db.prepare('SELECT option_index,COUNT(*) AS count FROM poll_votes WHERE poll_id=? GROUP BY option_index').all(id) as Array<{ option_index: number; count: number }>;
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    const maxVotes = Math.max(0, ...counts.map((entry) => entry.count));
    const leaders = total ? counts.filter((entry) => entry.count === maxVotes) : [];
    const winner = leaders.length === 1 ? leaders[0]!.option_index : null;
    const tied = leaders.length > 1;
    const changed = this.db.prepare(`UPDATE polls SET status='ended',ended_at=?,winner_option=?,tied=? WHERE id=? AND status='active'`)
      .run(now, winner, tied ? 1 : 0, id);
    if (!changed.changes) return;
    if (row.poll_type === 'quest' && winner !== null) {
      const option = options[winner];
      if (option?.questId) {
        this.db.prepare('UPDATE quests SET queued_next=0,updated_at=? WHERE queued_next=1').run(now);
        this.db.prepare("UPDATE quests SET queued_next=1,updated_at=? WHERE id=? AND status='approved'").run(now, option.questId);
      }
    }
    this.recordCommunityEvent('poll.ended', { id, totalVotes: total, winnerOption: winner, tied }, now);
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
    const rows = this.db.prepare("SELECT user_id,display_name,xp FROM xp_users WHERE ?='' OR lower(user_id) LIKE lower(?) OR lower(display_name) LIKE lower(?) ORDER BY xp DESC LIMIT ?")
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

  private toQuest(row: QuestRow): QuestRecord {
    return { id: row.id, submitterUserId: row.submitter_user_id, displayName: row.display_name, title: row.title,
      source: row.source, game: row.game, submittedAt: row.submitted_at, status: row.status,
      moderationStatus: row.moderation_status, approvedAt: row.approved_at, activatedAt: row.activated_at,
      completedAt: row.completed_at, expiresAt: row.expires_at, queuedNext: row.queued_next === 1, updatedAt: row.updated_at };
  }

  private toPoll(row: PollRow): PollRecord {
    const baseOptions = parsePollOptions(row.options_json);
    const counts = this.db.prepare('SELECT option_index,COUNT(*) AS count FROM poll_votes WHERE poll_id=? GROUP BY option_index').all(row.id) as
      Array<{ option_index: number; count: number }>;
    const countByOption = new Map(counts.map((entry) => [entry.option_index, entry.count]));
    const totalVotes = counts.reduce((sum, entry) => sum + entry.count, 0);
    const options: PollOptionResult[] = baseOptions.map((option, index) => {
      const votes = countByOption.get(index) ?? 0;
      return { label: option.label, votes, percent: totalVotes ? Math.round((votes / totalVotes) * 100) : 0,
        ...(option.questId ? { questId: option.questId } : {}) };
    });
    return { id: row.id, type: row.poll_type, question: row.question, options, status: row.status,
      startsAt: row.starts_at, endsAt: row.ends_at, endedAt: row.ended_at, winnerOption: row.winner_option,
      tied: row.tied === 1, allowVoteChange: row.allow_vote_change === 1, totalVotes };
  }

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

function parsePollOptions(value: string): PollOptionInput[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PollOptionInput => Boolean(entry) && typeof entry === 'object'
      && typeof (entry as PollOptionInput).label === 'string'
      && (!('questId' in (entry as object)) || typeof (entry as PollOptionInput).questId === 'string'));
  } catch { return []; }
}

function toChannelRedemption(row:Record<string,unknown>):ChannelRedemptionRecord {
  return {redemptionId:String(row.redemption_id),rewardId:String(row.reward_id),userId:String(row.user_id),displayName:String(row.display_name),
    userInput:String(row.quest_title??row.user_input),redeemedAt:Number(row.redeemed_at),status:row.status as ChannelRedemptionStatus,
    questId:row.quest_id?String(row.quest_id):null,questStatus:row.quest_status?row.quest_status as QuestStatus:null,
    lastError:row.last_error?String(row.last_error):null,updatedAt:Number(row.updated_at)};
}

function validViewerText(value: string, maxLength: number, minLength = 3): boolean {
  const length = Array.from(value).length;
  return length >= minLength && length <= maxLength && !/[\u0000-\u001F\u007F<>\u202A-\u202E\u2066-\u2069]/u.test(value);
}

function publicQuest(quest: QuestRecord): Record<string, unknown> {
  return { id: quest.id, title: quest.title, displayName: quest.displayName, game: quest.game,
    status: quest.status, expiresAt: quest.expiresAt, updatedAt: quest.updatedAt };
}

function publicPoll(poll: PollRecord): Record<string, unknown> {
  return { question: poll.question, options: poll.options.map(({ label, votes, percent }) => ({ label, votes, percent })),
    status: poll.status, startsAt: poll.startsAt, endsAt: poll.endsAt, endedAt: poll.endedAt,
    winnerOption: poll.winnerOption, tied: poll.tied, totalVotes: poll.totalVotes };
}
