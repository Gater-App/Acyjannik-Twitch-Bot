import type { ChatMessage } from './types.js';

export function chatCharacterLength(message: string): number {
  return Array.from(message).length;
}

export function assertChatMessageLength(message: string, maxLength = 500): void {
  if (chatCharacterLength(message) > maxLength) {
    throw new Error(`Chatnachricht überschreitet ${maxLength} Zeichen.`);
  }
}

export function clampChatMessage(message: string, maxLength = 450): string {
  if (chatCharacterLength(message) <= maxLength) return message;
  return `${Array.from(message).slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

export function formatDuration(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes <= 1 ? 'weniger als 1 Min.' : `${minutes} Min.`;
}

export function eventMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(name|points|pumpkins)\}/gu, (_, key: string) => String(values[key] ?? ''));
}

export function parseEventSubChatMessage(payload: Record<string, unknown>): ChatMessage {
  const event = payload.event as Record<string, unknown> | undefined;
  const metadata = payload.metadata as Record<string, unknown> | undefined;
  if (!event || !metadata) throw new Error('Ungültige EventSub-Nachricht.');
  const badges = Array.isArray(event.badges) ? event.badges as Array<Record<string, unknown>> : [];
  const senderUserId = String(event.chatter_user_id ?? '');
  const broadcasterUserId = String(event.broadcaster_user_id ?? '');
  const messageId = String(event.message_id ?? metadata.message_id ?? '');
  if (!senderUserId || !broadcasterUserId || !messageId) throw new Error('EventSub-Nachricht ohne erforderliche IDs.');
  return {
    eventId: messageId,
    messageId,
    broadcasterUserId,
    senderUserId,
    senderLogin: String(event.chatter_user_login ?? ''),
    senderDisplayName: String(event.chatter_user_name ?? event.chatter_user_login ?? senderUserId),
    message: String((event.message as Record<string, unknown> | undefined)?.text ?? ''),
    sentAt: Date.parse(String(event.sent_at ?? new Date().toISOString())),
    isModerator: badges.some((badge) => badge.set_id === 'moderator'),
  };
}
