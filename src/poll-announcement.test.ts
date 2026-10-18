import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCharacterLength } from './chat.js';
import { formatPollAnnouncement } from './poll-announcement.js';

test('Poll-Ankündigung bildet zwei, drei und fünf gespeicherte Optionen mit !vote identisch ab', () => {
  for (const labels of [
    ['Nur Pistole', 'Nur Schrotflinte'],
    ['Nur Pistole', 'Nur Schrotflinte', 'Nur Messer'],
    ['Pistole', 'Schrotflinte', 'Messer', 'Scharfschütze', 'Zufall'],
  ]) {
    const messages = formatPollAnnouncement({ question: 'Welche Waffe?', options: labels.map(label => ({ label })) });
    const text = messages.join(' ');
    assert.match(text, /📩 NEUE LIVE-ABSTIMMUNG/u);
    assert.match(text, /Welche Waffe\?/u);
    labels.forEach((label, index) => {
      assert.ok(text.includes(`${index + 1}️⃣ ${label}`), `Option ${index + 1} bleibt an ihrer gespeicherten Position`);
      assert.ok(text.includes(`!vote ${index + 1}`), `!vote ${index + 1} ist angekündigt`);
    });
    assert.ok(text.includes('Community-Portal'));
    assert.ok(messages.every(message => chatCharacterLength(message) <= 430));
  }
});

test('Lange Frage und lange Optionen werden auf vollständige Chatnachrichten verteilt', () => {
  const question = `Welche Entscheidung soll Jannik treffen? ${'Wichtiger Kontext '.repeat(8)}`.trim();
  const labels = ['Nur Pistole '.repeat(8).trim(), 'Nur Schrotflinte '.repeat(7).trim(), 'Messer '.repeat(12).trim(), 'Scharfschütze '.repeat(7).trim(), 'Zufall '.repeat(13).trim()];
  const messages = formatPollAnnouncement({ question, options: labels.map(label => ({ label })) }, 300);
  const text = messages.join(' ');
  assert.ok(messages.length > 1, 'lange Inhalte werden in mehrere Chatnachrichten geteilt');
  assert.ok(messages.every(message => chatCharacterLength(message) <= 300));
  assert.ok(text.includes(question));
  labels.forEach((label, index) => assert.ok(text.includes(`${index + 1}️⃣ ${label}`)));
  assert.ok(text.includes('!vote 5'));
  assert.ok(text.includes('Community-Portal'));
});

test('Ungültige gespeicherte Poll-Daten werden nicht teilweise angekündigt', () => {
  assert.throws(() => formatPollAnnouncement({ question: 'Frage?', options: [{ label: 'Nur eins' }] }), /ungültig/u);
  const longLabel = 'B'.repeat(100), messages = formatPollAnnouncement({ question: 'Frage?', options: [{ label: 'A' }, { label: longLabel }] }, 120);
  assert.ok(messages.every(message => chatCharacterLength(message) <= 120));
  assert.ok(messages.join(' ').includes(longLabel), 'lange, aber gültige Antworttexte werden nicht gekürzt');
});
