import type { ChatMessage } from './types.js';

export interface HelpAvailability {
  xp: boolean;
  events: boolean;
  activeEventName?: string;
  activeEventCommand?: string;
  seasonalEvents?: Array<{id:string;name:string;command:string;active:boolean}>;
  pet: boolean;
  drops: boolean;
  wheel: boolean;
  imposter: boolean;
  detective: boolean;
  quests: boolean;
  spark: boolean;
  eightBall: boolean;
  rps: boolean;
  guess: boolean;
  duels: boolean;
}

export const DEFAULT_HELP_AVAILABILITY: HelpAvailability = {
  xp:true, events:false, pet:false, drops:false, wheel:false, imposter:false, detective:false,
  quests:false, spark:false, eightBall:false, rps:false, guess:false, duels:false,
};

const MOD_TOPICS = '🛡️ Mod-Hilfe: !help mods spiele · !help mods community · !help mods events.';
const MOD_SECTIONS: Record<string,string> = {
  spiele:'🛡️ Spiele steuern: Imposter !startimposter / !closeimposter / !cancelimposter · Detektiv !startdetektiv / !enddetektiv · Drop !startdrop / !canceldrop · Glücksrad !startwheel / !cancelwheel.',
  community:'🛡️ Community verwalten: Questvorschläge !questqueue / !approvequest ID / !rejectquest ID · Chat-Ideen !sparks / !sparkapprove ID / !sparkreject ID.',
  events:'🛡️ Saison-Events: !startevent ID zum Starten · !endevent ID zum Beenden. Halloween: !starthalloween / !endhalloween.',
};

const ALIASES: Record<string,string> = {
  basics:'start', start:'start', games:'spiele', game:'spiele', drops:'drop', wheel:'gluecksrad',
  halloween:'event-halloween', weihnachten:'event-christmas', christmas:'event-christmas', ostern:'event-easter', easter:'event-easter',
  detektiv:'detektiv', detective:'detektiv', pet:'pet', quests:'quests', spark:'ideen', 'chat-ideen':'ideen',
};

export function helpReply(args: string[], message: ChatMessage, availability: HelpAvailability = DEFAULT_HELP_AVAILABILITY): string {
  const topic = (args[0] || '').toLocaleLowerCase('de-DE');
  if (topic === 'mods' || topic === 'admin') {
    const broadcaster = message.senderUserId === message.broadcasterUserId;
    if (!broadcaster && message.isModerator !== true) return '⛔ Diese Hilfe ist nur für Jannick und Twitch-Moderatoren.';
    if (topic === 'admin' && broadcaster) return '🔒 Nur Jannick: !help mods · Dashboard: twitch.gater-app.de/dashboard.';
    const section = args[1];
    return section ? MOD_SECTIONS[section.toLowerCase()] || MOD_TOPICS : MOD_TOPICS;
  }

  const normalized = ALIASES[topic] || topic;
  switch (normalized) {
    case 'start': return '🎮 !help spiele | 🎃 !help events | 🏆 !help xp | 📜 !help quests | 📖 Alle Befehle: twitch.gater-app.de/hilfe';
    case 'spiele': return gameHelp(availability);
    case 'event-halloween': return seasonalHelp('halloween',availability);
    case 'event-christmas': return seasonalHelp('christmas',availability);
    case 'event-easter': return seasonalHelp('easter',availability);
    case 'events': return availability.events && availability.activeEventName && availability.activeEventCommand
      ? `✨ ${availability.activeEventName} läuft! Teilnahme mit !${availability.activeEventCommand}; Punkte und Rang: !eventscore oder !eventtop.`
      : '✨ Gerade läuft kein Saison-Event. Wenn Jannick Halloween, Weihnachten oder Ostern startet, erscheint hier der passende Mitmach-Befehl.';
    case 'xp': return availability.xp ? '🏆 Spiele geben XP und Level-Fortschritt. Schreibe !level für deinen Stand oder !rank für deinen Rang.' : '🏆 XP und Level sind derzeit deaktiviert.';
    case 'quests': return availability.quests ? '📜 Schlage mit !quest DEINE IDEE eine Aufgabe vor. Nach Freigabe können alle bei der Quest mitmachen.' : '📜 Community-Quests sind derzeit deaktiviert.';
    case 'ideen': return availability.spark ? '✨ Der Bot erkennt häufige Gaming-Themen. Mit !spark siehst du den Status; Vorschläge werden erst nach Freigabe gestartet.' : '✨ Chat-Ideen sind derzeit deaktiviert.';
    case 'imposter': return availability.imposter ? '🎭 Freiwilliges Ratespiel: Schreibe !joinimposter bei offener Anmeldung. Deine geheime Rolle siehst du nach Twitch-Anmeldung; später stimmt ihr mit !sus @Name ab.' : '🎭 Chat-Imposter ist derzeit deaktiviert.';
    case 'detektiv': return availability.detective ? '🕵️ Errate den Absender eines freigegebenen Zitats mit !wer @Name. Eigene Zitate reichst du einzeln mit !savequote TEXT ein.' : '🕵️ Chat-Detektiv ist derzeit deaktiviert.';
    case 'pet': return availability.pet ? '🐱 Elio ist die Community-Katze: !pet zeigt den Zustand, !feed gibt Katzenfutter, !play startet Spielangel- oder Wollknäuel-Spiel, !petcare kümmert sich um ihn und !petstats zeigt Werte.' : '🐱 Elio macht Pause und ist derzeit nicht verfügbar.';
    case 'drop': return availability.drops ? '🎁 Jannick startet eine Belohnungsrunde. Während des Drops schreibe !claim; das Ergebnis wird automatisch bekannt gegeben.' : '🎁 Mystery Drops sind derzeit deaktiviert.';
    case 'gluecksrad': return availability.wheel ? '🎡 Jannick dreht das Glücksrad. Das Ergebnis startet automatisch; bei einer Challenge spielt Jannick die Aufgabe. Status: !wheel.' : '🎡 Das Chaos Wheel ist derzeit deaktiviert.';
    default: return '🎮 !help spiele | 🎃 !help events | 🏆 !help xp | 📜 !help quests | 📖 Alle Befehle: twitch.gater-app.de/hilfe';
  }
}

function gameHelp(a: HelpAvailability): string {
  const games = [
    a.eightBall && '!8ball FRAGE (Orakel)', a.rps && '!rps stein (Schere-Stein-Papier)',
    a.guess && '!guess ZAHL (Zahlenraten)', a.duels && '!duel @Name (Duell)',
  ].filter(Boolean);
  return games.length ? `🎮 Weitere Chatspiele: ${games.join(' · ')}.` : '🎮 Weitere Chatspiele sind derzeit deaktiviert. Für Community-Runden: !help imposter oder !help detective.';
}

export const HELP_TOPICS = ['start','spiele','events','xp','quests','ideen','imposter','detektiv','pet','drop','gluecksrad'];

function seasonalHelp(id:string,availability:HelpAvailability):string {
  const event=availability.seasonalEvents?.find(item=>item.id===id);
  const name=event?.name||(id==='halloween'?'Halloween':id==='christmas'?'Weihnachten':'Ostern');
  return event?.active?`✨ ${name} läuft! Schreibe !${event.command}, um saisonale Punkte zu sammeln.`:`✨ ${name} ist gerade nicht aktiv. Sobald Jannick das Event startet, wird der Mitmach-Befehl verfügbar.`;
}
