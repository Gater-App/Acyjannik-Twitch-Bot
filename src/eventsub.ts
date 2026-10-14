import WebSocket from 'ws';
import type { Logger } from './logger.js';

const DEFAULT_EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';

interface EventSubMessage {
  metadata?: { message_type?: string; message_id?: string };
  payload?: {
    session?: { id: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
    subscription?: { type?: unknown; status?: unknown };
  };
}

export class EventSubClient {
  private socket: WebSocket | undefined;
  private pendingSocket: WebSocket | undefined;
  private stopped = true;
  private retryTimer: NodeJS.Timeout | undefined;
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private stabilityTimer: NodeJS.Timeout | undefined;
  private retryAttempt = 0;
  private reconnectUrl: string | undefined;
  private keepaliveTimeoutSeconds = 10;

  get isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  constructor(
    private readonly onSessionReady: (sessionId: string) => Promise<void>,
    private readonly onNotification: (message: Record<string, unknown>) => Promise<void>,
    private readonly logger: Logger = consoleLogger,
    private readonly initialUrl = DEFAULT_EVENTSUB_URL,
  ) {}

  start(): void {
    this.stopped = false;
    this.retryAttempt = 0;
    this.reconnectUrl = undefined;
    this.connect(this.initialUrl);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    const sockets = [...new Set([this.socket, this.pendingSocket].filter((socket): socket is WebSocket => Boolean(socket)))];
    this.socket = undefined;
    this.pendingSocket = undefined;
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.once('close', () => resolve());
      socket.close(1000, 'shutdown');
    })));
  }

  private connect(url: string, reconnectUrlAttempt = false, handoffFrom?: WebSocket): void {
    if (this.stopped) return;
    this.logger.info('Verbinde EventSub-WebSocket.');
    const socket = new WebSocket(url);
    if (handoffFrom) this.pendingSocket = socket;
    else this.socket = socket;
    let welcomed = false;
    socket.on('message', (data) => {
      const raw = data.toString();
      try {
        const incoming = JSON.parse(raw) as EventSubMessage;
        if (incoming.metadata?.message_type === 'session_welcome') {
          welcomed = true;
          if (reconnectUrlAttempt) {
            this.reconnectUrl = undefined;
            if (this.pendingSocket === socket) {
              this.pendingSocket = undefined;
              this.socket = socket;
              handoffFrom?.close(1000, 'EventSub handoff complete');
            }
          }
        }
      } catch { /* handleMessage reports malformed frames where appropriate. */ }
      void this.handleMessage(raw, !reconnectUrlAttempt, socket).catch((error: unknown) => {
        this.logger.error('EventSub-Nachricht konnte nicht verarbeitet werden.', { error: error instanceof Error ? error.message : 'unbekannt' });
        socket.close();
      });
    });
    socket.on('error', (error) => this.logger.warn('EventSub-WebSocket-Fehler.', { error: error.message }));
    socket.on('close', () => {
      const wasActive = this.socket === socket;
      if (wasActive && this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = undefined; }
      if (wasActive) this.socket = undefined;
      if (this.pendingSocket === socket) this.pendingSocket = undefined;
      // Twitch reconnect URLs are single-use and short-lived. Never keep
      // retrying one after its handoff socket failed to establish a session.
      if (reconnectUrlAttempt && !welcomed) {
        this.reconnectUrl = undefined;
        if (handoffFrom && this.socket === handoffFrom) {
          this.socket = undefined;
          handoffFrom.close(1000, 'EventSub handoff failed');
        }
        if (!this.stopped) this.scheduleReconnect();
      } else if (wasActive && !this.stopped) this.scheduleReconnect();
    });
  }

  private async handleMessage(raw: string, configureSubscriptions = true, socket?: WebSocket): Promise<void> {
    let message: EventSubMessage & Record<string, unknown>;
    try { message = JSON.parse(raw) as EventSubMessage & Record<string, unknown>; } catch { this.logger.warn('Ungültige EventSub-Nachricht ignoriert.'); return; }
    const type = message.metadata?.message_type;
    if (type === 'session_welcome') {
      const session = message.payload?.session;
      if (!session?.id) return;
      this.keepaliveTimeoutSeconds = session.keepalive_timeout_seconds || 10;
      this.armKeepalive(this.keepaliveTimeoutSeconds);
      if (configureSubscriptions) await this.onSessionReady(session.id);
      if (socket) this.armStabilityReset(socket);
      return;
    }
    if (type === 'session_keepalive') {
      this.armKeepalive(this.keepaliveTimeoutSeconds);
      return;
    }
    if (type === 'session_reconnect') {
      const reconnectUrl = message.payload?.session?.reconnect_url;
      if (reconnectUrl) {
        this.reconnectUrl = reconnectUrl;
        const previous = this.socket;
        if (previous) this.connect(reconnectUrl, true, previous);
      }
      return;
    }
    if (type === 'notification') {
      // Twitch resets its keepalive window when it sends a notification too.
      this.armKeepalive(this.keepaliveTimeoutSeconds);
      await this.onNotification(message as Record<string, unknown>);
      return;
    }
    if (type === 'revocation') {
      const subscription = message.payload?.subscription;
      this.logger.error('Twitch hat ein EventSub-Abonnement widerrufen; die Verbindung wird zur Neuabstimmung aufgebaut.', {
        messageId: message.metadata?.message_id || 'unbekannt',
        subscriptionType: typeof subscription?.type === 'string' ? subscription.type : 'unbekannt',
        status: typeof subscription?.status === 'string' ? subscription.status : 'unbekannt',
      });
      socket?.close(1011, 'EventSub subscription revoked');
    }
  }

  private armStabilityReset(socket: WebSocket): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = undefined;
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) this.retryAttempt = 0;
    }, 60_000);
    this.stabilityTimer.unref();
  }

  private armKeepalive(seconds: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.logger.warn('EventSub-Keepalive überschritten; Verbindung wird neu aufgebaut.');
      this.socket?.close();
    // Leave a little room for network and event-loop scheduling jitter.
    }, Math.max(5, seconds) * 1000 + 2000);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(5, this.retryAttempt++)));
    this.logger.warn('EventSub-Verbindung getrennt; Reconnect geplant.', { delayMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const useReconnectUrl = Boolean(this.reconnectUrl);
      this.connect(this.reconnectUrl || this.initialUrl, useReconnectUrl);
    }, delay);
  }
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
