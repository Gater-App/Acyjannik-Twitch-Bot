export type HalloweenEvent =
  | 'TREAT'
  | 'TRICK'
  | 'JACKPOT'
  | 'GHOST'
  | 'WITCH'
  | 'EMPTY_HOUSE'
  | 'GOLDEN_PUMPKIN';

export interface EventWeights {
  TREAT: number;
  TRICK: number;
  JACKPOT: number;
  GHOST: number;
  WITCH: number;
  EMPTY_HOUSE: number;
  GOLDEN_PUMPKIN: number;
}

export interface PointRange {
  min: number;
  max: number;
}

export interface GameValues {
  treat: PointRange;
  trick: PointRange;
  jackpot: PointRange;
  ghost: PointRange;
  witch: PointRange;
  goldenPumpkin: PointRange;
}

export interface GameTexts {
  treat: string;
  trick: string;
  jackpot: string;
  ghost: string;
  witch: string;
  emptyHouse: string;
  goldenPumpkin: string;
}

export interface AppConfig {
  testMode: boolean;
  clientId: string;
  clientSecret: string;
  channelLogin: string;
  botLogin: string;
  broadcasterUserId: string;
  botUserId: string;
  redirectUri: string;
  redemptionRedirectUri: string;
  redemptionTokenFile: string;
  vipRedirectUri: string;
  vipTokenFile: string;
  oauthHost: string;
  oauthPort: number;
  oauthStateTtlMs: number;
  oauthScopes: string[];
  tokenFile: string;
  databasePath: string;
  activeOnStart: boolean;
  authorizedModeratorIds: string[];
  cooldownMs: number;
  eventWeights: EventWeights;
  gameValues: GameValues;
  texts: GameTexts;
  maxChatMessageLength: number;
  appChatMessageLength: number;
  sendQueueIntervalMs: number;
  accessToken?: string;
  refreshToken?: string;
}

export interface ChatMessage {
  eventId: string;
  messageId?: string;
  broadcasterUserId: string;
  senderUserId: string;
  senderLogin: string;
  senderDisplayName: string;
  message: string;
  sentAt: number;
  isModerator?: boolean;
  /** Set only from Twitch's EventSub chat badges, never from a browser request. */
  isVip?: boolean;
}

export interface Player {
  userId: string;
  displayName: string;
  pumpkins: number;
  updatedAt: number;
}

export interface GameOutcome {
  event: HalloweenEvent;
  delta: number;
  pumpkins: number;
}

export interface CommandReply {
  message: string;
  replyParentMessageId?: string;
  category?: import('./chat-message-format.js').ChatCategory;
  /** Explicitly grouped poll announcements must not be split by ordinary reply suppression. */
  bypassResponsePolicy?: boolean;
}
