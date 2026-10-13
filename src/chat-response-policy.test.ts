import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatResponsePolicy } from './chat-response-policy.js';

test('ruhiges und ausgewogenes Profil unterdrücken persönliche Statusabfragen ohne private Daten preiszugeben', () => {
  for (const profile of ['calm','normal'] as const) {
    const policy = new ChatResponsePolicy({ profile, welcomeBots: [] });
    assert.equal(policy.shouldSend({ command: '!level', message: '⭐ Alice: Level 4, 300 XP', now: 1_000 }), false);
    assert.equal(policy.shouldSend({ command: '!dropstats', message: '🎁 Deine Claims: 2.', now: 2_000 }), false);
    assert.equal(policy.snapshot().suppressed, 2);
  }
});

test('Routineerfolge sind stumm, Fehler und wichtige Spielmeldungen bleiben sichtbar', () => {
  const policy = new ChatResponsePolicy({ profile: 'normal', welcomeBots: [] });
  assert.equal(policy.shouldSend({ command: '!claim', message: '🎁 Du bist beim Mystery Drop dabei!', now: 1_000 }), false);
  assert.equal(policy.shouldSend({ command: '!claim', message: '🎁 Gerade ist kein Drop zum Claim offen.', now: 2_000 }), true);
  assert.equal(policy.shouldSend({ command: '!startdrop', message: '🎁 Ein Mystery Drop startet!', now: 3_000 }), true);
});

test('lebhaftes Profil erlaubt Einzelreaktionen, bremst Wiederholungen und normalisiert Bot-Ausschlüsse', () => {
  const policy = new ChatResponsePolicy({ profile: 'normal', welcomeBots: [] });
  policy.configure({ profile: 'lively', welcomeBots: [' StreamElements ', 'nightbot', 'NIGHTBOT', 42] });
  assert.equal(policy.isWelcomeExcluded('streamelements'), true);
  assert.equal(policy.isWelcomeExcluded('viewer'), false);
  assert.equal(policy.shouldSend({ command: '!claim', message: 'Du bist beim Mystery Drop dabei!', now: 10_000 }), true);
  assert.equal(policy.shouldSend({ command: '!claim', message: 'Du bist beim Mystery Drop dabei!', now: 11_000 }), false);
});
