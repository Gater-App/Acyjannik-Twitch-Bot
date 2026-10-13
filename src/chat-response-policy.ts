import { createHash } from 'node:crypto';

export type ChatProfile = 'calm' | 'normal' | 'lively';
export interface ChatResponseSettings { profile: ChatProfile; welcomeBots: string[]; }
export const DEFAULT_CHAT_RESPONSE_SETTINGS: ChatResponseSettings = {
  profile: 'normal', welcomeBots: ['streamelements', 'nightbot', 'sery_bot', 'moobot'],
};
export interface ChatDecisionInput { command?: string; message: string; now?: number; }

/** Output policy for ordinary chat replies. Critical, non-command announcements bypass it. */
export class ChatResponsePolicy {
  private readonly recent = new Map<string, number>();
  private readonly personalStatus = new Set(['level','rank','pumpkins','dropstats','petstats','eventscore']);
  private readonly routineSuccess = new Set(['claim','feed','play','petcare','trickortreat']);
  private suppressed = 0;
  private deferred = 0;
  private settings: ChatResponseSettings = { ...DEFAULT_CHAT_RESPONSE_SETTINGS, welcomeBots: [...DEFAULT_CHAT_RESPONSE_SETTINGS.welcomeBots] };
  constructor(settings: unknown = DEFAULT_CHAT_RESPONSE_SETTINGS) { this.configure(settings); }

  configure(value: unknown): ChatResponseSettings {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const profile: ChatProfile = raw.profile === 'calm' || raw.profile === 'lively' ? raw.profile : 'normal';
    const welcomeBots = Array.isArray(raw.welcomeBots)
      ? [...new Set(raw.welcomeBots.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(Boolean))].slice(0, 50)
      : DEFAULT_CHAT_RESPONSE_SETTINGS.welcomeBots;
    this.settings = { profile, welcomeBots };
    return this.snapshot();
  }
  snapshot() { return { ...this.settings, welcomeBots: [...this.settings.welcomeBots], suppressed: this.suppressed, deferred: this.deferred }; }
  isWelcomeExcluded(login: string) { return this.settings.welcomeBots.includes(login.trim().toLowerCase()); }

  shouldSend({ command = '', message, now = Date.now() }: ChatDecisionInput): boolean {
    const normalized = command.replace(/^!/u, '').toLowerCase();
    const isPersonal = this.personalStatus.has(normalized);
    const isRoutine = this.routineSuccess.has(normalized) && this.isSuccess(normalized, message);
    if (isPersonal && this.settings.profile !== 'lively') { this.suppressed++; return false; }
    if (isRoutine && this.settings.profile !== 'lively') { this.suppressed++; return false; }
    if (this.isPermissionFailure(message)) {
      const key = `permission:${this.fingerprint(message)}`;
      if (!this.allowOnce(key, now, 60_000)) { this.suppressed++; return false; }
    }
    const limit = this.settings.profile === 'calm' ? 1 : this.settings.profile === 'normal' ? 3 : 8;
    const windowMs = 60_000;
    const key = `outbound:${normalized || 'announcement'}`;
    const sentRecently = this.recent.get(key) ?? 0;
    if (sentRecently > 0 && now - sentRecently < (this.settings.profile === 'calm' ? 30_000 : 5_000)) {
      this.suppressed++; return false;
    }
    this.prune(now, windowMs);
    const windowCount = [...this.recent.values()].filter(t => now - t < windowMs).length;
    if (windowCount >= limit && !this.isImportant(message)) { this.deferred++; return false; }
    this.recent.set(key, now);
    return true;
  }
  private allowOnce(key: string, now: number, ttl: number) {
    if ((this.recent.get(key) ?? 0) > now - ttl) return false;
    this.recent.set(key, now); return true;
  }
  private prune(now: number, ttl: number) { for (const [key, at] of this.recent) if (now - at > ttl) this.recent.delete(key); }
  private isSuccess(command: string, message: string) {
    if (command === 'claim') return /dabei|teilnahme|claim|eingetragen|abgeholt|gespeichert/iu.test(message) && !/nicht|kein|läuft nicht|fehler/iu.test(message);
    if (command === 'trickortreat') return !/noch nicht|wieder losziehen|kannst in/iu.test(message);
    return /fütter|futter|spielt|pflegt|interagiert|erhält|bekomm|\+\d+\s*XP/iu.test(message) && !/nicht|kein|cooldown|fehler/iu.test(message);
  }
  private isPermissionFailure(message: string) { return /nur (jannik|mods|moderatoren|der streamer)|nicht berechtigt|keine berechtigung/iu.test(message); }
  private isImportant(message: string) { return /gestartet|startet|beendet|aufgelöst|gewinner|abstimmung|umfrage|mystery drop|imposter|detektiv/iu.test(message); }
  private fingerprint(text: string) { return createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16); }
}
