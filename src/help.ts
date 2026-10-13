import type { ChatMessage } from './types.js';

const PUBLIC_HELP: Record<string, string> = {
  basics: '⭐ !help events · !help xp · !help games · !help quests · !help spark · !help imposter · !help detective · !help pet · !help drops · !help wheel. Eigene Befehle zeigt !Befehlsname.',
  events: '✨ Aktives Sammel-Event: !gift oder !egghunt (je nach Event). Punkte: !eventscore · Rangliste: !eventtop. Halloween: !trickortreat · !pumpkins · !top · !halloween.',
  xp: '⭐ !level [@user] zeigt Level/XP · !rank deinen Rang · !xptop die XP-Topliste. Spiel-XP unterliegen Tageslimits.',
  games: '🎮 !8ball FRAGE · !rps schere|stein|papier · !guess ZAHL (wenn eine Runde läuft) · !duel @user, dann !accept · !boss / !attack / !bosstop (wenn Boss aktiv).',
  quests: '📜 !quest DEINE IDEE reicht einen moderierten Vorschlag ein · !quests zeigt Status · !myquest deinen letzten Vorschlag. Umfrage: !poll, abstimmen mit !vote NUMMER, Ergebnis: !pollresults.',
  spark: '✨ !spark zeigt den Status · !sparkhelp erklärt die Erkennung · !sparktopics zeigt erkannte Themen. Aktionen brauchen Freigabe; !sparks zeigt offene Vorschläge.',
  imposter: '🎭 !imposterstatus zeigt die Runde · !joinimposter / !leaveimposter zur Anmeldung · !sus @Name stimmt während der Abstimmung ab. Teilnahme freiwillig; !imposter zeigt den Status.',
  detective: '🕵️ !detektiv zeigt die Runde · !wer @Name tippt den Autor · !quote zeigt das Zitat erneut. Eigenes Zitat bewusst einreichen: !savequote TEXT; !myquotes / !deletequote ID verwalten.',
  pet: '🐉 Wenn das Pet aktiviert ist: !pet · !petcare · !feed · !play · !petstats · !petname · !petevolution. !pethelp zeigt die Kurz-Hilfe.',
  drops: '🎁 Wenn Drops aktiviert sind: !drop zeigt den laufenden Drop · !claim nimmt teil · !dropstats zeigt deine Claims · !drops erklärt das Feature.',
  wheel: '🎡 Wenn aktiviert: !wheel / !wheelstatus zeigt das Chaos Wheel. !spin startet direkt das nächste verfügbare Rad-Feld; Mods können es auch über das Dashboard drehen. Automatische Felder laufen selbst, Challenges spielt Jannick innerhalb des Timers selbst.',
};

const MOD_HELP = '🛡️ Mod/Jannik: !starthalloween / !endhalloween · !startevent ID / !endevent ID · !startguess · !startboss / !endboss · !questqueue / !approvequest ID / !rejectquest ID (Mod-Rechte je nach Einstellung) · !sparkapprove ID / !sparkreject ID · !startimposter / !closeimposter / !cancelimposter · !startdetektiv / !skipdetektiv / !enddetektiv · !startdrop / !canceldrop · !startwheel / !cancelwheel.';
const OWNER_HELP = '🔒 Nur Jannik: !resethalloween CONFIRM (setzt Punkte zurück, vorher Backup) · !setpetname NAME / !petpause / !petresume · !sparkpause / !sparkresume. Weitere Verwaltung im Dashboard.';

export function helpReply(args: string[], message: ChatMessage): string {
  const topic = (args[0] || '').toLocaleLowerCase('de-DE');
  if (topic === 'mods' || topic === 'admin') {
    const broadcaster = message.senderUserId === message.broadcasterUserId;
    const moderator = broadcaster || message.isModerator === true;
    if (!moderator) return '⛔ Diese Befehlsübersicht ist nur für Jannik und Twitch-Moderatoren.';
    return topic === 'admin' && broadcaster ? `${MOD_HELP} ${OWNER_HELP}` : MOD_HELP;
  }
  return PUBLIC_HELP[topic] || PUBLIC_HELP.basics!;
}

export const HELP_TOPICS = Object.keys(PUBLIC_HELP);
