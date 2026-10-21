import { clampChatMessage } from './chat.js';

export const CHAT_CATEGORIES = {
  community: { emoji: '🤖', label: 'COMMUNITY' },
  communityPortal: { emoji: '💜', label: 'COMMUNITY' },
  tip: { emoji: '💡', label: 'COMMUNITY-TIPP' },
  info: { emoji: '📢', label: 'INFO' },
  attack: { emoji: '⚔️', label: 'ANGRIFF' },
  boss: { emoji: '👹', label: 'BOSS' },
  halloween: { emoji: '🎃', label: 'HALLOWEEN' },
  season: { emoji: '✨', label: 'SAISON-EVENT' },
  drop: { emoji: '🎁', label: 'DROP' },
  wheel: { emoji: '🎡', label: 'GLÜCKSRAD' },
  vault: { emoji: '🔐', label: 'TRESOR' },
  pet: { emoji: '🐱', label: 'ELIO' },
  imposter: { emoji: '🎭', label: 'IMPOSTER' },
  detective: { emoji: '🕵️', label: 'DETEKTIV' },
  quest: { emoji: '📜', label: 'QUEST' },
  ideas: { emoji: '✨', label: 'CHAT-IDEEN' },
  poll: { emoji: '🗳️', label: 'UMFRAGE' },
  oracle: { emoji: '🎱', label: 'ORAKEL' },
  duel: { emoji: '⚔️', label: 'DUELL' },
  guess: { emoji: '🔢', label: 'ZAHLENRATEN' },
  rps: { emoji: '✂️', label: 'SCHERE-STEIN-PAPIER' },
  xp: { emoji: '⭐', label: 'XP' },
  help: { emoji: '❓', label: 'HILFE' },
  welcome: { emoji: '👋', label: 'BEGRÜSSUNG' },
  hint: { emoji: '⚠️', label: 'HINWEIS' },
  cooldown: { emoji: '⏳', label: 'WARTEZEIT' },
  custom: { emoji: '💬', label: 'CHAT-BEFEHL' },
} as const;

export type ChatCategory = keyof typeof CHAT_CATEGORIES;
export interface OutboundChatMessage { message: string; category: ChatCategory }

const COMMAND_CATEGORY_ENTRIES: Array<[string[], ChatCategory]> = [
  [['attack'], 'attack'], [['boss','bosstop','startboss','endboss'], 'boss'],
  [['trickortreat','pumpkins','top','halloween','starthalloween','endhalloween','resethalloween'], 'halloween'],
  [['gift','egghunt','eventscore','eventtop','startevent','endevent'], 'season'],
  [['drop','claim','dropstats','drops','startdrop','canceldrop'], 'drop'],
  [['spin','wheel','wheelstatus','startwheel','cancelwheel'], 'wheel'],
  [['pet','feed','play','petcare','petstats','petname','petevolution','pethelp','setpetname','petpause','petresume'], 'pet'],
  [['imposter','imposterstatus','joinimposter','leaveimposter','startimposter','closeimposter','cancelimposter','sus'], 'imposter'],
  [['code'], 'vault'],
  [['detektiv','startdetektiv','wer','quote','skipdetektiv','enddetektiv','quoteoptin','quoteoptout','savequote','myquotes','deletequote'], 'detective'],
  [['quest','quests','myquest','questhelp','questqueue','approvequest','rejectquest','skipquest'], 'quest'],
  [['spark','sparkhelp','sparks','sparktopics','sparktop','sparkapprove','sparkreject','sparkpause','sparkresume'], 'ideas'],
  [['poll','vote','pollresults','questvote'], 'poll'],
  [['8ball'], 'oracle'], [['duel','accept','cancelduel'], 'duel'],
  [['guess','startguess'], 'guess'], [['rps'], 'rps'],
  [['level','rank','xptop'], 'xp'], [['help'], 'help'],
  [['addcommand','setcommand','delcommand'], 'custom'],
  [['welcome'], 'welcome'],
  [['community','discord'], 'communityPortal'],
];
const COMMAND_CATEGORIES: Record<string, ChatCategory> = Object.fromEntries(
  COMMAND_CATEGORY_ENTRIES.flatMap(([commands, category]) => commands.map(command => [command, category] as const)),
);

export function categoryForCommand(command: string): ChatCategory {
  return COMMAND_CATEGORIES[command.replace(/^!/u, '').trim().toLowerCase()] ?? 'community';
}

const PREFIX = /^(?:【[^】]{1,48}】\s*)+/u;

/** Adds the one public identity marker at the final send boundary. */
export function formatPublicChatMessage(message: string, category: ChatCategory = 'community', maxLength = 500): string {
  const safeCategory = Object.hasOwn(CHAT_CATEGORIES, category) ? category : 'community';
  const body = message.trim().replace(PREFIX, '').trimStart();
  const { emoji, label } = CHAT_CATEGORIES[safeCategory];
  return clampChatMessage(`【${emoji} ${label}】 ${body}`, maxLength);
}
