import type { Logger } from './logger.js';
import type { TwitchOAuth } from './twitch-oauth.js';

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

export interface SendChatResult {
  messageId: string;
  isSent: boolean;
  dropReason?: string;
}

interface HelixResponse<T> { data: T[]; }

export class TwitchApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TwitchApiError';
  }
}

export class TwitchApi {
  constructor(
    private readonly clientId: string,
    private readonly oauth: TwitchOAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly logger: Logger = consoleLogger,
  ) {}

  async getUsers(logins: string[]): Promise<TwitchUser[]> {
    const query = logins.map((login) => `login=${encodeURIComponent(login)}`).join('&');
    const response = await this.request<HelixResponse<TwitchUser>>(`/users?${query}`);
    return response.data;
  }

  async sendChatMessage(broadcasterId: string, senderId: string, message: string, replyParentMessageId?: string): Promise<SendChatResult> {
    const body: Record<string, string> = { broadcaster_id: broadcasterId, sender_id: senderId, message };
    if (replyParentMessageId) body.reply_parent_message_id = replyParentMessageId;
    const response = await this.request<HelixResponse<{ message_id: string; is_sent: boolean; drop_reason?: { code: string; message: string } | null }>>(
      '/chat/messages', { method: 'POST', body: JSON.stringify(body) },
    );
    const result = response.data[0];
    if (!result) throw new TwitchApiError(502, 'Twitch lieferte kein Sendeergebnis.');
    if (!result.is_sent) this.logger.warn('Twitch hat eine Chatnachricht nicht gesendet.', { reason: result.drop_reason?.code || 'unbekannt' });
    return { messageId: result.message_id, isSent: result.is_sent, ...(result.drop_reason?.message ? { dropReason: result.drop_reason.message } : {}) };
  }

  async ensureChatSubscription(sessionId: string, broadcasterId: string, botId: string): Promise<void> {
    const current = await this.request<HelixResponse<{ type: string; status: string; condition: { broadcaster_user_id: string; user_id: string }; transport: { session_id?: string } }>>('/eventsub/subscriptions');
    const exists = current.data.some((subscription) => subscription.type === 'channel.chat.message'
      && subscription.status === 'enabled'
      && subscription.condition.broadcaster_user_id === broadcasterId
      && subscription.condition.user_id === botId
      && subscription.transport.session_id === sessionId);
    if (exists) {
      this.logger.info('EventSub-Chat-Abonnement bereits aktiv.');
      return;
    }
    await this.request('/eventsub/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: botId },
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    this.logger.info('EventSub-Chat-Abonnement eingerichtet.');
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> {
    let token = await this.oauth.getAccessToken();
    let response = await this.fetchImpl(`https://api.twitch.tv/helix${path}`, {
      ...init,
      headers: {
        'Client-Id': this.clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (response.status === 401 && allowRefresh) {
      token = await this.oauth.refreshAccessToken();
      response = await this.fetchImpl(`https://api.twitch.tv/helix${path}`, {
        ...init,
        headers: {
          'Client-Id': this.clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    }
    if (!response.ok) {
      const body = await response.text();
      const reset = Number(response.headers.get('Ratelimit-Reset'));
      const retryAfterMs = response.status === 429 && Number.isFinite(reset) ? Math.max(1000, reset * 1000 - Date.now()) : undefined;
      throw new TwitchApiError(response.status, `Twitch Helix HTTP ${response.status}: ${body.slice(0, 200)}`, retryAfterMs);
    }
    if (response.status === 204) return {} as T;
    return JSON.parse(await response.text()) as T;
  }
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
