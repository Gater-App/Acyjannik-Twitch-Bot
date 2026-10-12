import type { AppConfig, ChatMessage, CommandReply, HalloweenEvent } from './types.js';
import { Database } from './database.js';
import { formatCooldown, GameService } from './game.js';
import { clampChatMessage, eventMessage } from './chat.js';

const RESET_CONFIRMATION = 'confirm';
const RESET_CONFIRMATION_TTL_MS = 60_000;

function cleanName(name: string): string {
  return Array.from(name.replace(/[\r\n\t]/gu, ' ').trim()).slice(0, 32).join('') || 'Unbekannt';
}

function durationText(remainingMs: number): string {
  return formatCooldown(remainingMs);
}

export class CommandHandler {
  private readonly pendingReset = new Map<string, number>();

  constructor(
    private readonly database: Database,
    private readonly game: GameService,
    private readonly config: AppConfig,
    private readonly backup: (destination: string) => Promise<void> = (destination) => this.database.backup(destination),
  ) {}

  async handle(message: ChatMessage, now = Date.now()): Promise<CommandReply[]> {
    if (message.senderUserId === this.config.botUserId || message.senderLogin.toLowerCase() === this.config.botLogin.toLowerCase()) return [];
    if (message.broadcasterUserId !== this.config.broadcasterUserId) return [];
    if (!this.database.markEventProcessed(message.eventId, now)) return [];
    const words = message.message.trim().split(/\s+/u);
    const rawCommand = words.shift();
    if (!rawCommand?.startsWith('!')) return [];
    const command = rawCommand.slice(1).toLowerCase();
    const args = words;
    const name = cleanName(message.senderDisplayName);
    const reply = (text: string): CommandReply[] => [{ message: clampChatMessage(text, this.config.appChatMessageLength), ...(message.messageId ? { replyParentMessageId: message.messageId } : {}) }];

    switch (command) {
      case 'trickortreat': return reply(this.trickOrTreat(name, message.senderUserId, now));
      case 'pumpkins': return reply(`🎃 ${name} hat ${this.game.pumpkins(message.senderUserId)} Kürbisse.`);
      case 'top': return reply(this.topMessage());
      case 'halloween': return reply(this.halloweenMessage());
      case 'starthalloween':
        if (!this.isAuthorizedModerator(message)) return reply('⛔ Nur Yannick oder autorisierte Mods dürfen das Event starten.');
        return reply(this.game.start(now) ? '🎃 Halloween ist gestartet! !trickortreat für Kürbisse.' : '🎃 Halloween läuft bereits.');
      case 'endhalloween':
        if (!this.isAuthorizedModerator(message)) return reply('⛔ Nur Yannick oder autorisierte Mods dürfen das Event beenden.');
        return reply(this.endMessage(now));
      case 'resethalloween':
        if (message.senderUserId !== this.config.broadcasterUserId) return reply('⛔ Nur Yannick darf die Punkte zurücksetzen.');
        return reply(await this.resetMessage(message.senderUserId, args, now));
      default: return [];
    }
  }

  private trickOrTreat(name: string, userId: string, now: number): string {
    const result = this.game.play(userId, name, now);
    if (!result.ok) {
      if (result.reason === 'inactive') return '🎃 Halloween ist noch nicht gestartet.';
      return `⏳ ${name}: Du kannst in ${durationText(result.remainingMs ?? 0)} wieder losziehen.`;
    }
    const { outcome } = result;
    const template = this.templateFor(outcome.event);
    const points = Math.abs(outcome.delta);
    return `${eventMessage(template, { name, points, pumpkins: outcome.pumpkins })} Gesamt: ${outcome.pumpkins}.`;
  }

  private topMessage(): string {
    const top = this.game.top(10);
    if (top.length === 0) return '🏆 Noch keine Kürbisse gesammelt.';
    return `🏆 Top 10: ${top.map((player, index) => `${index + 1}. ${cleanName(player.displayName)} ${player.pumpkins}`).join(' · ')}`;
  }

  private halloweenMessage(): string {
    return this.game.active
      ? `🎃 Halloween läuft! !trickortreat alle ${Math.round(this.config.cooldownMs / 60_000)} Min. Punkte: !pumpkins · Rangliste: !top`
      : '🎃 Halloween ist beendet. Regeln: !trickortreat gewinnt, verliert oder findet Kürbisse; Punkte werden nie negativ.';
  }

  private endMessage(now: number): string {
    const ended = this.game.end(now);
    if (!ended.ended) return '🎃 Halloween läuft nicht.';
    return ended.winner
      ? `🏆 Halloween beendet! Gewinner: ${cleanName(ended.winner.displayName)} mit ${ended.winner.pumpkins} Kürbissen!`
      : '🎃 Halloween beendet. Es wurden noch keine Kürbisse gesammelt.';
  }

  private async resetMessage(userId: string, args: string[], now: number): Promise<string> {
    const expiresAt = this.pendingReset.get(userId) ?? 0;
    if (args[0]?.toLowerCase() !== RESET_CONFIRMATION || expiresAt < now) {
      this.pendingReset.set(userId, now + RESET_CONFIRMATION_TTL_MS);
      return '⚠️ Sicher? Punkte werden zurückgesetzt. Bestätige innerhalb 60 Sek. mit !resetHalloween CONFIRM.';
    }
    const backupPath = `backups/halloween-${new Date(now).toISOString().replace(/[:.]/gu, '-')}.sqlite`;
    await this.backup(backupPath);
    this.database.resetScores(now);
    this.pendingReset.delete(userId);
    return '✅ Punkte zurückgesetzt; ein SQLite-Backup wurde vorher erstellt.';
  }

  private isAuthorizedModerator(message: ChatMessage): boolean {
    return message.senderUserId === this.config.broadcasterUserId
      || this.config.authorizedModeratorIds.includes(message.senderUserId)
      || message.isModerator === true;
  }

  private templateFor(event: HalloweenEvent): string {
    const texts = this.config.texts;
    switch (event) {
      case 'TREAT': return texts.treat;
      case 'TRICK': return texts.trick;
      case 'JACKPOT': return texts.jackpot;
      case 'GHOST': return texts.ghost;
      case 'WITCH': return texts.witch;
      case 'GOLDEN_PUMPKIN': return texts.goldenPumpkin;
      default: return texts.emptyHouse;
    }
  }
}
