import { assertChatMessageLength } from './chat.js';
import type { Logger } from './logger.js';

interface QueueItem {
  message: string;
  replyParentMessageId?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class SendQueue {
  private readonly items: QueueItem[] = [];
  private sending = false;

  constructor(
    private readonly send: (message: string, replyParentMessageId?: string) => Promise<void>,
    private readonly intervalMs = 1100,
    private readonly logger: Logger = consoleLogger,
    private readonly maxLength = 500,
  ) {}

  enqueue(message: string, replyParentMessageId?: string): Promise<void> {
    assertChatMessageLength(message, this.maxLength);
    return new Promise<void>((resolve, reject) => {
      this.items.push({ message, ...(replyParentMessageId ? { replyParentMessageId } : {}), resolve, reject });
      void this.flush();
    });
  }

  get size(): number { return this.items.length; }

  private async flush(): Promise<void> {
    if (this.sending || this.items.length === 0) return;
    this.sending = true;
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

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
