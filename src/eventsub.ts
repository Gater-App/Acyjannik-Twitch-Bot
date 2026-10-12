import WebSocket from 'ws';
import type { Logger } from './logger.js';

interface EventSubMessage {
  metadata?: { message_type?: string; message_id?: string };
  payload?: {
    session?: { id: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
  };
}

export class EventSubClient {
  private socket: WebSocket | undefined;
  private stopped = true;
  private retryTimer: NodeJS.Timeout | undefined;
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private retryAttempt = 0;
  private reconnectUrl?: string;
  private keepaliveTimeoutSeconds = 10;

  constructor(
    private readonly onSessionReady: (sessionId: string) => Promise<void>,
    private readonly onNotification: (message: Record<string, unknown>) => Promise<void>,
    private readonly logger: Logger = consoleLogger,
  ) {}

  start(): void {
    this.stopped = false;
    this.retryAttempt = 0;
    this.connect(this.reconnectUrl || 'wss://eventsub.wss.twitch.tv/ws');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    await new Promise<void>((resolve) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.socket.once('close', () => resolve());
      this.socket.close(1000, 'shutdown');
    });
  }

  private connect(url: string): void {
    if (this.stopped) return;
    this.logger.info('Verbinde EventSub-WebSocket.');
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on('open', () => { this.retryAttempt = 0; });
    socket.on('message', (data) => {
      void this.handleMessage(data.toString()).catch((error: unknown) => {
        this.logger.error('EventSub-Nachricht konnte nicht verarbeitet werden.', { error: error instanceof Error ? error.message : 'unbekannt' });
        socket.close();
      });
    });
    socket.on('error', (error) => this.logger.warn('EventSub-WebSocket-Fehler.', { error: error.message }));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: EventSubMessage & Record<string, unknown>;
    try { message = JSON.parse(raw) as EventSubMessage & Record<string, unknown>; } catch { this.logger.warn('Ungültige EventSub-Nachricht ignoriert.'); return; }
    const type = message.metadata?.message_type;
    if (type === 'session_welcome') {
      const session = message.payload?.session;
      if (!session?.id) return;
      this.keepaliveTimeoutSeconds = session.keepalive_timeout_seconds || 10;
      this.armKeepalive(this.keepaliveTimeoutSeconds);
      await this.onSessionReady(session.id);
      return;
    }
    if (type === 'session_keepalive') {
      this.armKeepalive(this.keepaliveTimeoutSeconds);
      return;
    }
    if (type === 'session_reconnect') {
      const reconnectUrl = message.payload?.session?.reconnect_url;
      if (reconnectUrl) this.reconnectUrl = reconnectUrl;
      this.socket?.close(1000, 'reconnect requested');
      return;
    }
    if (type === 'notification') {
      await this.onNotification(message as Record<string, unknown>);
      return;
    }
    if (type === 'revocation') {
      this.logger.error('Twitch hat ein EventSub-Abonnement widerrufen.', { messageId: message.metadata?.message_id || 'unbekannt' });
    }
  }

  private armKeepalive(seconds: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.logger.warn('EventSub-Keepalive überschritten; Verbindung wird neu aufgebaut.');
      this.socket?.close();
    }, Math.max(5, seconds) * 1000);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(5, this.retryAttempt++)));
    this.logger.warn('EventSub-Verbindung getrennt; Reconnect geplant.', { delayMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect(this.reconnectUrl || 'wss://eventsub.wss.twitch.tv/ws');
    }, delay);
  }
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
