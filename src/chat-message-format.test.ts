import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_CATEGORIES, categoryForCommand, formatPublicChatMessage } from './chat-message-format.js';

test('alle definierten Kategorien haben kurze großgeschriebene Namen und genau ein Präfix', () => {
  for (const [key, category] of Object.entries(CHAT_CATEGORIES)) {
    assert.equal(category.label, category.label.toLocaleUpperCase('de-DE'), key);
    const formatted = formatPublicChatMessage('【❓ HILFE】 【🎁 DROP】 Beispiel', key as keyof typeof CHAT_CATEGORIES);
    assert.equal((formatted.match(/【/gu) || []).length, 1);
    assert.ok(formatted.startsWith(`【${category.emoji} ${category.label}】 `));
  }
});

test('bekannte Chatbefehle erhalten ausdrücklich zugeordnete Kategorien', () => {
  const expected: Record<string, string> = {
    '!attack': 'attack', '!boss': 'boss', '!bosstop': 'boss', '!startboss': 'boss',
    '!trickortreat': 'halloween', '!gift': 'season', '!claim': 'drop', '!spin': 'wheel',
    '!pet': 'dragon', '!imposter': 'imposter', '!wer': 'detective', '!quest': 'quest',
    '!spark': 'ideas', '!poll': 'poll', '!8ball': 'oracle', '!duel': 'duel',
    '!guess': 'guess', '!rps': 'rps', '!level': 'xp', '!help': 'help',
    '!addcommand': 'custom',
  };
  for (const [command, category] of Object.entries(expected)) assert.equal(categoryForCommand(command), category, command);
  assert.equal(categoryForCommand('!unregistered-command'), 'community');
});

test('Formatter nutzt neutrales Präfix, kappt Überlänge und entfernt mehrfache Präfixe', () => {
  assert.equal(formatPublicChatMessage('【❓ HILFE】 【🎁 DROP】 Los!', 'drop'), '【🎁 DROP】 Los!');
  const limited = formatPublicChatMessage('x'.repeat(500), 'attack', 80);
  assert.ok(limited.length <= 80);
  assert.ok(limited.startsWith('【⚔️ ANGRIFF】 '));
  assert.equal(formatPublicChatMessage('Test', 'community'), '【🤖 COMMUNITY】 Test');
});
