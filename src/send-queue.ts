import { assertChatMessageLength } from './chat.js';
import type { Logger } from './logger.js';
import { formatPublicChatMessage, type ChatCategory } from './chat-message-format.js';

interface QueueItem {
  message: string;
  replyParentMessageId?: string;
  priority: number;
  key: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class SendQueue {
  private readonly items: QueueItem[] = [];
  private sending = false;
  private suppressed = 0;

  constructor(
    private readonly send: (message: string, replyParentMessageId?: string) => Promise<void>,
    private readonly intervalMs = 1100,
    private readonly logger: Logger = consoleLogger,
    private readonly maxLength = 500,
    private readonly maxQueueSize = 100,
  ) {}

  enqueue(message: string, replyParentMessageId?: string, category: ChatCategory = 'community'): Promise<void> {
    message = formatPublicChatMessage(message, category, this.maxLength);
    assertChatMessageLength(message, this.maxLength);
    return new Promise<void>((resolve, reject) => {
      const key = `${replyParentMessageId || ''}:${message.trim().toLocaleLowerCase()}`;
      if (this.items.some(item => item.key === key)) { this.suppressed++; resolve(); return; }
      if (this.items.length >= this.maxQueueSize) {
        const lowest = this.items.reduce((best, item, index, all) => item.priority < all[best]!.priority ? index : best, 0);
        const incomingPriority = priorityFor(message);
        if (incomingPriority <= this.items[lowest]!.priority) { this.suppressed++; resolve(); return; }
        const [removed] = this.items.splice(lowest, 1);
        removed?.resolve(); this.suppressed++;
      }
      this.items.push({ message, key, priority: priorityFor(message), ...(replyParentMessageId ? { replyParentMessageId } : {}), resolve, reject });
      void this.flush();
    });
  }

  get size(): number { return this.items.length; }
  snapshot() { return { queued: this.items.length, suppressed: this.suppressed }; }

  private async flush(): Promise<void> {
    if (this.sending || this.items.length === 0) return;
    this.sending = true;
    this.items.sort((a, b) => b.priority - a.priority);
    const item = this.items.shift();
    if (!item) { this.sending = false; return; }
    try {
      await this.send(item.message, item.replyParentMessageId);
      item.resolve();
    } catch (error) {
      this.logger.warn('Chatnachricht konnte nicht gesendet werden.', { error: error instanceof Error ? error.message : 'unbekannt' });
      item.reject(error);
    } finally {
      setTimeout(() => {
        this.sending = false;
        void this.flush();
      }, this.intervalMs);
    }
  }
}

function priorityFor(message: string): number {
  return /gestartet|startet|beendet|aufgelöst|gewinner|abstimmung|umfrage|der mystery drop ist geöffnet|der mystery drop ist vorbei|chat-imposter|chat-detektiv/iu.test(message) ? 2 : 1;
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
