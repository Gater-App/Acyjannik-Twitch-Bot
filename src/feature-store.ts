import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type { Player } from './types.js';
import { DEFAULT_8BALL_ANSWERS, LEGACY_DEFAULT_8BALL_ANSWERS } from './eight-ball-answers.js';

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
export type IdeaStatus = 'pending' | 'reviewing' | 'approved' | 'voting' | 'accepted' | 'planned' | 'implemented' | 'rejected' | 'archived';
export interface CommunityIdea { id:string; submitterUserId:string; displayName:string; text:string; category:string|null; status:IdeaStatus; submittedAt:number; updatedAt:number; moderationComment:string|null; votes:number; voted:boolean; }
export type WidgetType = 'quest' | 'poll' | 'imposter' | 'detective' | 'pet' | 'drop' | 'wheel' | 'vault';
export type SparkStatus = 'detected' | 'pending_approval' | 'approved' | 'rejected' | 'expired' | 'executed' | 'canceled';
export interface SparkProposal {
  id: string; channelId: string; topicId: string; topicLabel: string; score: number; participants: number;
  messages: number; actionType: 'question' | 'poll' | 'quest' | 'challenge'; suggestionText?: string | null; status: SparkStatus; createdAt: number;
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

export interface PollOptionResult { label: string; votes: number; percent: number; questId?: string; ideaId?: string; }
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

export interface PollOptionInput { label: string; questId?: string; ideaId?: string; }
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

const RESERVED_COMMANDS = new Set([
  'trickortreat', 'pumpkins', 'top', 'halloween', 'starthalloween', 'endhalloween', 'resethalloween',
  'gift', 'egghunt', 'eventscore', 'eventtop', 'startevent', 'endevent', 'level', 'xptop', 'rank',
  '8ball', 'rps', 'guess', 'startguess', 'duel', 'accept', 'cancelduel', 'startboss', 'attack',
  'boss', 'bosstop', 'endboss', 'addcommand', 'setcommand', 'delcommand', 'help',
  'quest', 'quests', 'myquest', 'questhelp', 'questqueue', 'approvequest', 'rejectquest', 'skipquest', 'poll', 'vote', 'pollresults',
  'spark','sparks','sparkhelp','sparkapprove','sparkreject','sparkpause','sparkresume','sparktopics',
  'imposter','imposterstatus','joinimposter','leaveimposter','startimposter','closeimposter','cancelimposter','sus','community',
  'idee','ideen','quoteoptin','quoteoptout','savequote','myquotes','deletequote','detektiv','startdetektiv','wer','quote','skipdetektiv','enddetektiv',
  'pet','feed','play','petcare','petstats','petname','pethelp','petevolution','setpetname','petpause','petresume',
  'claim','drop','dropstats','drops','startdrop','canceldrop','dropconfig','wheel','spin','wheelstatus','startwheel','cancelwheel','wheelpause','wheelresume',
  'code','orakel','unschuldig','prankoptout','prankoptin',
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
          ('8ball_answers', '${JSON.stringify(DEFAULT_8BALL_ANSWERS)}'),
          ('xp_settings', '{"activityXp":5,"activityCooldownMs":60000,"dailyGameCap":100,"dailyRewardXp":25,"rpsWinXp":10,"guessWinXp":20,"duelWinXp":15,"levelBase":100}'),
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
        INSERT OR IGNORE INTO community_pet(id,name,updated_at) VALUES(1,'Elio',unixepoch()*1000);
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
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 11) {
      if (currentVersion > 0) this.backupBeforeMigration(11);
      const columns = new Set((this.db.prepare('PRAGMA table_info(community_pet_interactions)').all() as Array<{name:string}>).map(column=>column.name));
      this.db.transaction(() => {
        if (!columns.has('announced_at')) this.db.exec('ALTER TABLE community_pet_interactions ADD COLUMN announced_at INTEGER');
        // Existing interactions predate batching and must not be replayed as new announcements.
        this.db.exec("UPDATE community_pet_interactions SET announced_at=created_at WHERE announced_at IS NULL; INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (11, unixepoch()*1000);");
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 12) {
      if (currentVersion > 0) this.backupBeforeMigration(12);
      const columns = new Set((this.db.prepare('PRAGMA table_info(chaos_wheel_spins)').all() as Array<{name:string}>).map(column=>column.name));
      this.db.transaction(() => {
        if (!columns.has('ends_at')) this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN ends_at INTEGER');
        this.db.exec('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (12, unixepoch()*1000);');
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 13) {
      if (currentVersion > 0) this.backupBeforeMigration(13);
      this.db.transaction(() => this.db.exec(`
        -- Change only the known seeded default; preserve any deliberately chosen community name.
        UPDATE community_pet SET name='Elio' WHERE id=1 AND name='Fünkchen';
        -- Keep the built-in bonus action and its ID, changing only its visible label.
        UPDATE chaos_wheel_challenges SET title='Elio bekommt einen Energieschub!'
          WHERE id='builtin:pet-energy' AND title='Der Drache bekommt einen Energieschub!' AND action_type='boost_pet';
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (13, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 14) {
      if (currentVersion > 0) this.backupBeforeMigration(14);
      this.db.transaction(() => this.db.exec(`
        -- Existing installations may have a generated ID for this seeded action.
        -- Match only its exact legacy label and action type; preserve the row ID.
        UPDATE chaos_wheel_challenges SET title='Elio bekommt einen Energieschub!'
          WHERE title='Der Drache bekommt einen Energieschub!' AND action_type='boost_pet';
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (14, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 15) {
      if (currentVersion > 0) this.backupBeforeMigration(15);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS automatic_chat_messages (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL,
          interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN 15 AND 1440),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          active_chat_only INTEGER NOT NULL DEFAULT 0 CHECK(active_chat_only IN (0,1)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          last_sent_at INTEGER, last_attempt_at INTEGER, last_error_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS automatic_chat_messages_due ON automatic_chat_messages(enabled,updated_at);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (15, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 16) {
      if (currentVersion > 0) this.backupBeforeMigration(16);
      this.db.transaction(() => {
        this.db.prepare('UPDATE feature_config SET value=? WHERE key=? AND value=?')
          .run(JSON.stringify(DEFAULT_8BALL_ANSWERS), '8ball_answers', JSON.stringify(LEGACY_DEFAULT_8BALL_ANSWERS));
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (16, ?)').run(Date.now());
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 17) {
      if (currentVersion > 0) this.backupBeforeMigration(17);
      this.db.transaction(() => {
        const now=Date.now();
        this.db.prepare("UPDATE chaos_wheel_challenges SET active=0 WHERE action_type='manual_challenge'").run();
        this.db.prepare("UPDATE chaos_wheel_spins SET status='canceled',resolved_at=COALESCE(resolved_at,?) WHERE status IN ('spinning','active') AND action_type='manual_challenge'").run(now);
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (17, ?)').run(now);
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 18) {
      if (currentVersion > 0) this.backupBeforeMigration(18);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS song_requests (
          redemption_id TEXT PRIMARY KEY, reward_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL,
          user_input TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('processing','added','fulfillment_pending','rejected','needs_review')),
          track_uri TEXT, track_name TEXT, track_artist TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS song_requests_recent ON song_requests(created_at DESC);
        INSERT OR IGNORE INTO feature_config(key,value) VALUES
          ('song_request_settings','{"enabled":false,"rewardId":null,"rewardTitle":"🎵 Song wünschen","cost":1000,"playlistId":null,"playlistName":null}');
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (18, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 19) {
      if (currentVersion > 0) this.backupBeforeMigration(19);
      this.db.transaction(() => {
        const row=this.db.prepare("SELECT value FROM feature_config WHERE key='song_request_settings'").get() as {value:string}|undefined;
        if(row)try{const value=JSON.parse(row.value) as Record<string,unknown>;
          if(value.enabled===false&&value.rewardId==null&&value.playlistId==null&&value.cost===500){value.cost=1000;this.db.prepare("UPDATE feature_config SET value=? WHERE key='song_request_settings'").run(JSON.stringify(value));}}
        catch{/* Keep an invalid legacy setting untouched for operator review. */}
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (19, ?)').run(Date.now());
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 20) {
      if (currentVersion > 0) this.backupBeforeMigration(20);
      this.db.transaction(() => {
        const challengeColumns=new Set((this.db.prepare('PRAGMA table_info(chaos_wheel_challenges)').all() as Array<{name:string}>).map(x=>x.name));
        const spinColumns=new Set((this.db.prepare('PRAGMA table_info(chaos_wheel_spins)').all() as Array<{name:string}>).map(x=>x.name));
        if(!challengeColumns.has('wheel_key'))this.db.exec('ALTER TABLE chaos_wheel_challenges ADD COLUMN wheel_key TEXT');
        if(!spinColumns.has('wheel_key'))this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN wheel_key TEXT');
        if(!spinColumns.has('task_ref'))this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN task_ref TEXT');
        const seeds=[
          ['builtin:pet-energy','Elio bekommt einen Energieschub!',2,'boost_pet','boost_pet'],
          ['builtin:mystery-drop','Mystery Drop für den Chat',2,'start_mystery_drop','start_mystery_drop'],
          ['wheel:quest-vote','Chat wählt die nächste Quest',2,'quest_vote','manual_challenge'],
          ['wheel:no-jumping','Eine Runde ohne Springen',1,'no_jumping','manual_challenge'],
          ['wheel:pistols','Fünf Minuten nur Pistolen',1,'pistols_timer','manual_challenge'],
          ['wheel:gaming-quiz','Gaming-Quiz',1,'gaming_quiz','manual_challenge'],
        ] as const;
        const insert=this.db.prepare('INSERT OR IGNORE INTO chaos_wheel_challenges(id,title,weight,active,action_type,wheel_key) VALUES(?,?,?,?,?,?)');
        for(const [id,title,weight,key,actionType] of seeds){
          const seededAction=this.db.prepare('SELECT 1 FROM chaos_wheel_challenges WHERE action_type=? LIMIT 1').get(actionType);
          if((actionType==='boost_pet'||actionType==='start_mystery_drop')&&seededAction)continue;
          insert.run(id,title,weight,key==='gaming_quiz'?0:1,actionType,key);
        }
        // Disable quiz fields regardless of legacy/generated ID, while retaining rows and history.
        this.db.prepare("UPDATE chaos_wheel_challenges SET wheel_key='gaming_quiz',active=0 WHERE wheel_key='gaming_quiz' OR (wheel_key IS NULL AND lower(title) LIKE '%quiz%')").run();
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (20, ?)').run(Date.now());
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 21) {
      if (currentVersion > 0) this.backupBeforeMigration(21);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS community_viewer_oauth_states (
          state_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS community_viewer_oauth_expiry ON community_viewer_oauth_states(expires_at);
        CREATE TABLE IF NOT EXISTS community_viewer_sessions (
          session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, login TEXT NOT NULL, display_name TEXT NOT NULL,
          profile_image_url TEXT, csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS community_viewer_session_expiry ON community_viewer_sessions(expires_at);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (21, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 22) {
      if (currentVersion > 0) this.backupBeforeMigration(22);
      this.db.transaction(() => {
        this.db.exec(`
          DROP INDEX IF EXISTS spark_proposals_status_time;
          DROP INDEX IF EXISTS spark_one_open_topic;
          ALTER TABLE spark_proposals RENAME TO spark_proposals_legacy;
          CREATE TABLE spark_proposals (
            id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, topic_id TEXT NOT NULL, topic_label TEXT NOT NULL,
            score INTEGER NOT NULL, participant_count INTEGER NOT NULL, message_count INTEGER NOT NULL,
            action_type TEXT NOT NULL CHECK(action_type IN ('question','poll','quest','challenge')),
            suggestion_text TEXT,
            status TEXT NOT NULL CHECK(status IN ('detected','pending_approval','approved','rejected','expired','executed','canceled')),
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_by TEXT, rejection_reason TEXT
          );
          INSERT INTO spark_proposals(id,channel_id,topic_id,topic_label,score,participant_count,message_count,action_type,suggestion_text,status,created_at,expires_at,decided_by,rejection_reason)
            SELECT id,channel_id,topic_id,topic_label,score,participant_count,message_count,action_type,NULL,status,created_at,expires_at,decided_by,rejection_reason FROM spark_proposals_legacy;
          DROP TABLE spark_proposals_legacy;
          CREATE INDEX spark_proposals_status_time ON spark_proposals(status,created_at DESC);
          CREATE UNIQUE INDEX spark_one_open_topic ON spark_proposals(channel_id,topic_id) WHERE status IN ('detected','pending_approval','approved');
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (22, unixepoch()*1000);
        `);
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 23) {
      if (currentVersion > 0) this.backupBeforeMigration(23);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS community_vault_rounds (
          id TEXT PRIMARY KEY, secret_code TEXT NOT NULL CHECK(length(secret_code)=3), status TEXT NOT NULL CHECK(status IN ('active','opened','expired','canceled')),
          started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, attempts_count INTEGER NOT NULL DEFAULT 0, is_auto INTEGER NOT NULL DEFAULT 0,
          last_public_hint TEXT, last_public_hint_at INTEGER, winner_user_id TEXT, winner_name TEXT, result_code TEXT,
          announcement_sent INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS community_vault_one_active ON community_vault_rounds(status) WHERE status='active';
        CREATE TABLE IF NOT EXISTS community_vault_attempts (
          event_id TEXT PRIMARY KEY, round_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL,
          exact_count INTEGER NOT NULL, misplaced_count INTEGER NOT NULL, submitted_at INTEGER NOT NULL,
          FOREIGN KEY(round_id) REFERENCES community_vault_rounds(id)
        );
        CREATE INDEX IF NOT EXISTS community_vault_attempts_round_user ON community_vault_attempts(round_id,user_id,submitted_at);
        CREATE TABLE IF NOT EXISTS community_vault_awards (
          round_id TEXT NOT NULL, user_id TEXT NOT NULL, award_type TEXT NOT NULL, xp INTEGER NOT NULL,
          PRIMARY KEY(round_id,user_id,award_type), FOREIGN KEY(round_id) REFERENCES community_vault_rounds(id)
        );
        CREATE TABLE widget_tokens_v23(id TEXT PRIMARY KEY,widget_type TEXT NOT NULL CHECK(widget_type IN ('quest','poll','imposter','detective','pet','drop','wheel','vault')),
          token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER);
        INSERT INTO widget_tokens_v23 SELECT * FROM widget_tokens;
        DROP TABLE widget_tokens;
        ALTER TABLE widget_tokens_v23 RENAME TO widget_tokens;
        CREATE INDEX widget_tokens_active ON widget_tokens(widget_type,revoked_at,expires_at);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (23, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 24) {
      if (currentVersion > 0) this.backupBeforeMigration(24);
      const columns = new Set((this.db.prepare('PRAGMA table_info(community_pet_interactions)').all() as Array<{name:string}>).map(column=>column.name));
      this.db.transaction(() => {
        if (!columns.has('source')) this.db.exec("ALTER TABLE community_pet_interactions ADD COLUMN source TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat','portal'))");
        this.db.exec("UPDATE community_pet_interactions SET source='portal' WHERE event_id LIKE 'viewer:%'; INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (24, unixepoch()*1000);");
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 25) {
      if (currentVersion > 0) this.backupBeforeMigration(25);
      this.db.transaction(() => {
        const spinColumns=new Set((this.db.prepare('PRAGMA table_info(chaos_wheel_spins)').all() as Array<{name:string}>).map(x=>x.name));
        if(!spinColumns.has('wheel_fields_json'))this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN wheel_fields_json TEXT');
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (25, ?)').run(Date.now());
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 26) {
      if (currentVersion > 0) this.backupBeforeMigration(26);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS community_world_badges (
            user_id TEXT NOT NULL, badge_id TEXT NOT NULL, unlocked_at INTEGER NOT NULL,
            PRIMARY KEY(user_id,badge_id)
          );
          CREATE INDEX IF NOT EXISTS community_world_badges_user ON community_world_badges(user_id,unlocked_at DESC);
          CREATE TABLE IF NOT EXISTS community_world_mission_claims (
            user_id TEXT NOT NULL, mission_id TEXT NOT NULL, period_key TEXT NOT NULL,
            claimed_at INTEGER NOT NULL, reward_xp INTEGER NOT NULL CHECK(reward_xp >= 0),
            PRIMARY KEY(user_id,mission_id,period_key)
          );
          CREATE INDEX IF NOT EXISTS community_world_mission_claims_user ON community_world_mission_claims(user_id,claimed_at DESC);
          INSERT OR IGNORE INTO feature_config(key,value) VALUES ('community_world_started_at','${Date.now()}');
        `);
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (26, ?)').run(Date.now());
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 27) {
      if (currentVersion > 0) this.backupBeforeMigration(27);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS haunted_house_seasons (
            season_id TEXT PRIMARY KEY, season_year INTEGER NOT NULL, started_at INTEGER NOT NULL,
            last_contribution_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS haunted_house_contributions (
            event_id TEXT PRIMARY KEY, season_id TEXT NOT NULL, user_id TEXT NOT NULL, contributed_at INTEGER NOT NULL,
            FOREIGN KEY(season_id) REFERENCES haunted_house_seasons(season_id)
          );
          CREATE INDEX IF NOT EXISTS haunted_house_contributions_season ON haunted_house_contributions(season_id,contributed_at);
          CREATE INDEX IF NOT EXISTS haunted_house_contributions_user ON haunted_house_contributions(user_id,contributed_at);
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (27, unixepoch()*1000);
        `);
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 28) {
      if (currentVersion > 0) this.backupBeforeMigration(28);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS community_pet_events (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('feed','play','care','ambient','rare','community')),
            message TEXT NOT NULL, rare INTEGER NOT NULL DEFAULT 0 CHECK(rare IN (0,1)), created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS community_pet_events_created ON community_pet_events(created_at DESC);
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (28, unixepoch()*1000);
        `);
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 29) {
      if (currentVersion > 0) this.backupBeforeMigration(29);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS community_memories (
            id TEXT PRIMARY KEY, submitter_user_id TEXT NOT NULL, submitter_name TEXT NOT NULL,
            body TEXT NOT NULL CHECK(length(body) BETWEEN 10 AND 500), clip_url TEXT,
            category TEXT NOT NULL CHECK(category IN ('gaming','community','seasonal','funny','milestone')),
            event_name TEXT, status TEXT NOT NULL CHECK(status IN ('pending','published','rejected','withdrawn')),
            featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1)),
            submitted_at INTEGER NOT NULL, published_at INTEGER, moderated_by TEXT, moderated_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS community_memories_timeline ON community_memories(status,published_at DESC);
          CREATE INDEX IF NOT EXISTS community_memories_submitter ON community_memories(submitter_user_id,submitted_at DESC);
          CREATE TABLE IF NOT EXISTS community_memory_reactions (
            memory_id TEXT NOT NULL REFERENCES community_memories(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(memory_id,user_id)
          );
          CREATE INDEX IF NOT EXISTS community_memory_reactions_memory ON community_memory_reactions(memory_id);
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (29, unixepoch()*1000);
        `);
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 30) {
      if (currentVersion > 0) this.backupBeforeMigration(30);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS community_ideas (
            id TEXT PRIMARY KEY, submitter_user_id TEXT NOT NULL, display_name TEXT NOT NULL,
            idea_text TEXT NOT NULL CHECK(length(idea_text) BETWEEN 8 AND 240), normalized_text TEXT NOT NULL,
            category TEXT, status TEXT NOT NULL CHECK(status IN ('pending','reviewing','approved','voting','accepted','planned','implemented','rejected','archived')),
            submitted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, moderated_by TEXT, moderation_comment TEXT,
            UNIQUE(submitter_user_id,normalized_text,status)
          );
          CREATE INDEX IF NOT EXISTS community_ideas_public ON community_ideas(status,updated_at DESC);
          CREATE INDEX IF NOT EXISTS community_ideas_submitter ON community_ideas(submitter_user_id,submitted_at DESC);
          CREATE TABLE IF NOT EXISTS community_idea_votes (
            idea_id TEXT NOT NULL REFERENCES community_ideas(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(idea_id,user_id)
          );
          CREATE INDEX IF NOT EXISTS community_idea_votes_idea ON community_idea_votes(idea_id);
          INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (30, unixepoch()*1000);
        `);
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 31) {
      if (currentVersion > 0) this.backupBeforeMigration(31);
      this.db.transaction(() => {
        const spinColumns = new Set((this.db.prepare('PRAGMA table_info(chaos_wheel_spins)').all() as Array<{name:string}>).map(column=>column.name));
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS recent_chat_activity (
            user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, login TEXT NOT NULL, last_activity_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS recent_chat_activity_time ON recent_chat_activity(last_activity_at DESC);
        `);
        if (!spinColumns.has('winner_user_id')) this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN winner_user_id TEXT');
        if (!spinColumns.has('winner_name')) this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN winner_name TEXT');
        if (!spinColumns.has('result_label')) this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN result_label TEXT');
        if (!spinColumns.has('reward_status')) this.db.exec("ALTER TABLE chaos_wheel_spins ADD COLUMN reward_status TEXT NOT NULL DEFAULT 'none'");
        if (!spinColumns.has('stream_id')) this.db.exec('ALTER TABLE chaos_wheel_spins ADD COLUMN stream_id TEXT');
        // New fields start disabled, preserving all existing configured weights and behavior.
        const insert=this.db.prepare("INSERT OR IGNORE INTO chaos_wheel_challenges(id,title,weight,active,action_type,wheel_key) VALUES(?,?,1,0,'manual_challenge',?)");
        for (const [id,title,key] of [
          ['wheel:viewer-xp','🎁 Glückspilz · 25 XP','viewer_xp'],
          ['wheel:viewer-drop','💜 Persönlicher Mystery Drop','viewer_mystery_drop'],
          ['wheel:honor','👑 Ehrenmoment','viewer_honor'],
          ['wheel:community-bonus','✨ Community-Bonus','community_bonus'],
          ['wheel:quest-luck','🎯 Quest-Glück','quest_luck'],
          ['wheel:chaos-title','😈 Chaos-Magnet','chaos_title'],
          ['wheel:extra-spin','🎡 Noch mal drehen','extra_spin'],
        ]) insert.run(id,title,key);
        this.db.exec('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (31, unixepoch()*1000);');
      })();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 32) {
      if (currentVersion > 0) this.backupBeforeMigration(32);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS vip_chaos_requests (
          id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('elio-crown','oracle','vault-alarm')), status TEXT NOT NULL
            CHECK(status IN ('pending','processing','approved','rejected','failed')),
          created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, executed_at INTEGER,
          UNIQUE(user_id,stream_id)
        );
        CREATE INDEX IF NOT EXISTS vip_chaos_status_created ON vip_chaos_requests(status,created_at);
        CREATE TABLE IF NOT EXISTS vip_achievements (
          user_id TEXT NOT NULL, achievement_id TEXT NOT NULL, earned_at INTEGER NOT NULL,
          PRIMARY KEY(user_id,achievement_id)
        );
        CREATE TABLE IF NOT EXISTS vip_challenges (
          quest_id TEXT PRIMARY KEY, submitter_user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
          featured_until INTEGER
        );
        CREATE INDEX IF NOT EXISTS vip_challenges_submitter_created ON vip_challenges(submitter_user_id,created_at);
        CREATE INDEX IF NOT EXISTS vip_challenges_featured ON vip_challenges(featured_until);
        CREATE TABLE IF NOT EXISTS vip_pet_interactions (event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS vip_pet_interactions_user ON vip_pet_interactions(user_id,created_at);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (32, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 33) {
      if (currentVersion > 0) this.backupBeforeMigration(33);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS discord_event_outbox (
          id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','delivered','dead')),
          attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER,
          delivered_at INTEGER, last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS discord_event_outbox_ready ON discord_event_outbox(status,available_at,created_at);
        CREATE TABLE IF NOT EXISTS discord_event_inbox (
          event_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (33, unixepoch()*1000);
      `))();
    }
    currentVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? currentVersion;
    if (currentVersion < 34) {
      if (currentVersion > 0) this.backupBeforeMigration(34);
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS community_account_links (
          twitch_user_id TEXT PRIMARY KEY,
          discord_user_id TEXT NOT NULL UNIQUE,
          linked_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS community_account_link_intents (
          token_hash TEXT PRIMARY KEY,
          discord_user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS community_account_link_intents_expiry ON community_account_link_intents(expires_at);
        CREATE TABLE IF NOT EXISTS community_account_link_oauth_states (
          state_hash TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS community_account_link_oauth_expiry ON community_account_link_oauth_states(expires_at);
        CREATE TABLE IF NOT EXISTS community_account_link_audit (
          id TEXT PRIMARY KEY,
          discord_user_id TEXT NOT NULL,
          twitch_user_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('linked','unlinked')),
          created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (34, unixepoch()*1000);
      `))();
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

  createViewerOAuthState(stateHash:string,expiresAt:number,now:number):void {
    this.db.prepare('DELETE FROM community_viewer_oauth_states WHERE expires_at<=?').run(now);
    this.db.prepare('INSERT INTO community_viewer_oauth_states(state_hash,expires_at,created_at) VALUES(?,?,?)').run(stateHash,expiresAt,now);
  }

  viewerOAuthStateExists(stateHash:string):boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM community_viewer_oauth_states WHERE state_hash=?').get(stateHash));
  }

  consumeViewerOAuthState(stateHash:string,now:number):boolean {
    return this.db.transaction(()=>{
      const row=this.db.prepare('SELECT expires_at FROM community_viewer_oauth_states WHERE state_hash=?').get(stateHash) as {expires_at:number}|undefined;
      this.db.prepare('DELETE FROM community_viewer_oauth_states WHERE state_hash=?').run(stateHash);
      return Boolean(row&&row.expires_at>now);
    })();
  }

  createCommunityAccountLinkIntent(input:{tokenHash:string;discordUserId:string;createdAt:number;expiresAt:number}):void {
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM community_account_link_intents WHERE expires_at<=? OR used_at IS NOT NULL').run(input.createdAt);
      this.db.prepare('DELETE FROM community_account_link_intents WHERE discord_user_id=? AND used_at IS NULL').run(input.discordUserId);
      this.db.prepare('INSERT INTO community_account_link_intents(token_hash,discord_user_id,created_at,expires_at) VALUES(?,?,?,?)')
        .run(input.tokenHash,input.discordUserId,input.createdAt,input.expiresAt);
    })();
  }

  accountLinkIntent(tokenHash:string,now:number):{discordUserId:string;expiresAt:number}|undefined {
    const row=this.db.prepare('SELECT discord_user_id,expires_at,used_at FROM community_account_link_intents WHERE token_hash=?').get(tokenHash) as {discord_user_id:string;expires_at:number;used_at:number|null}|undefined;
    return row&&row.expires_at>now&&row.used_at===null?{discordUserId:row.discord_user_id,expiresAt:row.expires_at}:undefined;
  }

  beginCommunityAccountLinkOAuthState(input:{stateHash:string;tokenHash:string;expiresAt:number;now:number}):boolean {
    return this.db.transaction(()=>{
      const intent=this.db.prepare('SELECT expires_at,used_at FROM community_account_link_intents WHERE token_hash=?').get(input.tokenHash) as {expires_at:number;used_at:number|null}|undefined;
      if(!intent||intent.expires_at<=input.now||intent.used_at!==null)return false;
      this.db.prepare('UPDATE community_account_link_intents SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(input.now,input.tokenHash);
      this.db.prepare('DELETE FROM community_viewer_oauth_states WHERE expires_at<=?').run(input.now);
      this.db.prepare('DELETE FROM community_account_link_oauth_states WHERE expires_at<=?').run(input.now);
      this.db.prepare('INSERT INTO community_viewer_oauth_states(state_hash,expires_at,created_at) VALUES(?,?,?)').run(input.stateHash,input.expiresAt,input.now);
      this.db.prepare('INSERT INTO community_account_link_oauth_states(state_hash,token_hash,expires_at) VALUES(?,?,?)')
        .run(input.stateHash,input.tokenHash,input.expiresAt);
      return true;
    })();
  }

  communityAccountLinkOAuthStateExists(stateHash:string,now:number):boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM community_account_link_oauth_states WHERE state_hash=? AND expires_at>?').get(stateHash,now));
  }

  completeCommunityAccountLink(input:{stateHash:string;twitchUserId:string;now:number}):'linked'|'already-linked'|'discord-linked'|'twitch-linked'|'expired' {
    return this.db.transaction(()=>{
      const state=this.db.prepare('SELECT token_hash,expires_at FROM community_account_link_oauth_states WHERE state_hash=?').get(input.stateHash) as {token_hash:string;expires_at:number}|undefined;
      this.db.prepare('DELETE FROM community_account_link_oauth_states WHERE state_hash=?').run(input.stateHash);
      if(!state||state.expires_at<=input.now)return 'expired';
      const intent=this.db.prepare('SELECT discord_user_id,expires_at,used_at FROM community_account_link_intents WHERE token_hash=?').get(state.token_hash) as {discord_user_id:string;expires_at:number;used_at:number|null}|undefined;
      if(!intent||intent.expires_at<=input.now||intent.used_at===null)return 'expired';
      const discordLink=this.db.prepare('SELECT twitch_user_id FROM community_account_links WHERE discord_user_id=?').get(intent.discord_user_id) as {twitch_user_id:string}|undefined;
      if(discordLink)return discordLink.twitch_user_id===input.twitchUserId?'already-linked':'discord-linked';
      const twitchLink=this.db.prepare('SELECT discord_user_id FROM community_account_links WHERE twitch_user_id=?').get(input.twitchUserId) as {discord_user_id:string}|undefined;
      if(twitchLink)return 'twitch-linked';
      this.db.prepare('INSERT INTO community_account_links(twitch_user_id,discord_user_id,linked_at) VALUES(?,?,?)').run(input.twitchUserId,intent.discord_user_id,input.now);
      this.db.prepare('INSERT INTO community_account_link_audit(id,discord_user_id,twitch_user_id,action,created_at) VALUES(?,?,? ,\'linked\',?)')
        .run(randomUUID(),intent.discord_user_id,input.twitchUserId,input.now);
      return 'linked';
    })();
  }

  communityAccountLinkStatus(discordUserId:string):{linked:boolean;linkedAt?:number} {
    const row=this.db.prepare('SELECT linked_at FROM community_account_links WHERE discord_user_id=?').get(discordUserId) as {linked_at:number}|undefined;
    return row?{linked:true,linkedAt:row.linked_at}:{linked:false};
  }

  communityXpProfileForDiscord(discordUserId:string):{displayName:string;xp:number;rank:number;badges:Array<{id:string;unlockedAt:number}>}|undefined {
    const row=this.db.prepare(`SELECT u.user_id,u.display_name,u.xp FROM community_account_links l
      LEFT JOIN xp_users u ON u.user_id=l.twitch_user_id WHERE l.discord_user_id=?`).get(discordUserId) as
      {user_id:string|null;display_name:string|null;xp:number|null}|undefined;
    if(!row)return undefined;
    const xp=Number(row.xp)||0;
    const rank=row.user_id?Number((this.db.prepare('SELECT 1+COUNT(*) rank FROM xp_users WHERE xp>?').get(xp) as {rank:number}).rank):0;
    const badges=row.user_id?this.db.prepare('SELECT badge_id id,unlocked_at unlockedAt FROM community_world_badges WHERE user_id=? ORDER BY unlocked_at DESC').all(row.user_id) as Array<{id:string;unlockedAt:number}>:[];
    return {displayName:row.display_name||'Community-Mitglied',xp,rank,badges};
  }

  communityXpLeaderboardPage(limit:number,offset:number):{total:number;rows:Array<{displayName:string;xp:number}>} {
    const safeLimit=Math.max(1,Math.min(10,Math.floor(limit)||10)),safeOffset=Math.max(0,Math.floor(offset)||0);
    const total=Number((this.db.prepare('SELECT COUNT(*) count FROM xp_users').get() as {count:number}).count);
    const rows=this.db.prepare('SELECT display_name displayName,xp FROM xp_users ORDER BY xp DESC,updated_at ASC LIMIT ? OFFSET ?')
      .all(safeLimit,safeOffset) as Array<{displayName:string;xp:number}>;
    return {total,rows};
  }

  communityTwitchIdForDiscord(discordUserId:string):string|undefined {
    const row=this.db.prepare('SELECT twitch_user_id FROM community_account_links WHERE discord_user_id=?').get(discordUserId) as {twitch_user_id:string}|undefined;
    return row?.twitch_user_id;
  }

  communityDiscordIdForTwitch(twitchUserId:string):string|undefined {
    const row=this.db.prepare('SELECT discord_user_id FROM community_account_links WHERE twitch_user_id=?').get(twitchUserId) as {discord_user_id:string}|undefined;
    return row?.discord_user_id;
  }

  processDiscordEvent<T>(eventId:string,now:number,perform:()=>T):{result:T;duplicate:boolean} {
    if(!/^\d{17,20}$/u.test(eventId))throw new Error('Ungültige Discord-Ereignis-ID.');
    return this.db.transaction(()=>{
      const previous=this.db.prepare('SELECT result_json FROM discord_event_inbox WHERE event_id=?').get(eventId) as {result_json:string}|undefined;
      if(previous)return {result:JSON.parse(previous.result_json) as T,duplicate:true};
      const result=perform();
      this.db.prepare('INSERT INTO discord_event_inbox(event_id,result_json,created_at) VALUES(?,?,?)').run(eventId,JSON.stringify(result),now);
      return {result,duplicate:false};
    })();
  }

  disconnectCommunityAccountLink(input:{discordUserId:string;now:number}):boolean {
    return this.db.transaction(()=>{
      const row=this.db.prepare('SELECT twitch_user_id FROM community_account_links WHERE discord_user_id=?').get(input.discordUserId) as {twitch_user_id:string}|undefined;
      if(!row)return false;
      this.db.prepare('DELETE FROM community_account_links WHERE discord_user_id=?').run(input.discordUserId);
      this.db.prepare('INSERT INTO community_account_link_audit(id,discord_user_id,twitch_user_id,action,created_at) VALUES(?,?,?,\'unlinked\',?)')
        .run(randomUUID(),input.discordUserId,row.twitch_user_id,input.now);
      return true;
    })();
  }

  createViewerSession(input:{sessionHash:string;userId:string;login:string;displayName:string;profileImageUrl:string|null;csrfToken:string;createdAt:number;expiresAt:number}):void {
    this.db.prepare('DELETE FROM community_viewer_sessions WHERE expires_at<=?').run(input.createdAt);
    this.db.prepare(`INSERT INTO community_viewer_sessions(session_hash,user_id,login,display_name,profile_image_url,csrf_token,created_at,expires_at)
      VALUES(@sessionHash,@userId,@login,@displayName,@profileImageUrl,@csrfToken,@createdAt,@expiresAt)`).run(input);
  }

  viewerSession(sessionHash:string,now:number):{userId:string;login:string;displayName:string;profileImageUrl:string|null;csrfToken:string;expiresAt:number}|undefined {
    const row=this.db.prepare('SELECT user_id,login,display_name,profile_image_url,csrf_token,expires_at FROM community_viewer_sessions WHERE session_hash=?').get(sessionHash) as
      {user_id:string;login:string;display_name:string;profile_image_url:string|null;csrf_token:string;expires_at:number}|undefined;
    if(!row)return undefined;
    if(row.expires_at<=now){this.db.prepare('DELETE FROM community_viewer_sessions WHERE session_hash=?').run(sessionHash);return undefined;}
    return {userId:row.user_id,login:row.login,displayName:row.display_name,profileImageUrl:row.profile_image_url,csrfToken:row.csrf_token,expiresAt:row.expires_at};
  }

  deleteViewerSession(sessionHash:string):void { this.db.prepare('DELETE FROM community_viewer_sessions WHERE session_hash=?').run(sessionHash); }

  submitCommunityMemory(input:{id:string;userId:string;displayName:string;body:string;clipUrl:string|null;category:string;eventName:string|null;now:number}):boolean {
    return this.db.transaction(()=>{
      const recent=this.db.prepare("SELECT 1 FROM community_memories WHERE submitter_user_id=? AND status IN ('pending','published') AND submitted_at>? LIMIT 1")
        .get(input.userId,input.now-10*60_000);
      const open=this.db.prepare("SELECT COUNT(*) n FROM community_memories WHERE submitter_user_id=? AND status='pending'").get(input.userId) as {n:number};
      if(recent||open.n>=3)return false;
      return this.db.prepare(`INSERT INTO community_memories(id,submitter_user_id,submitter_name,body,clip_url,category,event_name,status,submitted_at)
        VALUES(@id,@userId,@displayName,@body,@clipUrl,@category,@eventName,'pending',@now)`).run(input).changes===1;
    })();
  }

  communityMemories(filter:{status?:string;category?:string;event?:string;from?:number;to?:number;featured?:boolean;userId?:string;limit?:number}={}):Array<Record<string,unknown>> {
    const clauses:string[]=[];const args:unknown[]=[];
    if(filter.status){clauses.push('m.status=?');args.push(filter.status)}
    if(filter.category){clauses.push('m.category=?');args.push(filter.category)}
    if(filter.event){clauses.push('m.event_name=?');args.push(filter.event)}
    if(filter.from!==undefined){clauses.push('m.published_at>=?');args.push(filter.from)}
    if(filter.to!==undefined){clauses.push('m.published_at<?');args.push(filter.to)}
    if(filter.featured){clauses.push('m.featured=1')}
    const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
    const rows=this.db.prepare(`SELECT m.id,m.body,m.clip_url,m.category,m.event_name,m.status,m.featured,m.submitted_at,m.published_at,m.moderated_at,m.submitter_name,
      COALESCE(r.reactions,0) reactions,${filter.userId?'EXISTS(SELECT 1 FROM community_memory_reactions mine WHERE mine.memory_id=m.id AND mine.user_id=?)':'0'} reacted FROM community_memories m LEFT JOIN
      (SELECT memory_id,COUNT(*) reactions FROM community_memory_reactions GROUP BY memory_id) r ON r.memory_id=m.id
      ${where} ORDER BY m.featured DESC,COALESCE(m.published_at,m.submitted_at) DESC LIMIT ?`).all(...(filter.userId?[filter.userId]:[]),...args,Math.max(1,Math.min(100,filter.limit??50))) as Array<Record<string,unknown>>;
    return rows;
  }

  communityMemorySubmissions(userId:string,limit=20):Array<Record<string,unknown>> {
    return this.db.prepare(`SELECT id,body,clip_url,category,event_name,status,submitted_at,published_at,featured FROM community_memories
      WHERE submitter_user_id=? ORDER BY submitted_at DESC LIMIT ?`).all(userId,Math.max(1,Math.min(50,limit))) as Array<Record<string,unknown>>;
  }

  moderateCommunityMemory(id:string,action:'publish'|'reject'|'feature'|'unfeature',moderatorId:string,now:number):boolean {
    if(action==='publish')return this.db.prepare("UPDATE community_memories SET status='published',published_at=COALESCE(published_at,?),moderated_by=?,moderated_at=? WHERE id=? AND status='pending'").run(now,moderatorId,now,id).changes===1;
    if(action==='reject')return this.db.prepare("UPDATE community_memories SET status='rejected',featured=0,moderated_by=?,moderated_at=? WHERE id=? AND status='pending'").run(moderatorId,now,id).changes===1;
    if(action==='feature')return this.db.prepare("UPDATE community_memories SET featured=1,moderated_by=?,moderated_at=? WHERE id=? AND status='published'").run(moderatorId,now,id).changes===1;
    return this.db.prepare("UPDATE community_memories SET featured=0,moderated_by=?,moderated_at=? WHERE id=? AND status='published'").run(moderatorId,now,id).changes===1;
  }

  reactToCommunityMemory(memoryId:string,userId:string,now:number):boolean {
    return this.db.prepare("INSERT OR IGNORE INTO community_memory_reactions(memory_id,user_id,created_at) SELECT id,?,? FROM community_memories WHERE id=? AND status='published'")
      .run(userId,now,memoryId).changes===1;
  }

  deleteCommunityMemory(id:string,userId:string):boolean {
    return this.db.prepare('DELETE FROM community_memories WHERE id=? AND submitter_user_id=?')
      .run(id,userId).changes===1;
  }

  submitCommunityIdea(input:{id:string;userId:string;displayName:string;text:string;now:number;cooldownMs?:number}):{ok:true;idea:CommunityIdea}|{ok:false;reason:'duplicate'|'cooldown'|'limit'} {
    const normalized=input.text.normalize('NFKC').toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    return this.db.transaction(()=>{
      const same=this.db.prepare("SELECT 1 FROM community_ideas WHERE submitter_user_id=? AND normalized_text=? AND status NOT IN ('rejected','archived') AND submitted_at>? LIMIT 1").get(input.userId,normalized,input.now-90*24*60*60_000);
      if(same)return {ok:false as const,reason:'duplicate' as const};
      const open=this.db.prepare("SELECT COUNT(*) AS n FROM community_ideas WHERE submitter_user_id=? AND status IN ('pending','reviewing','approved','voting')").get(input.userId) as {n:number};
      if(open.n>=5)return {ok:false as const,reason:'limit' as const};
      const cooldown=this.db.prepare('SELECT last_used_at FROM feature_cooldowns WHERE feature=? AND user_id=?').get('community-idea',input.userId) as {last_used_at:number}|undefined;
      const remaining=cooldown?cooldown.last_used_at+(input.cooldownMs??600_000)-input.now:0;
      if(remaining>0)return {ok:false as const,reason:'cooldown' as const};
      this.db.prepare("INSERT INTO community_ideas(id,submitter_user_id,display_name,idea_text,normalized_text,status,submitted_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)")
        .run(input.id,input.userId,input.displayName,input.text,normalized,input.now,input.now);
      this.db.prepare(`INSERT INTO feature_cooldowns(feature,user_id,last_used_at) VALUES('community-idea',?,?) ON CONFLICT(feature,user_id) DO UPDATE SET last_used_at=excluded.last_used_at`).run(input.userId,input.now);
      this.recordCommunityEvent('community.idea.submitted',{id:input.id,userId:input.userId},input.now);
      this.enqueueDiscordEvent('idea.submitted',input.id,{id:input.id,text:input.text,displayName:input.displayName,category:null,status:'pending',submittedAt:input.now},input.now);
      return {ok:true as const,idea:this.communityIdea(input.id,input.userId)!};
    })();
  }

  communityIdea(id:string,userId?:string):CommunityIdea|undefined {
    const row=this.db.prepare(`SELECT i.id,i.submitter_user_id,i.display_name,i.idea_text,i.category,i.status,i.submitted_at,i.updated_at,i.moderation_comment,
      (SELECT COUNT(*) FROM community_idea_votes v WHERE v.idea_id=i.id) votes,
      ${userId?'EXISTS(SELECT 1 FROM community_idea_votes mine WHERE mine.idea_id=i.id AND mine.user_id=?)':'0'} voted
      FROM community_ideas i WHERE i.id=?`).get(...(userId?[userId,id]:[id])) as Record<string,unknown>|undefined;
    return row?toCommunityIdea(row):undefined;
  }

  communityIdeas(filter:{status?:string;userId?:string;query?:string;sort?:'newest'|'popular';limit?:number}={}):CommunityIdea[] {
    const clauses:string[]=[];const args:unknown[]=[];
    if(filter.status){clauses.push('i.status=?');args.push(filter.status)}
    if(filter.userId){clauses.push('i.submitter_user_id=?');args.push(filter.userId)}
    const q=(filter.query||'').trim().slice(0,80);if(q){clauses.push('(lower(i.idea_text) LIKE lower(?) OR lower(i.display_name) LIKE lower(?) OR i.id LIKE ?)');args.push(`%${q}%`,`%${q}%`,`%${q}%`)}
    const order=filter.sort==='popular'?'votes DESC,i.submitted_at DESC':'i.submitted_at DESC';
    const rows=this.db.prepare(`SELECT i.id,i.submitter_user_id,i.display_name,i.idea_text,i.category,i.status,i.submitted_at,i.updated_at,i.moderation_comment,
      (SELECT COUNT(*) FROM community_idea_votes v WHERE v.idea_id=i.id) votes,
      ${filter.userId?'EXISTS(SELECT 1 FROM community_idea_votes mine WHERE mine.idea_id=i.id AND mine.user_id=?)':'0'} voted
      FROM community_ideas i ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY ${order} LIMIT ?`)
      .all(...(filter.userId?[filter.userId]:[]),...args,Math.max(1,Math.min(200,filter.limit??100))) as Array<Record<string,unknown>>;
    return rows.map(toCommunityIdea);
  }

  voteCommunityIdea(id:string,userId:string,now:number):boolean {
    return this.db.transaction(()=>{
      const changed=this.db.prepare("INSERT OR IGNORE INTO community_idea_votes(idea_id,user_id,created_at) SELECT id,?,? FROM community_ideas WHERE id=? AND status='approved'")
        .run(userId,now,id).changes===1;
      if(changed){const idea=this.communityIdea(id);if(idea)this.enqueueDiscordEvent('idea.vote',id,{id,votes:idea.votes},now);}
      return changed;
    })();
  }

  moderateCommunityIdea(id:string,action:'review'|'approve'|'reject'|'accept'|'plan'|'implement'|'archive',moderatorId:string,now:number,comment:string|null=null,category:string|null=null):boolean {
    const status:IdeaStatus=({review:'reviewing',approve:'approved',reject:'rejected',accept:'accepted',plan:'planned',implement:'implemented',archive:'archived'} as const)[action];
    const allowed:Record<typeof action,string[]>={review:['pending'],approve:['pending','reviewing'],reject:['pending','reviewing','approved'],accept:['approved','voting'],plan:['accepted'],implement:['accepted','planned'],archive:['rejected','implemented','accepted','planned','approved']};
    return this.db.transaction(()=>{
      const changed=this.db.prepare(`UPDATE community_ideas SET status=?,updated_at=?,moderated_by=?,moderation_comment=?,category=COALESCE(?,category)
        WHERE id=? AND status IN (${allowed[action].map(()=>'?').join(',')})`).run(status,now,moderatorId,comment,category,id,...allowed[action]).changes===1;
      if(changed){const idea=this.communityIdea(id);if(idea)this.enqueueDiscordEvent('idea.status',id,{id:idea.id,status:idea.status,text:idea.text,category:idea.category,votes:idea.votes},now);}
      return changed;
    })();
  }

  private enqueueDiscordEvent(type:string,aggregateId:string,payload:unknown,now:number):string {
    const settings=this.config<Record<string,unknown>>('discord_integration',{});
    const toggle=type.startsWith('idea.')?'notifyIdeas':type==='level.up'?'notifyLevels':type==='mystery.drop'?'notifyDrops':type.startsWith('mystery.drop.')?'discordDropsEnabled':type.startsWith('quest.')?'notifyQuests':type==='elio.rare'?'notifyElioEvents':type==='chaos-wheel.action'?'notifyChaosWheel':type==='seasonal.event'?'notifySeasonal':type.startsWith('twitch.live')?'notifyLive':null;
    if(settings.enabled!==true||!toggle||settings[toggle]!==true)return '';
    const category=type.startsWith('idea.')?'Ideas':type==='level.up'?'Levels':type.startsWith('mystery.drop')?'Drops':type.startsWith('quest.')?'Quests':type==='elio.rare'?'Elio':type==='chaos-wheel.action'?'ChaosWheel':type==='seasonal.event'?'Seasonal':'Live';
    const configured=settings[`mention${category}`],mode=category==='Levels'&&configured==='user'?'user':configured==='everyone'?'everyone':'none';
    const data=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
    const mention:{mode:'none'|'everyone'|'user';discordUserId?:string}={mode};
    if(mode==='user'&&settings.accountLinkEnabled===true&&typeof data.userId==='string'){
      const discordUserId=this.communityDiscordIdForTwitch(data.userId);
      if(discordUserId&&/^\d{17,20}$/u.test(discordUserId))mention.discordUserId=discordUserId;
    }
    const publicData={...data};delete publicData.userId;
    const eventPayload={...publicData,discordMention:mention};
    const id=randomUUID();this.db.prepare("INSERT INTO discord_event_outbox(id,event_type,aggregate_id,payload_json,created_at,available_at) VALUES(?,?,?,?,?,?)")
      .run(id,type,aggregateId,JSON.stringify(eventPayload),now,now);return id;
  }

  discordOutboxBatch(now:number,limit=25):Array<{id:string;type:string;aggregateId:string;payload:unknown;createdAt:number;attempts:number}> {
    return this.db.transaction(()=>{
      this.db.prepare("DELETE FROM discord_event_outbox WHERE status='delivered' AND delivered_at<?").run(now-90*24*60*60_000);
      this.db.prepare('DELETE FROM discord_event_inbox WHERE created_at<?').run(now-90*24*60*60_000);
      const rows=this.db.prepare("SELECT id,event_type,aggregate_id,payload_json,created_at,attempts FROM discord_event_outbox WHERE ((status='pending' AND available_at<=?) OR (status='leased' AND lease_until<=?)) ORDER BY created_at,id LIMIT ?")
        .all(now,now,Math.max(1,Math.min(50,limit))) as Array<{id:string;event_type:string;aggregate_id:string;payload_json:string;created_at:number;attempts:number}>;
      const lease=this.db.prepare("UPDATE discord_event_outbox SET status='leased',lease_until=? WHERE id=?");
      for(const row of rows)lease.run(now+30_000,row.id);
      return rows.map(row=>({id:row.id,type:row.event_type,aggregateId:row.aggregate_id,payload:JSON.parse(row.payload_json) as unknown,createdAt:row.created_at,attempts:row.attempts}));
    })();
  }

  settleDiscordOutbox(id:string,success:boolean,now:number,error?:string):boolean {
    if(success)return this.db.prepare("UPDATE discord_event_outbox SET status='delivered',delivered_at=?,lease_until=NULL,last_error=NULL WHERE id=? AND status='leased'").run(now,id).changes===1;
    const row=this.db.prepare("SELECT attempts FROM discord_event_outbox WHERE id=? AND status='leased'").get(id) as {attempts:number}|undefined;if(!row)return false;
    const attempts=row.attempts+1,dead=attempts>=8,backoff=Math.min(6*60*60_000,15_000*2**Math.min(attempts-1,10));
    return this.db.prepare("UPDATE discord_event_outbox SET status=?,attempts=?,available_at=?,lease_until=NULL,last_error=? WHERE id=? AND status='leased'")
      .run(dead?'dead':'pending',attempts,now+backoff,(error||'delivery failed').slice(0,300),id).changes===1;
  }

  discordOutboxStats():{pending:number;leased:number;dead:number;delivered:number} {
    const rows=this.db.prepare('SELECT status,COUNT(*) AS n FROM discord_event_outbox GROUP BY status').all() as Array<{status:string;n:number}>;
    const result={pending:0,leased:0,dead:0,delivered:0};for(const row of rows)if(row.status in result)result[row.status as keyof typeof result]=row.n;return result;
  }

  discordOutboxFailures(limit=25):Array<{id:string;type:string;attempts:number;lastError:string|null;createdAt:number}> {
    return this.db.prepare("SELECT id,event_type type,attempts,last_error lastError,created_at createdAt FROM discord_event_outbox WHERE status='dead' ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1,Math.min(100,limit))) as Array<{id:string;type:string;attempts:number;lastError:string|null;createdAt:number}>;
  }

  retryDiscordOutbox(id:string,now:number):boolean {
    return this.db.prepare("UPDATE discord_event_outbox SET status='pending',attempts=0,available_at=?,lease_until=NULL,last_error=NULL WHERE id=? AND status='dead'")
      .run(now,id).changes===1;
  }

  recordDiscordLiveTransition(live:boolean,stream:{id:string;title?:string;game_name?:string;viewer_count?:number;started_at?:string;thumbnail_url?:string;profile_image_url?:string}|undefined,now:number):void {
    this.db.transaction(()=>{
      const settings=this.config<{enabled?:boolean;notifyLive?:boolean;liveUpdateEnabled?:boolean;liveUpdateIntervalSeconds?:number}>('discord_integration',{});
      const previous=this.state<{live:boolean;streamId?:string|null;title?:string;gameName?:string;discordEnabled?:boolean;notifyLive?:boolean;lastDiscordUpdateAt?:number;viewerCount?:number;startedAt?:string;thumbnailUrl?:string;profileImageUrl?:string}|null>('discord_live_state',null);
      const streamId=live?stream?.id||null:null,title=live?stream?.title||'':previous?.title||'',gameName=live?stream?.game_name||'':previous?.gameName||'';
      const sameStream=Boolean(live&&previous?.live&&streamId&&previous.streamId===streamId);
      const enabled=settings.enabled===true&&settings.notifyLive===true;
      const viewerCount=live&&typeof stream?.viewer_count==='number'?stream.viewer_count:previous?.viewerCount;
      const startedAt=live?stream?.started_at||previous?.startedAt:previous?.startedAt;
      const thumbnailUrl=live?stream?.thumbnail_url||previous?.thumbnailUrl:previous?.thumbnailUrl;
      const profileImageUrl=live?stream?.profile_image_url||previous?.profileImageUrl:previous?.profileImageUrl;
      let lastDiscordUpdateAt=previous?.lastDiscordUpdateAt||0;
      if(previous?.live&&!live&&enabled){this.enqueueDiscordEvent('twitch.live',`${previous.streamId||'stream'}:ended`,{active:false,streamId:previous.streamId||null,title:previous.title||'',gameName:previous.gameName||'',startedAt,endedAt:now,profileImageUrl},now);lastDiscordUpdateAt=now;}
      else if(live&&enabled&&(!previous?.live||!sameStream||((!previous.discordEnabled||!previous.notifyLive)))){
        this.enqueueDiscordEvent('twitch.live',streamId||`stream:${now}`,{active:true,streamId,title,gameName,viewerCount,startedAt,thumbnailUrl,profileImageUrl},now);lastDiscordUpdateAt=now;
      }
      else if(sameStream&&enabled&&settings.liveUpdateEnabled!==false){
        const metadataChanged=previous?.title!==title||previous?.gameName!==gameName;
        const interval=Math.max(60,Math.min(900,Number(settings.liveUpdateIntervalSeconds)||300))*1000;
        if(metadataChanged||now-lastDiscordUpdateAt>=interval){
          this.enqueueDiscordEvent('twitch.live.update',`${streamId}:${now}`,{active:true,streamId,title,gameName,viewerCount,startedAt,thumbnailUrl,profileImageUrl},now);lastDiscordUpdateAt=now;
        }
      }
      this.setState('discord_live_state',{live,streamId,title,gameName,viewerCount,startedAt,thumbnailUrl,profileImageUrl,lastDiscordUpdateAt,discordEnabled:settings.enabled===true,notifyLive:settings.notifyLive===true},now);
    })();
  }

  submitDiscordCommunityIdea(input:{eventId:string;id:string;discordUserId:string;displayName:string;text:string;category:string;now:number}):{ok:true;idea:CommunityIdea;duplicateEvent?:boolean}|{ok:false;reason:'duplicate'|'cooldown'|'limit'|'invalid';duplicateEvent?:boolean} {
    const text=input.text.normalize('NFKC').replace(/\s+/gu,' ').trim();
    if(text.length<8||text.length>240||!/^\d{17,20}$/u.test(input.eventId)||!/^\d{17,20}$/u.test(input.discordUserId)||!input.id)return {ok:false,reason:'invalid'};
    return this.db.transaction(()=>{
      const previous=this.db.prepare('SELECT result_json FROM discord_event_inbox WHERE event_id=?').get(input.eventId) as {result_json:string}|undefined;
      if(previous)return {...JSON.parse(previous.result_json) as {ok:true;idea:CommunityIdea}|{ok:false;reason:'duplicate'|'cooldown'|'limit'|'invalid'},duplicateEvent:true};
      const userId=`discord:${input.discordUserId}`,normalized=text.toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
      const same=this.db.prepare("SELECT 1 FROM community_ideas WHERE submitter_user_id=? AND normalized_text=? AND status NOT IN ('rejected','archived') AND submitted_at>? LIMIT 1").get(userId,normalized,input.now-90*24*60*60_000);
      const open=this.db.prepare("SELECT COUNT(*) AS n FROM community_ideas WHERE submitter_user_id=? AND status IN ('pending','reviewing','approved','voting')").get(userId) as {n:number};
      const cooldown=this.db.prepare('SELECT last_used_at FROM feature_cooldowns WHERE feature=? AND user_id=?').get('community-idea',userId) as {last_used_at:number}|undefined;
      const reason:'duplicate'|'limit'|'cooldown'|null=same?'duplicate':open.n>=5?'limit':cooldown&&cooldown.last_used_at+600_000>input.now?'cooldown':null;
      if(reason){const result={ok:false as const,reason};this.db.prepare('INSERT INTO discord_event_inbox(event_id,result_json,created_at) VALUES(?,?,?)').run(input.eventId,JSON.stringify(result),input.now);return result;}
      this.db.prepare("INSERT INTO community_ideas(id,submitter_user_id,display_name,idea_text,normalized_text,category,status,submitted_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)")
        .run(input.id,userId,input.displayName.replace(/[\u0000-\u001f\u007f]/gu,' ').slice(0,48),text,normalized,input.category.slice(0,40),input.now,input.now);
      this.db.prepare("INSERT INTO feature_cooldowns(feature,user_id,last_used_at) VALUES('community-idea',?,?) ON CONFLICT(feature,user_id) DO UPDATE SET last_used_at=excluded.last_used_at").run(userId,input.now);
      this.recordCommunityEvent('community.idea.submitted',{id:input.id,source:'discord'},input.now);
      const idea=this.communityIdea(input.id,userId)!;
      this.enqueueDiscordEvent('idea.submitted',input.id,{id:idea.id,text:idea.text,displayName:idea.displayName,category:idea.category,status:idea.status,submittedAt:input.now},input.now);
      const result={ok:true as const,idea};this.db.prepare('INSERT INTO discord_event_inbox(event_id,result_json,created_at) VALUES(?,?,?)').run(input.eventId,JSON.stringify(result),input.now);return result;
    })();
  }

  voteDiscordCommunityIdea(input:{eventId:string;ideaId:string;discordUserId:string;now:number}):{ok:boolean;reason?:string;votes?:number;duplicateEvent?:boolean} {
    if(!/^\d{17,20}$/u.test(input.eventId)||!/^\d{17,20}$/u.test(input.discordUserId))return {ok:false,reason:'invalid'};
    return this.db.transaction(()=>{
      const previous=this.db.prepare('SELECT result_json FROM discord_event_inbox WHERE event_id=?').get(input.eventId) as {result_json:string}|undefined;
      if(previous)return {...JSON.parse(previous.result_json) as {ok:boolean;reason?:string;votes?:number},duplicateEvent:true};
      const userId=`discord:${input.discordUserId}`;
      const inserted=this.db.prepare("INSERT OR IGNORE INTO community_idea_votes(idea_id,user_id,created_at) SELECT id,?,? FROM community_ideas WHERE id=? AND status='approved'")
        .run(userId,input.now,input.ideaId);
      const idea=this.communityIdea(input.ideaId);
      const response=inserted.changes===1&&idea?{ok:true as const,votes:idea.votes}:{ok:false as const,reason:idea?'already-voted-or-closed':'not-found'};
      if(response.ok)this.enqueueDiscordEvent('idea.vote',input.ideaId,{id:input.ideaId,votes:response.votes},input.now);
      this.db.prepare('INSERT INTO discord_event_inbox(event_id,result_json,created_at) VALUES(?,?,?)').run(input.eventId,JSON.stringify(response),input.now);
      return response;
    })();
  }

  categorizeCommunityIdea(id:string,category:string,moderatorId:string,now:number):boolean {
    return this.db.prepare('UPDATE community_ideas SET category=?,updated_at=?,moderated_by=? WHERE id=?').run(category,now,moderatorId,id).changes===1;
  }

  linkIdeasToPoll(ids:string[],now:number):boolean {
    if(ids.length<2||ids.length>5||new Set(ids).size!==ids.length)return false;
    return this.db.transaction(()=>{
      const rows=ids.map(id=>this.db.prepare("SELECT id FROM community_ideas WHERE id=? AND status='approved'").get(id));
      if(rows.some(row=>!row))return false;
      const update=this.db.prepare("UPDATE community_ideas SET status='voting',updated_at=? WHERE id=? AND status='approved'");
      return ids.every(id=>update.run(now,id).changes===1);
    })();
  }

  markIdeasVoting(ids:string[],now:number):boolean {
    if(ids.length<2||ids.length>5||new Set(ids).size!==ids.length)return false;
    return this.db.transaction(()=>{
      const placeholders=ids.map(()=>'?').join(',');
      const result=this.db.prepare(`UPDATE community_ideas SET status='voting',updated_at=? WHERE status='approved' AND id IN (${placeholders})`).run(now,...ids);
      return result.changes===ids.length;
    })();
  }

  deleteExpiredViewerData(now:number):void {
    this.db.prepare('DELETE FROM community_viewer_sessions WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM community_viewer_oauth_states WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM community_account_link_intents WHERE expires_at<=? OR used_at IS NOT NULL AND used_at<?').run(now,now-30*24*60*60_000);
    this.db.prepare('DELETE FROM community_account_link_oauth_states WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM community_account_link_audit WHERE created_at<?').run(now-180*24*60*60_000);
  }

  questsBySubmitter(userId:string,limit=20):QuestRecord[] {
    const rows=this.db.prepare('SELECT * FROM quests WHERE submitter_user_id=? ORDER BY submitted_at DESC LIMIT ?').all(userId,Math.max(1,Math.min(50,limit))) as QuestRow[];
    return rows.map(row=>this.toQuest(row));
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
      this.db.prepare(`INSERT INTO spark_proposals(id,channel_id,topic_id,topic_label,score,participant_count,message_count,action_type,suggestion_text,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending_approval',?,?)`).run(input.id,input.channelId,input.topicId,input.topicLabel,input.score,
          input.participants,input.messages,input.actionType,input.suggestionText??null,input.createdAt,input.expiresAt);
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
      score:Number(r.score),participants:Number(r.participant_count),messages:Number(r.message_count),actionType:r.action_type as SparkProposal['actionType'],suggestionText:r.suggestion_text?String(r.suggestion_text):null,
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
      this.recordCommunityEvent('quest.status.changed', { id, status: target, title: target === 'active'||target==='completed' ? current.title : undefined,
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
      const ideaIds=input.options.map(option=>option.ideaId).filter((value):value is string=>Boolean(value));
      if(ideaIds.length&& (input.type!=='chat'||ideaIds.length!==input.options.length||new Set(ideaIds).size!==ideaIds.length
        ||ideaIds.some(id=>!this.db.prepare("SELECT 1 FROM community_ideas WHERE id=? AND status='approved'").get(id))))return undefined;
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

  pollVoteOption(pollId:string,userId:string):number|undefined {
    const row=this.db.prepare('SELECT option_index FROM poll_votes WHERE poll_id=? AND user_id=?').get(pollId,userId) as {option_index:number}|undefined;
    return row?row.option_index+1:undefined;
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
        const options=parsePollOptions((this.db.prepare('SELECT options_json FROM polls WHERE id=?').get(id) as {options_json:string}).options_json);
        for(const option of options)if(option.ideaId)this.db.prepare("UPDATE community_ideas SET status='approved',updated_at=? WHERE id=? AND status='voting'").run(now,option.ideaId);
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
    if (type === 'vault') {
      const row=this.db.prepare("SELECT status,started_at,ends_at,attempts_count,last_public_hint,last_public_hint_at,winner_name,result_code,updated_at FROM community_vault_rounds ORDER BY updated_at DESC LIMIT 1")
        .get() as {status:string;started_at:number;ends_at:number;attempts_count:number;last_public_hint:string|null;last_public_hint_at:number|null;winner_name:string|null;result_code:string|null;updated_at:number}|undefined;
      if(!row || (row.status!=='active' && now-row.updated_at>15_000))return {type,visible:false,capturedAt:now};
      return {type,visible:true,vault:{status:row.status,startedAt:row.started_at,endsAt:row.ends_at,attempts:row.attempts_count,
        lastHint:row.last_public_hint,winnerName:row.winner_name,result:row.status==='opened'?'Tresor geöffnet':row.status==='expired'?'Zeit abgelaufen':null,resultCode:row.status==='active'?null:row.result_code},capturedAt:now};
    }
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
    for(const option of options)if(option.ideaId)this.db.prepare("UPDATE community_ideas SET status='approved',updated_at=? WHERE id=? AND status='voting'").run(now,option.ideaId);
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

  recordRecentChatActivity(userId:string,displayName:string,login:string,now:number):void {
    this.db.prepare(`INSERT INTO recent_chat_activity(user_id,display_name,login,last_activity_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,login=excluded.login,last_activity_at=excluded.last_activity_at`)
      .run(userId,displayName,login,now);
    this.db.prepare('DELETE FROM recent_chat_activity WHERE last_activity_at<?').run(now-24*60*60_000);
  }

  recentChatActivity(now:number,windowMinutes:number,excludeUserIds:string[]=[]):Array<{userId:string;displayName:string;login:string;lastActivityAt:number}> {
    const cutoff=now-Math.max(1,Math.min(120,windowMinutes))*60_000;
    this.db.prepare('DELETE FROM recent_chat_activity WHERE last_activity_at<?').run(now-24*60*60_000);
    const exclusions=excludeUserIds.length?` AND user_id NOT IN (${excludeUserIds.map(()=>'?').join(',')})`:'';
    return this.db.prepare(`SELECT user_id userId,display_name displayName,login,last_activity_at lastActivityAt FROM recent_chat_activity WHERE last_activity_at>=?${exclusions} ORDER BY user_id`)
      .all(cutoff,...excludeUserIds) as Array<{userId:string;displayName:string;login:string;lastActivityAt:number}>;
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
    const before=this.db.prepare('SELECT xp FROM xp_users WHERE user_id=?').get(userId) as {xp:number}|undefined;
    const inserted = this.db.prepare('INSERT OR IGNORE INTO xp_ledger(event_id,user_id,amount,reason,created_at) VALUES(?,?,?,?,?)')
      .run(eventId, userId, amount, reason, now);
    if (!inserted.changes) return 0;
    this.db.prepare(`INSERT INTO xp_users(user_id,display_name,xp,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,xp=xp_users.xp+excluded.xp,updated_at=excluded.updated_at`)
      .run(userId, displayName, amount, now);
    const after=(before?.xp||0)+amount,base=Math.max(1,Number(this.config<{levelBase?:number}>('xp_settings',{levelBase:100}).levelBase)||100);
    const oldLevel=1+Math.floor(Math.sqrt(Math.max(0,before?.xp||0)/base)),newLevel=1+Math.floor(Math.sqrt(after/base));
    if(newLevel>oldLevel)this.enqueueDiscordEvent('level.up',eventId,{userId,displayName:displayName.slice(0,48),level:newLevel},now);
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

  /** Atomically checks and records personal plus channel-wide cooldowns. A denied attempt writes neither timestamp. */
  useCooldownPair(feature: string, userId: string, now: number, personalMs: number, globalMs: number):
    { blocked: 'personal' | 'global'; remainingMs: number } | undefined {
    return this.db.transaction(() => {
      const read = (key: string) => this.db.prepare('SELECT last_used_at FROM feature_cooldowns WHERE feature=? AND user_id=?').get(feature, key) as {last_used_at:number}|undefined;
      const personal = read(userId);
      if (personal && personalMs > 0 && now - personal.last_used_at < personalMs)
        return { blocked: 'personal' as const, remainingMs: personalMs - (now - personal.last_used_at) };
      const global = read('__channel_global__');
      if (global && globalMs > 0 && now - global.last_used_at < globalMs)
        return { blocked: 'global' as const, remainingMs: globalMs - (now - global.last_used_at) };
      const upsert = this.db.prepare(`INSERT INTO feature_cooldowns(feature,user_id,last_used_at) VALUES(?,?,?)
        ON CONFLICT(feature,user_id) DO UPDATE SET last_used_at=excluded.last_used_at`);
      if (personalMs > 0) upsert.run(feature, userId, now);
      if (globalMs > 0) upsert.run(feature, '__channel_global__', now);
      return undefined;
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
      this.recordCommunityEvent(active ? 'seasonal.event.started' : 'seasonal.event.ended', { id, name: event.name, emoji: event.emoji, active }, now);
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
    const data=(payload&&typeof payload==='object'?payload:{}) as Record<string,unknown>;
    if(type==='quest.status.changed'&&data.status==='active')this.enqueueDiscordEvent('quest.started',String(data.id||`quest:${now}`),{title:String(data.title||'Eine Community-Quest'),status:'active'},now);
    if(type==='quest.status.changed'&&data.status==='completed')this.enqueueDiscordEvent('quest.completed',String(data.id||`quest:${now}`),{title:String(data.title||'Eine Community-Quest'),status:'completed'},now);
    if(type==='elio.rare')this.enqueueDiscordEvent('elio.rare',String(data.id||`elio:${now}`),{message:String(data.message||'Elio hat ein seltenes Ereignis erlebt.')},now);
    if(type==='chaos-wheel.action')this.enqueueDiscordEvent('chaos-wheel.action',String(data.id||`wheel:${now}`),{title:String(data.title||'Eine besondere Aktion'),actionType:String(data.actionType||'action')},now);
    if(type==='seasonal.event.started'||type==='seasonal.event.ended')this.enqueueDiscordEvent('seasonal.event',String(data.id||`season:${now}`),data,now);
    if(type==='mystery.drop.completed'&&Number(data.participants)>0)this.enqueueDiscordEvent('mystery.drop',String(data.id||`drop:${now}`),{participants:Number(data.participants)},now);
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
        ...(option.questId ? { questId: option.questId } : {}), ...(option.ideaId?{ideaId:option.ideaId}:{}) };
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
      && (!('questId' in (entry as object)) || typeof (entry as PollOptionInput).questId === 'string')
      && (!('ideaId' in (entry as object)) || typeof (entry as PollOptionInput).ideaId === 'string'));
  } catch { return []; }
}

function toChannelRedemption(row:Record<string,unknown>):ChannelRedemptionRecord {
  return {redemptionId:String(row.redemption_id),rewardId:String(row.reward_id),userId:String(row.user_id),displayName:String(row.display_name),
    userInput:String(row.quest_title??row.user_input),redeemedAt:Number(row.redeemed_at),status:row.status as ChannelRedemptionStatus,
    questId:row.quest_id?String(row.quest_id):null,questStatus:row.quest_status?row.quest_status as QuestStatus:null,
    lastError:row.last_error?String(row.last_error):null,updatedAt:Number(row.updated_at)};
}

function toCommunityIdea(row:Record<string,unknown>):CommunityIdea {
  return {id:String(row.id),submitterUserId:String(row.submitter_user_id),displayName:String(row.display_name),text:String(row.idea_text),
    category:row.category===null?null:String(row.category),status:String(row.status) as IdeaStatus,submittedAt:Number(row.submitted_at),updatedAt:Number(row.updated_at),
    moderationComment:row.moderation_comment===null?null:String(row.moderation_comment),votes:Number(row.votes||0),voted:Boolean(row.voted)};
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
