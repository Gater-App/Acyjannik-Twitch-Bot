import { randomUUID } from 'node:crypto';
import { assertChatMessageLength } from './chat.js';
import type { Logger } from './logger.js';
import { formatPublicChatMessage, type ChatCategory } from './chat-message-format.js';

interface QueueItem {
  message: string;
  replyParentMessageId?: string;
  priority: number;
  id: string;
  enqueuedAt: number;
  expiresAt: number;
  resolve: (sent: boolean) => void;
  reject: (error: unknown) => void;
}

export interface SendOptions { id?: string; priority?: number; expiresAt?: number; }
export interface SendResult { accepted: boolean; rateLimitedRetries?: number; }
export interface SendQueueSnapshot {
  queued: number; sending: boolean; sent: number; failed: number; rateLimited: number;
  suppressed: number; expired: number; averageDelayMs: number; lastError?: string;
}

export class SendQueue {
  private readonly items: QueueItem[] = [];
  private sending = false;
  private scheduled = false;
  private suppressed = 0;
  private sent = 0;
  private failed = 0;
  private rateLimited = 0;
  private expired = 0;
  private delayTotal = 0;
  private lastError: string | undefined;
  private readonly knownIds = new Set<string>();
  private readonly knownIdOrder: string[] = [];

  constructor(
    private readonly send: (message: string, replyParentMessageId?: string) => Promise<void | SendResult>,
    private readonly intervalMs = 1100,
    private readonly logger: Logger = consoleLogger,
    private readonly maxLength = 500,
    private readonly maxQueueSize = 100,
  ) {}

  enqueue(message: string, replyParentMessageId?: string, category: ChatCategory = 'community', options: SendOptions = {}): Promise<boolean> {
    message = formatPublicChatMessage(message, category, this.maxLength);
    assertChatMessageLength(message, this.maxLength);
    return new Promise<boolean>((resolve, reject) => {
      const id = options.id || randomUUID();
      if (this.knownIds.has(id)) { this.suppressed++; resolve(false); return; }
      const now = Date.now();
      if (this.items.length >= this.maxQueueSize) {
        const lowest = this.items.reduce((best, item, index, all) => item.priority < all[best]!.priority ? index : best, 0);
        const incomingPriority = options.priority ?? priorityForCategory(category, message);
        if (incomingPriority <= this.items[lowest]!.priority) { this.suppressed++; resolve(false); return; }
        const [removed] = this.items.splice(lowest, 1);
        removed?.resolve(false); this.suppressed++;
      }
      this.rememberId(id);
      this.items.push({ message, id, enqueuedAt: now, expiresAt: options.expiresAt ?? now + 60_000,
        priority: options.priority ?? priorityForCategory(category, message), ...(replyParentMessageId ? { replyParentMessageId } : {}), resolve, reject });
      void this.flush();
    });
  }

  get size(): number { return this.items.length + Number(this.sending); }
  get busy(): boolean { return this.sending || this.scheduled || this.items.length > 0; }
  snapshot(): SendQueueSnapshot { return {
    queued: this.size, sending: this.sending, sent: this.sent, failed: this.failed, rateLimited: this.rateLimited,
    suppressed: this.suppressed, expired: this.expired, averageDelayMs: this.sent ? Math.round(this.delayTotal / this.sent) : 0,
    ...(this.lastError ? { lastError: this.lastError } : {}),
  }; }

  private async flush(): Promise<void> {
    if (this.sending || this.items.length === 0) return;
    this.sending = true;
    const now = Date.now();
    for (let index = this.items.length - 1; index >= 0; index--) {
      if (this.items[index]!.expiresAt <= now) {
        const [expired] = this.items.splice(index, 1); expired?.resolve(false); this.expired++;
      }
    }
    this.items.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    const item = this.items.shift();
    if (!item) { this.sending = false; return; }
    try {
      const result = await this.send(item.message, item.replyParentMessageId);
      if (result && !result.accepted) throw new Error('Twitch hat die Nachricht nicht angenommen.');
      this.rateLimited += result?.rateLimitedRetries||0;
      this.delayTotal += Math.max(0, Date.now() - item.enqueuedAt);
      this.sent++;
      item.resolve(true);
    } catch (error) {
      const retries=error&&typeof error==='object'&&'rateLimitedRetries' in error?Number((error as {rateLimitedRetries?:unknown}).rateLimitedRetries)||0:0;
      this.rateLimited+=Math.max(0,retries);
      this.failed++;
      this.lastError = safeError(error);
      this.logger.warn('Chatnachricht konnte nicht gesendet werden.', { error: this.lastError });
      item.reject(error);
    } finally {
      this.sending = false;
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        void this.flush();
      }, this.intervalMs);
    }
  }

  private rememberId(id: string) {
    this.knownIds.add(id); this.knownIdOrder.push(id);
    while (this.knownIdOrder.length > 2048) { const old = this.knownIdOrder.shift(); if (old) this.knownIds.delete(old); }
  }
}

function priorityForCategory(category: ChatCategory, message: string): number {
  const priorities: Partial<Record<ChatCategory, number>> = { boss: 100, attack: 90, halloween: 85, season: 80, drop: 75,
    wheel: 70, community: 65, communityPortal: 55, imposter: 65, detective: 65, quest: 65, vault: 65, poll: 65,
    duel: 60, rps: 60, guess: 60, pet: 55, xp: 50, help: 45, hint: 40, cooldown: 35, welcome: 25, ideas: 20,
    custom: 45, info: 15, tip: 10, oracle: 40 };
  const base=priorities[category] ?? 30;
  return priorityFor(message)>1?Math.max(base,90):base;
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'Unbekannter Versandfehler';
  return text.replace(/(?:Bearer|OAuth)\s+\S+/giu, '[credential redacted]').replace(/\b[A-Za-z0-9_-]{32,}\b/gu, '[redacted]').slice(0, 180);
}

function priorityFor(message: string): number {
  return /(?:anmeldung offen|geplantes update|bits sortieren|bot-nickerchen|schrauben nachziehen|schrauben wieder drin|elio übernimmt|nichts kaputt gemacht|frisch poliert|hab ich was verpasst|zurück und schöner|bin wieder da|wieder wach|(?:spiel|runde|abstimmung|umfrage|drop|event|quest)[^.!?]{0,48}\b(?:gestartet|startet|beendet|aufgelöst|geöffnet|vorbei)\b|\b(?:gestartet|startet|beendet|aufgelöst|gewinner|gut erkannt|gleichstand)\b|\b(?:mystery drop|quest-wahl) (?:ist )?(?:geöffnet|vorbei|gestartet|beendet))/iu.test(message) ? 2 : 1;
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
