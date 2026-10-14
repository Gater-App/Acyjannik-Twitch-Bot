/** Built-in pool used for fresh installs and databases without custom answers. */
export const DEFAULT_8BALL_ANSWERS = [
  'Auf jeden Fall!',
  'Sieht sehr gut aus.',
  'Die Zeichen stehen günstig.',
  'Ganz klar: ja.',
  'Darauf kannst du wetten.',
  'Ich denke schon.',
  'Wahrscheinlich.',
  'Ein überraschendes Ja!',
  'Ja – und zwar mit Stil.',
  'Heute stehen alle Zeichen auf Erfolg.',
  'Der Weg ist frei.',
  'Das Orakel nickt.',
  'Jannik sagt: klingt machbar.',
  'Elio hat schon Ja miaut.',
  'Dein Loot ist heute legendär.',
  'Victory Royale? Sieht gut aus!',
  'Der nächste Drop könnte deiner sein.',
  'Dein Squad glaubt an dich.',
  'Volle Schilde für diesen Plan!',
  'Kritischer Treffer: Ja!',
  'Quest angenommen – gute Chancen.',
  'Das Matchmaking meint es gut mit dir.',
  'Du hast den Endboss auf deiner Seite.',
  'Ein Volltreffer ist wahrscheinlich.',
  'Frag später noch einmal.',
  'Konzentriere dich und frag erneut.',
  'Das ist gerade schwer zu sagen.',
  'Meine Quellen sind uneins.',
  'Der Würfel sagt: vielleicht.',
  'Die Sterne sagen: später.',
  'Das Orakel lädt noch …',
  'Ein mysteriöses Vielleicht.',
  'Die Antwort versteckt sich im Nebel.',
  'Elio denkt darüber nach.',
  'Der Sturm zieht erst noch vorbei.',
  'Noch ist kein Loot gefallen.',
  'Warte auf den nächsten sicheren Kreis.',
  'Das Spiel hält die Antwort geheim.',
  'Vielleicht nach einer kurzen Pause.',
  'Nur der Chat kennt die Antwort.',
  'Eher nicht.',
  'Die Aussichten sind schlecht.',
  'Nein.',
  'Ganz sicher nicht.',
  'Heute lieber nicht.',
  'Das wird wohl nichts.',
  'Der Weg ist leider versperrt.',
  'Der Boss sagt Nein.',
  'Kein Loot für diesen Plan.',
  'Der Sturm spricht dagegen.',
  'Das Match kippt eher gegen dich.',
  'Dein Squad ist noch nicht überzeugt.',
  'Das war ein klarer Fehlwurf.',
  'Der Plan braucht ein Update.',
  'Zu riskant – lieber neu landen.',
  'Die Mission wird so nichts.',
  'Der nächste Versuch läuft besser.',
  'Nein, aber frag Elio noch mal.',
  'Jannik würde es lassen.',
  'Der Loot-Tick sagt: nein.',
  'Heute kein Victory Royale.',
  'Der Endboss bleibt heute stehen.',
  'Dein Schild hält das leider nicht aus.',
  'Die Lobby ist dagegen.',
  'Der Controller vibriert: Nein.',
  'Das Orakel schüttelt den Kopf.',
  'Nicht einmal mit vollem Inventar.',
  'Der Plan ist wackliger als Holz-Builds.',
  'Das klingt nach einem Respawn.',
  'Nein – selbst Elio ist skeptisch.',
  'Frag nicht den Loot-Lama.',
  'Der Drop geht heute an jemand anderen.',
  'Das ist ein Fall für den nächsten Patch.',
  'Der Chat hat Einspruch eingelegt.',
  'Ein Nein mit Extra-Nebel.',
  'Heute gewinnt wohl die Gegenseite.',
  'Das Orakel hat gerade Disconnect.',
  'Der Plan wurde vom Sturm weggeweht.',
  'Nein. Und jetzt: zurück in die Lobby!',
  'Das wäre ein ziemlich frecher Push.',
  'Nur mit sehr viel Glück – also eher nein.',
  'Die Antwort ist im Busch verschwunden.',
];

/** Exact pre-expansion built-in list, used to distinguish defaults from custom pools. */
export const LEGACY_DEFAULT_8BALL_ANSWERS = [
  'Auf jeden Fall!', 'Sieht sehr gut aus.', 'Die Zeichen stehen günstig.', 'Ganz klar: ja.',
  'Darauf kannst du wetten.', 'Ich denke schon.', 'Wahrscheinlich.', 'Frage später noch einmal.',
  'Konzentriere dich und frag erneut.', 'Das ist gerade schwer zu sagen.', 'Meine Quellen sind uneins.',
  'Eher nicht.', 'Die Aussichten sind schlecht.', 'Nein.', 'Ganz sicher nicht.',
  'Nur der Chat kennt die Antwort.', 'Der Würfel sagt: vielleicht.', 'Heute lieber nicht.',
  'Ein überraschendes Ja!', 'Die Sterne sagen: später.', 'Frag den Boss im nächsten Kampf.',
  'Das Orakel braucht eine Pause.',
];

export type EightBallOutcome = 'yes' | 'no' | 'maybe';
export type EightBallTopic = 'school' | 'gaming' | 'love' | 'luck' | 'decision';

export const EIGHT_BALL_ANSWERS: Record<EightBallOutcome, string[]> = {
  yes: [
    'JA! 🎱 Das sieht verdammt gut aus.', 'JA! 🎱 Ganz eindeutig.', 'JA! 🎱 Darauf würde ich wetten. Also fast.',
    'JA! 🎱 Die Kugel hat entschieden.', 'JA! 🎱 Das wird was!', 'JA! 🎱 Sogar ziemlich sicher.',
    'JA! 🎱 Heute stehen die Chancen auf deiner Seite.', 'JA! 🎱 Keine Diskussion.', 'JA! 🎱 Ich sehe Erfolg. 👑',
    'JA! 🎱 Das Universum gibt grünes Licht.', 'JA! 🎱 Und jetzt nicht wieder alles zerdenken.', 'JA! 🎱 Die Antwort gefällt dir, oder?',
  ],
  no: [
    'NEIN! 🎱 Ganz sicher nicht.', 'NEIN! 🎱 Das wird wohl nichts.', 'NEIN! 🎱 Die Kugel ist dagegen.',
    'NEIN! 🎱 Vergiss es lieber.', 'NEIN! 🎱 Heute leider nicht.', 'NEIN! 🎱 Nicht einmal knapp.',
    'NEIN! 🎱 Ich sehe schwarz.', 'NEIN! 🎱 Das Universum hat abgelehnt.', 'NEIN! 🎱 Da hilft auch kein Betteln.',
    'NEIN! 🎱 Frag ruhig nochmal. Die Antwort bleibt trotzdem Nein.', 'NEIN! 🎱 Ich würde mir keine Hoffnungen machen.', 'NEIN! 🎱 Die Zukunft hat andere Pläne.',
  ],
  maybe: [
    'VIELLEICHT! 🎱 Noch ist alles offen.', 'VIELLEICHT! 🎱 Frag später nochmal.', 'VIELLEICHT! 🎱 Die Kugel ist unentschlossen.',
    'VIELLEICHT! 🎱 Könnte knapp werden.', 'VIELLEICHT! 🎱 Das hängt wohl vom Glück ab.', 'VIELLEICHT! 🎱 Ich sehe zwei mögliche Ausgänge.',
    'VIELLEICHT! 🎱 Die Zukunft hält sich bedeckt.', "VIELLEICHT! 🎱 Heute gibt's keine klare Antwort.",
  ],
};

export const EIGHT_BALL_TOPIC_ANSWERS: Record<EightBallTopic, Partial<Record<EightBallOutcome, string[]>>> = {
  school: {
    yes: ['JA! 🎱 Die gute Note ist drin. 📚', 'JA! 🎱 Das könnte eine richtig gute Prüfung werden.'],
    no: ['NEIN! 🎱 Die Eins wird wohl schwierig.', 'NEIN! 🎱 Die Klausur könnte dich überraschen. Nicht unbedingt positiv.'],
    maybe: ['VIELLEICHT! 🎱 Die Note steht noch in den Sternen.'],
  },
  gaming: {
    yes: ['JA! 🎱 Der nächste Sieg gehört dir. 🎮', 'JA! 🎱 Heute wird die Lobby aufgeräumt.'],
    no: ['NEIN! 🎱 Heute gewinnt wohl eher der Gegner.', 'NEIN! 🎱 Das wird vermutlich eine schnelle Rückreise in die Lobby.'],
    maybe: ['VIELLEICHT! 🎱 Das Matchmaking entscheidet.'],
  },
  love: {
    yes: ['JA! 🎱 Die Kugel sieht gute Zeichen. 💜'],
    no: ['NEIN! 🎱 Meine Kugel sieht gerade keine großen Chancen.'],
    maybe: ['VIELLEICHT! 🎱 Gefühle sind selbst für meine Kugel kompliziert.'],
  },
  luck: {
    yes: ['JA! 🎱 Das Glück scheint auf deiner Seite zu sein.'],
    no: ['NEIN! 🎱 Heute solltest du dich nicht auf Glück verlassen.'],
    maybe: ['VIELLEICHT! 🎱 Das Schicksal würfelt noch.'],
  },
  decision: {
    yes: ['JA! 🎱 Die Kugel gibt grünes Licht.'],
    no: ['NEIN! 🎱 Die Kugel rät davon ab.'],
    maybe: ['VIELLEICHT! 🎱 Schlaf lieber nochmal drüber.'],
  },
};

const TOPIC_PATTERNS: Array<[EightBallTopic, RegExp]> = [
  ['school', /\b(schule|prüfung|pruefung|klausur|note|zeugnis|lernen|hausaufgabe|abi|studium|uni)\b/iu],
  ['gaming', /\b(gaming|game|spiel|match|runde|sieg|gewinnen|fortnite|lobby|gegner|matchmaking|ranked)\b/iu],
  ['love', /\b(liebe|verliebt|crush|date|sympath|mag mich|freundin|freund|partner)\b/iu],
  ['luck', /\b(glück|glueck|zukunft|morgen|bald|schicksal|lotto|chance)\b/iu],
  ['decision', /\b(soll ich|entscheidung|entscheiden|machen|nehmen|kaufen|wechseln|plan)\b/iu],
];

export const DEFAULT_EIGHT_BALL_SETTINGS = {
  personalCooldownMs: 30_000, globalCooldownMs: 5_000, cooldownNotices: true,
};

export function eightBallOutcomeForRoll(roll: number): EightBallOutcome {
  if (!Number.isInteger(roll) || roll < 1 || roll > 100) throw new RangeError('8-Ball-Ziehung muss zwischen 1 und 100 liegen.');
  return roll <= 40 ? 'yes' : roll <= 80 ? 'no' : 'maybe';
}

export function classifyEightBallTopic(question: string): EightBallTopic | undefined {
  const matches = TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(question));
  return matches.length === 1 ? matches[0]?.[0] : undefined;
}

export function chooseEightBallAnswer(
  question: string,
  outcomeRoll: number,
  answerIndex: number,
  previousAnswer?: string,
): { outcome: EightBallOutcome; topic?: EightBallTopic; answer: string } {
  const outcome = eightBallOutcomeForRoll(outcomeRoll);
  const topic = classifyEightBallTopic(question);
  const themed = topic ? EIGHT_BALL_TOPIC_ANSWERS[topic][outcome] : undefined;
  let pool = themed?.length ? themed : EIGHT_BALL_ANSWERS[outcome];
  if (pool.length === 1 && pool[0] === previousAnswer) pool = EIGHT_BALL_ANSWERS[outcome];
  let index = Math.max(0, Math.min(pool.length - 1, Math.floor(answerIndex)));
  if (pool[index] === previousAnswer && pool.length > 1) index = (index + 1) % pool.length;
  return { outcome, ...(themed?.length && topic ? { topic } : {}), answer: pool[index]! };
}
