import type { SeasonalLossTransfer } from './feature-store.js';

const clean = (value: string): string => Array.from(value.replace(/[\r\n\t]/gu, ' ').trim()).slice(0, 32).join('') || 'Unbekannt';

/** Public chat copy for a committed transfer, or a truthful no-transfer result. */
export function formatSeasonalLoss(eventType: string, transfer: SeasonalLossTransfer, variant = 0): string {
  const loser = clean(transfer.loserName);
  if (transfer.status === 'no_balance') {
    const item = eventType === 'halloween' ? 'Kürbisse' : eventType === 'christmas' ? 'Geschenke' : 'Ostereier';
    const emoji = eventType === 'halloween' ? '🎃' : eventType === 'christmas' ? '🎄' : '🐰';
    const copy = [`${emoji} @${loser} hatte keine ${item}, die verloren gehen könnten – alles bleibt unverändert.`,
      `${emoji} Bei @${loser} gab es keine ${item} zum Umverteilen. Nichts wurde abgezogen.`];
    return copy[Math.abs(variant) % copy.length]!;
  }
  if (transfer.status === 'no_recipient' || !transfer.recipientName) {
    const item = eventType === 'halloween' ? 'Kürbisse' : eventType === 'christmas' ? 'Geschenke' : 'Ostereier';
    const emoji = eventType === 'halloween' ? '🎃' : eventType === 'christmas' ? '🎄' : '🐰';
    const copy = [`${emoji} Gerade war kein anderer Zuschauer aktiv – @${loser}s ${item} bleiben unangetastet.`,
      `${emoji} Niemand anderes war gerade da: @${loser} behält alle ${item}.`];
    return copy[Math.abs(variant) % copy.length]!;
  }
  const recipient = clean(transfer.recipientName);
  const amount = transfer.amount;
  const copy = eventType === 'halloween'
    ? [`🎃 Die Kürbishexe schlägt zu! @${loser} verliert ${amount} Kürbisse und @${recipient} schnappt sie sich! 👻`, `👻 Kürbis-Chaos! ${amount} Kürbisse wandern von @${loser} zu @${recipient}! 🎃`]
    : eventType === 'christmas'
      ? [`🎄 Der Weihnachtswichtel hat umverteilt! ${amount} Geschenke wandern von @${loser} zu @${recipient}! 🎁`, `🎁 Ho-ho-hoppla! @${recipient} bekommt ${amount} Geschenke von @${loser}.`]
      : [`🐰 Der Osterhase hat die Verstecke vertauscht! @${recipient} bekommt ${amount} Ostereier von @${loser}! 🥚`, `🥚 Oster-Überraschung: ${amount} Ostereier wandern von @${loser} zu @${recipient}! 🐰`];
  return copy[Math.abs(variant) % copy.length]!;
}
