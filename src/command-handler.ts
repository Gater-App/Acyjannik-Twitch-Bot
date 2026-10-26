import type { AppConfig, ChatMessage, CommandReply, HalloweenEvent } from './types.js';
import { Database } from './database.js';
import { formatCooldown, GameService } from './game.js';
import { clampChatMessage, eventMessage } from './chat.js';
import type { CommunityFeatures } from './community-features.js';
import { DEFAULT_HELP_AVAILABILITY, helpReply } from './help.js';
import type { ChatResponsePolicy } from './chat-response-policy.js';
import type { CommunityTips } from './community-tips.js';
import { categoryForCommand, type ChatCategory } from './chat-message-format.js';

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
  private readonly helpCooldowns = new Map<string, number>();

  constructor(
    private readonly database: Database,
    private readonly game: GameService,
    private readonly config: AppConfig,
    private readonly backup: (destination: string) => Promise<void> = (destination) => this.database.backup(destination),
    private readonly community?: CommunityFeatures,
    private readonly chatPolicy?: ChatResponsePolicy,
    private readonly communityTips?: CommunityTips,
  ) {}

  async handle(message: ChatMessage, now = Date.now()): Promise<CommandReply[]> {
    if (message.senderUserId === this.config.botUserId || message.senderLogin.toLowerCase() === this.config.botLogin.toLowerCase()) return [];
    if (message.broadcasterUserId !== this.config.broadcasterUserId) return [];
    if (!this.database.markEventProcessed(message.eventId, now)) return [];
    this.communityTips?.observe(message, now);
    this.community?.tick(now, false);
    const words = message.message.trim().split(/\s+/u);
    const rawCommand = words.shift();
    if (!rawCommand?.startsWith('!')) {
      const welcome = this.community?.firstChatWelcome(message, now, this.chatPolicy?.snapshot().welcomeBots);
      if (welcome) return [{ message: clampChatMessage(welcome, this.config.appChatMessageLength), category: 'welcome', ...(message.messageId ? { replyParentMessageId: message.messageId } : {}) }];
      const sparkSuggestion = this.community?.observeActivity(message, now);
      return sparkSuggestion ? [{ message: clampChatMessage(sparkSuggestion, this.config.appChatMessageLength), category: 'ideas', ...(message.messageId ? { replyParentMessageId: message.messageId } : {}) }] : [];
    }
    const command = rawCommand.slice(1).toLowerCase();
    const args = words;
    const reply = (text: string, category: ChatCategory = categoryForCommand(command)): CommandReply[] => [{ message: clampChatMessage(text, this.config.appChatMessageLength), category, ...(message.messageId ? { replyParentMessageId: message.messageId } : {}) }];
    const name = cleanName(message.senderDisplayName);
    switch (command) {
      case 'help': {
        const until=this.helpCooldowns.get(message.senderUserId)||0;
        if(now<until)return [];
        this.helpCooldowns.set(message.senderUserId,now+5_000);
        if(this.helpCooldowns.size>5000)for(const [id,expiry] of this.helpCooldowns)if(expiry<=now)this.helpCooldowns.delete(id);
        return reply(helpReply(args,message,this.community?.helpAvailability()||DEFAULT_HELP_AVAILABILITY),args[0]?.toLocaleLowerCase('de-DE')==='pet'?'pet':'help');
      }
      case 'community': {
        const until=this.helpCooldowns.get(message.senderUserId)||0;
        if(now<until)return [];
        this.helpCooldowns.set(message.senderUserId,now+5_000);
        return reply('Dein Community-Portal: XP und Level ansehen, Elio 🐱 besuchen, Quest-Ideen und Community-Ideen einreichen und bei Imposter mitspielen: https://twitch.gater-app.de/community','communityPortal');
      }
      case 'discord': {
        const invite=this.community?.discordInviteLink();
        return reply(invite?`💜 Komm zu uns auf Discord: ${invite}`:'💜 Der Discord-Einladungslink ist gerade nicht eindeutig in den aktiven Chat-Hinweisen hinterlegt.','communityPortal');
      }
      case 'trickortreat': {
        const result = this.trickOrTreat(name, message.senderUserId, message.eventId, now, message.messageId);
        if(result.suppress)return [];
        return [{ message: clampChatMessage(result.message, this.config.appChatMessageLength), category: result.category,
          ...(result.deliveryId ? { durableDeliveryId: result.deliveryId } : {}), ...(message.messageId ? { replyParentMessageId: message.messageId } : {}) }];
      }
      case 'pumpkins': return reply(`🎃 ${name} hat ${this.game.pumpkins(message.senderUserId)} Kürbisse.`);
      case 'top': return reply(this.topMessage());
      case 'halloween': return reply(this.halloweenMessage());
      case 'starthalloween':
        if (!this.isAuthorizedModerator(message)) return reply('⛔ Nur Jannik oder autorisierte Mods dürfen das Event starten.');
        if (this.community?.activeEventId() && this.community.activeEventId() !== 'halloween') return reply('🎃 Erst das aktuell laufende Saison-Event beenden.');
        if (!this.game.start(now)) return reply('🎃 Halloween läuft bereits.');
        this.community?.syncLegacyHalloween(now);
        return reply('🎃 Halloween ist gestartet! !trickortreat für Kürbisse.');
      case 'endhalloween':
        if (!this.isAuthorizedModerator(message)) return reply('⛔ Nur Jannik oder autorisierte Mods dürfen das Event beenden.');
        { const text = this.endMessage(now); this.community?.syncLegacyHalloween(now); return reply(text); }
      case 'resethalloween':
        if (message.senderUserId !== this.config.broadcasterUserId) return reply('⛔ Nur Jannik darf die Punkte zurücksetzen.');
        return reply(await this.resetMessage(message.senderUserId, args, now));
      default: {
        const response = await this.community?.handle(message, command, args, now);
        return response || [];
      }
    }
  }

  private trickOrTreat(name: string, userId: string, eventId: string, now: number, replyParentMessageId?: string): {message:string;category:ChatCategory;deliveryId?:string;suppress?:boolean} {
    const format=(outcome:import('./types.js').GameOutcome)=>`${eventMessage(this.templateFor(outcome.event), { name, points: Math.abs(outcome.delta), pumpkins: outcome.pumpkins })} Gesamt: ${outcome.pumpkins}.`;
    if(this.community){
      if(!this.game.active)return {message:'🎃 Halloween ist noch nicht gestartet.',category:'hint'};
      this.community.syncLegacyHalloween(now);
      const rolled=this.game.drawOutcome();
      const result=this.community.playHalloweenOutcome(userId,name,eventId,rolled.delta,now,
        points=>format({...rolled,pumpkins:points}),replyParentMessageId);
      if(!result.ok){
        if(result.reason==='duplicate')return {message:'',category:'halloween',suppress:true};
        if(result.reason==='inactive')return {message:'🎃 Halloween ist noch nicht gestartet.',category:'hint'};
        return {message:`${name}: Du kannst in ${durationText(result.remainingMs ?? 0)} wieder losziehen.`,category:'cooldown'};
      }
      this.community.syncLegacyHalloween(now);
      this.community.recordHauntedHouseContribution(eventId,userId,now);
      return {message:result.message,category:'halloween',...(result.deliveryId?{deliveryId:result.deliveryId}:{})};
    }
    const result = this.game.play(userId, name, now);
    if (!result.ok) {
      if (result.reason === 'inactive') return {message:'🎃 Halloween ist noch nicht gestartet.',category:'hint'};
      return {message:`${name}: Du kannst in ${durationText(result.remainingMs ?? 0)} wieder losziehen.`,category:'cooldown'};
    }
    const { outcome } = result;
    return {message:format(outcome),category:'halloween',...(result.deliveryId?{deliveryId:result.deliveryId}:{})};
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
    this.community?.syncLegacyHalloween(now);
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
