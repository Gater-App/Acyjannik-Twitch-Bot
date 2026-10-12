import 'dotenv/config';
import type { AppConfig, EventWeights, GameTexts, PointRange } from './types.js';

const DEFAULT_WEIGHTS: EventWeights = {
  TREAT: 48,
  TRICK: 25,
  JACKPOT: 5,
  GHOST: 8,
  WITCH: 8,
  EMPTY_HOUSE: 5,
  GOLDEN_PUMPKIN: 1,
};

const DEFAULT_TEXTS: GameTexts = {
  treat: '🎃 {name} bekommt {points} Kürbisse!',
  trick: '👻 {name} verliert {points} Kürbisse!',
  jackpot: '💰 JACKPOT! {name} gewinnt {points} Kürbisse!',
  ghost: '👻 Ein Geist erschreckt {name}: -{points} Kürbisse!',
  witch: '🧙 Die Hexe segnet {name}: +{points} Kürbisse!',
  emptyHouse: '🏚️ {name} findet ein leeres Haus.',
  goldenPumpkin: '✨ GOLDENER KÜRBIS! {name} erhält {points} Kürbisse!',
};

function stringValue(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function requiredString(name: string): string {
  const value = stringValue(name);
  if (!value) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = stringValue(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} muss eine ganze Zahl >= 0 sein.`);
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = stringValue(name);
  if (!raw) return fallback;
  if (['true', '1', 'yes', 'ja'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no', 'nein'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} muss true oder false sein.`);
}

function jsonValue<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} enthält kein gültiges JSON.`);
  }
}

function listValue(name: string): string[] {
  return stringValue(name)
    .split(/[ ,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function range(minName: string, maxName: string, defaultMin: number, defaultMax: number): PointRange {
  const min = positiveInt(minName, defaultMin);
  const max = positiveInt(maxName, defaultMax);
  if (max < min) throw new Error(`${maxName} darf nicht kleiner als ${minName} sein.`);
  return { min, max };
}

function validateWeights(weights: EventWeights): EventWeights {
  const keys: Array<keyof EventWeights> = [
    'TREAT', 'TRICK', 'JACKPOT', 'GHOST', 'WITCH', 'EMPTY_HOUSE', 'GOLDEN_PUMPKIN',
  ];
  for (const key of keys) {
    const value = weights[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`EVENT_WEIGHTS_JSON.${key} muss eine Zahl >= 0 sein.`);
    }
  }
  if (keys.every((key) => weights[key] === 0)) throw new Error('Mindestens ein Ereignisgewicht muss größer als 0 sein.');
  return weights;
}

export function loadConfig(options: { testMode?: boolean } = {}): AppConfig {
  const testMode = options.testMode ?? booleanValue('TEST_MODE', false);
  const weights = validateWeights({ ...DEFAULT_WEIGHTS, ...jsonValue<Partial<EventWeights>>('EVENT_WEIGHTS_JSON', {}) });
  const texts = { ...DEFAULT_TEXTS, ...jsonValue<Partial<GameTexts>>('TEXTS_JSON', {}) };

  const config: AppConfig = {
    testMode,
    clientId: stringValue('TWITCH_CLIENT_ID', testMode ? 'test-client' : requiredString('TWITCH_CLIENT_ID')),
    clientSecret: stringValue('TWITCH_CLIENT_SECRET', testMode ? 'test-secret' : requiredString('TWITCH_CLIENT_SECRET')),
    channelLogin: stringValue('TWITCH_CHANNEL_LOGIN', 'yannick').toLowerCase(),
    botLogin: stringValue('TWITCH_BOT_LOGIN', testMode ? 'test-bot' : requiredString('TWITCH_BOT_LOGIN')).toLowerCase(),
    broadcasterUserId: stringValue('TWITCH_BROADCASTER_USER_ID', testMode ? 'test-broadcaster' : ''),
    botUserId: stringValue('TWITCH_BOT_USER_ID', testMode ? 'test-bot' : ''),
    redirectUri: stringValue('TWITCH_REDIRECT_URI', 'http://127.0.0.1:3000/oauth/callback'),
    oauthHost: stringValue('OAUTH_HOST', '127.0.0.1'),
    oauthPort: positiveInt('OAUTH_PORT', 3000),
    oauthStateTtlMs: positiveInt('OAUTH_STATE_TTL_SECONDS', 600) * 1000,
    oauthScopes: stringValue('OAUTH_SCOPES', 'user:read:chat user:write:chat').split(/\s+/u).filter(Boolean),
    tokenFile: stringValue('TOKEN_FILE', 'data/oauth-tokens.json'),
    databasePath: stringValue('DATABASE_PATH', 'data/halloween.sqlite'),
    activeOnStart: booleanValue('HALLOWEEN_ACTIVE_ON_START', false),
    authorizedModeratorIds: listValue('AUTHORIZED_MODERATOR_IDS'),
    cooldownMs: positiveInt('HALLOWEEN_COOLDOWN_MINUTES', 15) * 60 * 1000,
    eventWeights: weights,
    gameValues: {
      treat: range('TREAT_MIN', 'TREAT_MAX', 5, 20),
      trick: range('TRICK_MIN', 'TRICK_MAX', 1, 10),
      jackpot: range('JACKPOT_MIN', 'JACKPOT_MAX', 25, 50),
      ghost: range('GHOST_MIN', 'GHOST_MAX', 1, 10),
      witch: range('WITCH_MIN', 'WITCH_MAX', 10, 25),
      goldenPumpkin: range('GOLDEN_PUMPKIN_MIN', 'GOLDEN_PUMPKIN_MAX', 50, 100),
    },
    texts,
    maxChatMessageLength: positiveInt('MAX_CHAT_MESSAGE_LENGTH', 500),
    appChatMessageLength: positiveInt('APP_CHAT_MESSAGE_LENGTH', 450),
    sendQueueIntervalMs: positiveInt('SEND_QUEUE_INTERVAL_MS', 1100),
  };

  if (config.appChatMessageLength > config.maxChatMessageLength) {
    throw new Error('APP_CHAT_MESSAGE_LENGTH darf MAX_CHAT_MESSAGE_LENGTH nicht überschreiten.');
  }
  if (process.env.TWITCH_ACCESS_TOKEN) config.accessToken = process.env.TWITCH_ACCESS_TOKEN.trim();
  if (process.env.TWITCH_REFRESH_TOKEN) config.refreshToken = process.env.TWITCH_REFRESH_TOKEN.trim();
  return config;
}
