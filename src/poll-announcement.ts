import { chatCharacterLength } from './chat.js';

export interface PollAnnouncementData {
  question: string;
  options: Array<{ label: string }>;
}

function optionNumber(index: number): string {
  const number = index + 1;
  return number <= 9 ? `${number}️⃣` : `${number}.`;
}

/**
 * Format a poll from its persisted option order, using the same one-based
 * option numbers accepted by !vote. Each returned item is one Twitch message.
 */
export function formatPollAnnouncement(poll: PollAnnouncementData, maxLength = 450): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 80 || maxLength > 500) {
    throw new Error('Ungültiges Twitch-Nachrichtenlimit für die Umfrageankündigung.');
  }
  if (!poll.question.trim() || poll.options.length < 2
    || poll.options.some((option) => !option.label.trim())) {
    throw new Error('Die gespeicherten Umfrageoptionen sind ungültig.');
  }

  const parts = [
    '📩 NEUE LIVE-ABSTIMMUNG',
    poll.question,
    ...poll.options.map((option, index) => `${optionNumber(index)} ${option.label}`),
    `🗳️ Abstimmen: ${poll.options.map((_, index) => `!vote ${index + 1}`).join(', ')}`,
    'Alternativ im Community-Portal abstimmen.',
  ];

  const boundedParts = parts.flatMap((part) => splitPart(part, maxLength));
  const messages: string[] = [];
  let current = '';
  for (const part of boundedParts) {
    const next = current ? `${current} · ${part}` : part;
    if (chatCharacterLength(next) <= maxLength) {
      current = next;
    } else {
      if (current) messages.push(current);
      current = part;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function splitPart(value: string, maxLength: number): string[] {
  if (chatCharacterLength(value) <= maxLength) return [value];
  // Keep every character. Prefer word boundaries; an unusually long single
  // token is split by Unicode code point so Twitch's limit is still respected.
  const words = value.match(/\S+\s*/gu) || [value];
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    if (chatCharacterLength(word) > maxLength) {
      if (current) chunks.push(current);
      current = '';
      const chars = Array.from(word);
      for (let index = 0; index < chars.length; index += maxLength) chunks.push(chars.slice(index, index + maxLength).join(''));
    } else if (current && chatCharacterLength(current + word) > maxLength) {
      chunks.push(current);
      current = word;
    } else current += word;
  }
  if (current) chunks.push(current);
  return chunks;
}
