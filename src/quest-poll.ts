import type { AppConfig, ChatMessage } from './types.js';
import { FeatureStore, type QuestPolicy, type QuestStatus } from './feature-store.js';

export interface QuestSettings extends QuestPolicy {
  enabled: boolean;
  chatEnabled: boolean;
  channelPointsEnabled: boolean;
  modsCanModerate: boolean;
  modsCanSkip: boolean;
  moderatorUserIds: string[];
}

export interface PollSettings {
  enabled: boolean;
  durationMs: number;
  allowVoteChange: boolean;
  ignoredUserIds: string[];
}

const DEFAULT_QUEST_SETTINGS: QuestSettings = {
  enabled: true, chatEnabled: true, channelPointsEnabled: false, maxLength: 180,
  queueLimit: 100, maxOpenPerUser: 2, cooldownMs: 300_000, activeDurationMs: 0,
  completionXp: 25, modsCanModerate: false, modsCanSkip: false, moderatorUserIds: [],
};

const DEFAULT_POLL_SETTINGS: PollSettings = { enabled: true, durationMs: 60_000, allowVoteChange: true, ignoredUserIds: [] };

const STATUS_LABEL: Record<QuestStatus, string> = {
  pending: 'wartet auf Freigabe', approved: 'freigegeben', active: 'läuft', completed: 'abgeschlossen',
  failed: 'gescheitert', rejected: 'abgelehnt', canceled: 'übersprungen',
};

export class QuestPollFeatures {
  constructor(private readonly store: FeatureStore, private readonly config: AppConfig) {}

  tick(now = Date.now()): void {
    this.store.expireQuests(now);
    this.store.finishExpiredPolls(now);
  }

  handle(message: ChatMessage, command: string, args: string[], now = Date.now()): string | undefined {
    const questSettings = this.questSettings();
    const pollSettings = this.pollSettings();
    const modules = this.store.config<Record<string, boolean>>('modules', {});
    if (['quest','quests','myquest','questhelp','questqueue','approvequest','rejectquest','skipquest'].includes(command) && modules.quests === false) {
      return '📜 Das Quest-System ist gerade deaktiviert.';
    }
    if (['poll','pollresults','vote'].includes(command) && modules.polls === false) return '🗳️ Umfragen sind gerade deaktiviert.';
    if (command === 'quest') return this.submit(message, args, questSettings, now);
    if (command === 'quests') return this.queueStatus();
    if (command === 'myquest') return this.myQuest(message.senderUserId);
    if (command === 'questhelp') return this.questHelp(questSettings);
    if (command === 'questqueue') return this.questQueue(message, questSettings);
    if (command === 'approvequest') return this.moderateQuest(message, args, questSettings, now, 'approved');
    if (command === 'rejectquest') return this.moderateQuest(message, args, questSettings, now, 'rejected');
    if (command === 'skipquest') return this.skipQuest(message, questSettings, now);
    if (command === 'poll') return this.pollMessage(now);
    if (command === 'pollresults') return this.pollResults(now);
    if (command === 'vote') return this.vote(message, args, pollSettings, now);
    return undefined;
  }

  private questSettings(): QuestSettings {
    const saved = this.store.config<Partial<QuestSettings>>('quest_settings', {});
    return { ...DEFAULT_QUEST_SETTINGS, ...saved,
      moderatorUserIds: Array.isArray(saved.moderatorUserIds) ? saved.moderatorUserIds.filter((id): id is string => typeof id === 'string') : [] };
  }

  private pollSettings(): PollSettings {
    const saved = this.store.config<Partial<PollSettings>>('poll_settings', {});
    return { ...DEFAULT_POLL_SETTINGS, ...saved,
      ignoredUserIds: Array.isArray(saved.ignoredUserIds) ? saved.ignoredUserIds.filter((id): id is string => typeof id === 'string') : [] };
  }

  private submit(message: ChatMessage, args: string[], settings: QuestSettings, now: number): string {
    if (!settings.enabled || !settings.chatEnabled) return '📜 Quest-Vorschläge per Chat sind gerade deaktiviert.';
    const raw = args.join(' ').normalize('NFC').trim();
    if (!isSafeViewerText(raw, settings.maxLength)) return `📜 Bitte sende eine Quest mit 3 bis ${settings.maxLength} Zeichen – ohne Steuerzeichen.`;
    const result = this.store.submitQuest({ submitterUserId: message.senderUserId, displayName: cleanText(message.senderDisplayName, 48),
      title: raw, source: 'chat', sourceEventId: message.eventId }, settings, now);
    if (!result.ok) {
      if (result.reason === 'duplicate') return '';
      if (result.reason === 'cooldown') return `⏳ ${cleanText(message.senderDisplayName, 32)}: Bitte warte noch ${Math.ceil((result.remainingMs || 0) / 1000)} Sekunden bis zum nächsten Vorschlag.`;
      if (result.reason === 'user-limit') return '📜 Du hast bereits zu viele offene Quest-Vorschläge.';
      return '📜 Die Quest-Warteschlange ist gerade voll.';
    }
    return `📜 Danke, ${cleanText(message.senderDisplayName, 32)}! Dein Vorschlag wartet auf Freigabe und wird nicht ungeprüft eingeblendet.`;
  }

  private queueStatus(): string {
    const active = this.store.activeQuest();
    const pending = this.store.questSummary().pending || 0;
    return active
      ? `📜 LIVE-QUEST: ${active.title}${active.game ? ` (${active.game})` : ''} · von ${active.displayName} · ${pending} Vorschläge warten.`
      : `📜 Gerade läuft keine Quest. ${pending} Vorschläge warten auf Freigabe.`;
  }

  private myQuest(userId: string): string {
    const quest = this.store.lastQuestForUser(userId);
    return quest ? `📜 Dein letzter Vorschlag „${quest.title}“: ${STATUS_LABEL[quest.status]}.`
      : '📜 Du hast noch keinen Quest-Vorschlag eingereicht. Nutze !quest DEINE IDEE.';
  }

  private questHelp(settings: QuestSettings): string {
    return `📜 !quest AUFGABE reicht einen Vorschlag ein (max. ${settings.maxLength} Zeichen). Jede Quest wird zuerst moderiert; Cooldown ${Math.ceil(settings.cooldownMs / 60_000)} Min., höchstens ${settings.maxOpenPerUser} offene Vorschläge. !quests zeigt die Live-Quest, !myquest deinen Status. Kanalpunkte-Einlösungen werden privat im Dashboard verwaltet.`;
  }

  private skipQuest(message: ChatMessage, settings: QuestSettings, now: number): string {
    if (!this.canSkip(message, settings)) return '⛔ Nur Jannik oder die ausdrücklich freigegebenen Moderatoren dürfen die Quest überspringen.';
    const active = this.store.activeQuest();
    if (!active) return '📜 Es läuft gerade keine Quest.';
    const result = this.store.transitionQuest(active.id, 'canceled', message.senderUserId, now, settings);
    return result.ok ? `⏭️ Die Quest „${active.title}“ wurde übersprungen.` : '📜 Die Quest konnte nicht übersprungen werden.';
  }

  private canSkip(message: ChatMessage, settings: QuestSettings): boolean {
    if (message.senderUserId === this.config.broadcasterUserId) return true;
    return settings.modsCanSkip && message.isModerator === true && settings.moderatorUserIds.includes(message.senderUserId);
  }

  private canModerate(message: ChatMessage, settings: QuestSettings): boolean {
    if (message.senderUserId === this.config.broadcasterUserId) return true;
    return settings.modsCanModerate && message.isModerator === true && settings.moderatorUserIds.includes(message.senderUserId);
  }

  private questQueue(message: ChatMessage, settings: QuestSettings): string {
    if (!this.canModerate(message, settings)) return '⛔ Die Quest-Warteschlange ist nur für Jannik und ausdrücklich freigegebene Moderatoren sichtbar.';
    const pending = this.store.listQuests('pending', '', 10);
    return pending.length ? `📜 ${pending.length} Vorschläge warten auf Freigabe. IDs: ${pending.map((q) => `#${q.id.slice(0, 8)}`).join(', ')}. Den Vorschlagstext bitte im Dashboard prüfen.`
      : '📜 Keine wartenden Quest-Vorschläge.';
  }

  private moderateQuest(message: ChatMessage, args: string[], settings: QuestSettings, now: number, target: 'approved' | 'rejected'): string {
    if (!this.canModerate(message, settings)) return '⛔ Nur Jannik oder ausdrücklich freigegebene Moderatoren dürfen Quest-Vorschläge moderieren.';
    const quest = this.store.findPendingQuestByPrefix(args[0] || '');
    if (!quest) return '📜 Quest-ID nicht gefunden oder nicht eindeutig. Nutze !questqueue für IDs und prüfe den Text im Dashboard.';
    if (quest.source === 'channel_points') return '📜 Kanalpunkte-Quests bitte im Dashboard moderieren, damit der Twitch-Einlösungsstatus sicher abgeglichen wird.';
    const result = this.store.transitionQuest(quest.id, target, message.senderUserId, now, this.questSettings());
    return result.ok ? `📜 Vorschlag #${quest.id.slice(0, 8)} wurde ${target === 'approved' ? 'freigegeben' : 'abgelehnt'}.`
      : '📜 Dieser Vorschlag kann nicht mehr moderiert werden.';
  }

  private pollMessage(now: number): string {
    const poll = this.store.activePoll(now);
    if (!poll) return '🗳️ Gerade läuft keine Umfrage.';
    const remaining = Math.max(0, Math.ceil((poll.endsAt - now) / 1000));
    return `🗳️ ${poll.question} ${poll.options.map((option, index) => `${index + 1}) ${option.label}`).join(' · ')} — !vote 1-${poll.options.length} · noch ${remaining}s.`;
  }

  private pollResults(now: number): string {
    this.store.finishExpiredPolls(now);
    const poll = this.store.pollHistory(1)[0];
    if (!poll) return '🗳️ Es gibt noch keine Umfrage.';
    const results = poll.options.map((option, index) => `${index + 1}) ${option.label}: ${option.votes} (${option.percent}%)`).join(' · ');
    const outcome = poll.status === 'active' ? ` · noch ${Math.max(0, Math.ceil((poll.endsAt - now) / 1000))}s`
      : poll.tied ? ' · Gleichstand – Jannik entscheidet im Dashboard.'
        : poll.winnerOption === null ? ' · ohne Stimmen beendet.' : ` · Gewinner: ${poll.options[poll.winnerOption]?.label || '–'}`;
    return `🗳️ ${poll.question} ${results} · ${poll.totalVotes} Stimmen${outcome}.`;
  }

  private vote(message: ChatMessage, args: string[], settings: PollSettings, now: number): string {
    if (!settings.enabled) return '🗳️ Umfragen sind gerade deaktiviert.';
    if (settings.ignoredUserIds.includes(message.senderUserId) || message.senderUserId === this.config.botUserId) return '';
    const poll = this.store.activePoll(now);
    if (!poll) return '🗳️ Gerade läuft keine Umfrage.';
    if (args.length !== 1 || !/^[1-5]$/u.test(args[0] || '')) return `🗳️ Bitte stimme mit !vote 1 bis !vote ${poll.options.length}.`;
    const result = this.store.vote(poll.id, message.senderUserId, cleanText(message.senderDisplayName, 48), Number(args[0]), message.eventId, now, settings.ignoredUserIds);
    if (!result.ok) {
      if (result.reason === 'duplicate') return '';
      if (result.reason === 'ignored') return '';
      if (result.reason === 'invalid-option') return `🗳️ Bitte stimme mit !vote 1 bis !vote ${poll.options.length}.`;
      if (result.reason === 'already-voted') return '🗳️ Deine Stimme ist bereits registriert; Änderungen sind deaktiviert.';
      if (result.reason === 'ended') return '🗳️ Die Umfrage ist gerade abgelaufen.';
      return '🗳️ Die Umfrage ist nicht mehr aktiv.';
    }
    return `🗳️ ${result.changed ? 'Stimme geändert' : 'Stimme gezählt'}: ${result.poll.options[Number(args[0]) - 1]?.label || '–'}.`;
  }
}

function cleanText(value: string, limit: number): string {
  return Array.from(value.replace(/[\r\n\t]/gu, ' ').replace(/[\u0000-\u001F\u007F]/gu, '').trim()).slice(0, limit).join('') || 'Unbekannt';
}

function isSafeViewerText(value: string, maxLength: number): boolean {
  const length = Array.from(value).length;
  if (length < 3 || length > maxLength || /[\u0000-\u001F\u007F<>\u202A-\u202E\u2066-\u2069]/u.test(value)) return false;
  return value.replace(/[\p{P}\p{S}\s]/gu, '').length > 0;
}
