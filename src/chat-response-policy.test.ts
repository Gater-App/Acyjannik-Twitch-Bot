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

test('Chat-Simulationen halten Einzelaktionen ruhig und lassen Spielstarts und Ergebnisse sichtbar', () => {
  const simulate = (profile: 'calm' | 'normal' | 'lively') => {
    const policy = new ChatResponsePolicy({ profile, welcomeBots: [] });
    const chat = [
      ['!8ball', '🎱 Die Antwort lautet vielleicht.'],
      ['!wer', '🕵️ Deine Antwort wurde gespeichert.'],
      ['!vote', '🗳️ Stimme gespeichert.'],
      ['!guess', '🔢 Deine Zahl wurde gespeichert.'],
      ['!startimposter', '🎭 Anmeldung offen! Mit !joinimposter mitspielen.'],
      ['!endimposter', '🎭 Gut erkannt: Der Imposter war Alex.'],
    ] as const;
    return chat.map(([command, message], i) => policy.shouldSend({ command, message, now: 10_000 + i * 1_200 }));
  };

  assert.deepEqual(simulate('calm'), [true, false, false, false, true, true], 'Ruhig begrenzt individuelle Meldungen, zeigt Start und Ergebnis');
  assert.deepEqual(simulate('normal'), [true, true, true, false, true, true], 'Normal erlaubt drei kurze Aktionen, bremst weitere Einzelschritte');
  assert.deepEqual(simulate('lively'), [true, true, true, true, true, true], 'Lebhaft erlaubt mehr Aktivität');
});

test('gängige Bot-Accounts werden standardmäßig nicht als neue Zuschauer begrüßt', () => {
  const policy = new ChatResponsePolicy();
  for (const login of ['streamelements', 'nightbot', 'moobot', 'streamlabs', 'fossabot', 'wizebot', 'botrix'])
    assert.equal(policy.isWelcomeExcluded(login), true, `${login} ist ausgeschlossen`);
  assert.equal(policy.isWelcomeExcluded('echter_zuschauer'), false);
  policy.configure({ profile: 'normal', welcomeBots: ['eigener_bot'] });
  assert.equal(policy.isWelcomeExcluded('fossabot'), true, 'gespeicherte individuelle Listen heben bekannte Bot-Ausschlüsse nicht auf');
  assert.equal(policy.isWelcomeExcluded('eigener_bot'), true, 'individuelle Ausschlüsse bleiben erhalten');
});

test('Antworten verschiedener Zuschauer werden nicht über einen gemeinsamen Command-Cooldown unterdrückt',()=>{
  const policy=new ChatResponsePolicy({profile:'normal',welcomeBots:[]});
  assert.equal(policy.shouldSend({command:'!attack',senderUserId:'viewer-a',message:'Alice trifft für 20 Schaden.',now:10_000}),true);
  assert.equal(policy.shouldSend({command:'!attack',senderUserId:'viewer-b',message:'Bob trifft für 20 Schaden.',now:10_001}),true);
  assert.equal(policy.shouldSend({command:'!attack',senderUserId:'viewer-a',message:'Alice: dein Angriff ist noch nicht bereit.',now:10_500}),false,'häufige Rückmeldungen werden nur für denselben Account gebremst');
  assert.equal(policy.shouldSend({command:'!attack',senderUserId:'viewer-b',message:'Bob trifft für 20 Schaden.',now:10_600}),false,'der persönliche Rückmeldeabstand greift nur beim jeweiligen Account');
  assert.equal(policy.shouldSend({command:'!trickortreat',senderUserId:'viewer-c',message:'Ada findet 5 Kürbisse.',now:10_000}),true,'erfolgreiche Spielresultate verschwinden nicht im Normalprofil');
  assert.equal(policy.shouldSend({command:'!trickortreat',senderUserId:'viewer-d',message:'Ben findet 2 Kürbisse.',now:10_001}),true,'ein anderer Nutzer erhält seine eigene Rückmeldung');
});
