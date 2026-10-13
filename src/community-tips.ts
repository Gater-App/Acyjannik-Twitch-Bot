import { createHash } from 'node:crypto';
import type { ChatMessage } from './types.js';
import type { FeatureStore } from './feature-store.js';
import type { ChatProfile } from './chat-response-policy.js';

export interface CommunityTipSettings { enabled: boolean; }
export interface CommunityTipState { lastSentAt: number; streamId: string | null; sentInStream: string[]; sentHistory: number[]; }
export interface TipAvailability {
  events?: boolean; eightBall?: boolean; rps?: boolean; duels?: boolean; pet?: boolean; detective?: boolean;
  quests?: boolean; xp?: boolean; drops?: boolean; imposter?: boolean; wheel?: boolean;
  activeEventCommand?: string; activeEventName?: string;
}
export interface CommunityTip { id: string; category: string; text: string; requiresActiveGame?: boolean; }
export const TIP_ACTIVITY_RULES: Record<ChatProfile, { spacingMs: number; messages: number; hourly: number }> = {
  calm: { spacingMs: 45 * 60_000, messages: 8, hourly: 1 },
  normal: { spacingMs: 30 * 60_000, messages: 6, hourly: 2 },
  lively: { spacingMs: 20 * 60_000, messages: 5, hourly: 3 },
};

const TIPS: CommunityTip[] = [
  { id: 'eightball', category: 'oracle', text: 'Du hast eine Frage? Stell sie dem Orakel mit !8ball FRAGE.' },
  { id: 'rps', category: 'rps', text: 'Lust auf eine schnelle Runde? Fordere das Bot-Orakel mit !rps stein heraus.' },
  { id: 'duel', category: 'duel', text: 'Fordere jemanden aus dem Chat heraus: !duel @Name.' },
  { id: 'pet', category: 'pet', text: 'Lerne Elio kennen: !pet zeigt die Katze, !feed gibt Katzenfutter und !play startet ein Spiel.' },
  { id: 'quote', category: 'detective', text: 'Freiwillig ein Zitat einreichen? Erst !quoteoptin, dann !savequote TEXT.' },
  { id: 'quest', category: 'quest', text: 'Hast du eine Spielidee für alle? Schlage sie mit !quest TEXT vor.' },
  { id: 'xp', category: 'xp', text: 'Mit !level siehst du deinen Community-Fortschritt und deine XP.' },
];
const FEATURE_COMMANDS: Record<string, string> = {
  '8ball': 'eightball', rps: 'rps', duel: 'duel', accept: 'duel',
  pet: 'pet', feed: 'pet', play: 'pet', petcare: 'pet', savequote: 'quote', quest: 'quest',
  trickortreat: 'season-trickortreat', gift: 'season-gift', egghunt: 'season-egghunt', eventscore: 'season-eventscore',
  level: 'xp', xptop: 'xp', rank: 'xp',
};

/** Optional, activity-gated tips. Stores only aggregate counters and public send timestamps, never chat text or user IDs. */
export class CommunityTips {
  private activityCount = 0;
  private activeStreamId: string | null | undefined;
  private readonly recentTextHashes = new Map<string, number>();
  private readonly recentEventIds = new Set<string>();
  private readonly featureUsedAt = new Map<string, number>();
  private readonly sentAt: number[] = [];
  constructor(private readonly store: FeatureStore) {
    const state = this.state();
    this.sentAt.push(...state.sentHistory);
    const usage = this.store.config<unknown>('community_tip_recent_usage', {});
    if (usage && typeof usage === 'object') for (const [topic, at] of Object.entries(usage))
      if (typeof at === 'number' && Number.isFinite(at) && at > 0) this.featureUsedAt.set(topic, at);
  }

  settings(): CommunityTipSettings {
    const raw = this.store.config<unknown>('community_tip_settings', { enabled: false });
    return { enabled: Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>).enabled === true) };
  }
  configure(enabled: boolean): CommunityTipSettings {
    this.store.setConfig('community_tip_settings', { enabled });
    return this.settings();
  }
  state() {
    const raw = this.store.config<unknown>('community_tip_state', { lastSentAt: 0, streamId: null, sentInStream: [], sentHistory: [] });
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      lastSentAt: Number.isFinite(value.lastSentAt) ? Math.max(0, Number(value.lastSentAt)) : 0,
      streamId: typeof value.streamId === 'string' ? value.streamId : null,
      sentInStream: Array.isArray(value.sentInStream) ? value.sentInStream.filter((id): id is string => typeof id === 'string') : [],
      sentHistory: Array.isArray(value.sentHistory) ? value.sentHistory.filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0).slice(-24) : [],
    };
  }
  observe(message: ChatMessage, now = Date.now()): void {
    if (this.recentEventIds.has(message.eventId)) return;
    this.recentEventIds.add(message.eventId);
    if (this.recentEventIds.size > 2000) this.recentEventIds.delete(this.recentEventIds.values().next().value!);
    if (message.isModerator) return;
    const command = message.message.trim().match(/^!([a-z0-9_-]+)/iu)?.[1]?.toLowerCase();
    if (command) {
      const topic = FEATURE_COMMANDS[command];
      if (topic && this.settings().enabled) {
        this.featureUsedAt.set(topic, now);
        this.store.setConfig('community_tip_recent_usage', Object.fromEntries(this.featureUsedAt));
      }
      return;
    }
    if (message.senderUserId === message.broadcasterUserId) return;
    const text = message.message.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
    if (Array.from(text).length < 3 || /https?:\/\//iu.test(text) || !/[\p{L}\p{N}]/u.test(text)) return;
    const hash = createHash('sha256').update(text).digest('hex');
    for (const [key, at] of this.recentTextHashes) if (now - at > 5 * 60_000) this.recentTextHashes.delete(key);
    if (this.recentTextHashes.has(hash)) return;
    this.recentTextHashes.set(hash, now);
    if (this.recentTextHashes.size > 500) this.recentTextHashes.delete(this.recentTextHashes.keys().next().value!);
    this.activityCount++;
  }

  preview(availability: TipAvailability): CommunityTip[] { return this.available(availability); }
  get eligibleActivityMessages():number { return this.activityCount; }
  consumeActivity():void { this.activityCount=0; }
  alignStream(streamId:string|null):void {
    if(this.activeStreamId!==streamId){this.activeStreamId=streamId;this.activityCount=0;}
  }
  status(profile: ChatProfile, now = Date.now()) {
    const state = this.state(), rules = TIP_ACTIVITY_RULES[profile];
    const recent = this.sentAt.filter(at => now - at < 60 * 60_000).length;
    return { ...this.settings(), profile, lastTipAt: state.lastSentAt || null,
      nextEarliestAt: state.lastSentAt ? state.lastSentAt + rules.spacingMs : null,
      activityMessages: this.activityCount, requiredMessages: rules.messages, hourlyLimit: rules.hourly, sentThisHour: recent };
  }

  shouldEvaluate(profile: ChatProfile, availability: TipAvailability, busy: boolean, now = Date.now()): boolean {
    if (!this.settings().enabled || busy || this.activityCount < TIP_ACTIVITY_RULES[profile].messages) return false;
    const state = this.state(), rules = TIP_ACTIVITY_RULES[profile];
    if (state.lastSentAt && now - state.lastSentAt < rules.spacingMs) return false;
    if (this.sentAt.filter(at => now - at < 60 * 60_000).length >= rules.hourly) return false;
    const usedInStream = this.activeStreamId === undefined || state.streamId === this.activeStreamId ? state.sentInStream : [];
    return this.available(availability).some(tip => !usedInStream.includes(tip.id)
      && (!this.featureUsedAt.has(tip.id) || now - this.featureUsedAt.get(tip.id)! > 15 * 60_000));
  }

  maybeSend(input: { isLive: boolean | undefined; streamId?: string; profile: ChatProfile; availability: TipAvailability;
    busy: boolean; now?: number; random?: (max: number) => number; allowSend?: (tip: CommunityTip) => boolean }): (CommunityTip & { streamId: string }) | undefined {
    const now = input.now ?? Date.now();
    if (!this.settings().enabled) return undefined;
    if (input.isLive === false) { this.activeStreamId = null; this.activityCount = 0; return undefined; }
    if (input.isLive !== true || !input.streamId) return undefined;
    if (this.activeStreamId !== input.streamId) { this.activeStreamId = input.streamId; this.activityCount = 0; return undefined; }
    if (input.busy) { this.activityCount = 0; return undefined; }
    const rules = TIP_ACTIVITY_RULES[input.profile], state = this.state();
    if (state.lastSentAt && now - state.lastSentAt < rules.spacingMs) return undefined;
    const pastHour = this.sentAt.filter(at => now - at < 60 * 60_000);
    if (pastHour.length >= rules.hourly || this.activityCount < rules.messages) return undefined;
    const sentInStream = state.streamId === input.streamId ? state.sentInStream : [];
    const candidates = this.available(input.availability).filter(tip => !sentInStream.includes(tip.id)
      && (!this.featureUsedAt.has(tip.id) || now - this.featureUsedAt.get(tip.id)! > 15 * 60_000));
    if (!candidates.length) return undefined;
    const selected = candidates[(input.random ?? secureRandom)(candidates.length)];
    if (!selected) return undefined;
    if (this.featureUsedAt.has(selected.id) && now - this.featureUsedAt.get(selected.id)! < 15 * 60_000) return undefined;
    if (input.allowSend && !input.allowSend(selected)) return undefined;
    this.store.setConfig('community_tip_state', { lastSentAt: now, streamId: input.streamId,
      sentInStream: [...sentInStream, selected.id], sentHistory: [...this.sentAt.filter(at => now - at < 60 * 60_000), now].slice(-24) });
    this.sentAt.push(now);
    this.activityCount = 0;
    return { ...selected, streamId: input.streamId };
  }

  private available(a: TipAvailability): CommunityTip[] {
    return TIPS.filter(tip => {
      if (tip.id === 'eightball') return a.eightBall === true;
      if (tip.id === 'rps') return a.rps === true;
      if (tip.id === 'duel') return a.duels === true;
      if (tip.id === 'pet') return a.pet === true;
      if (tip.id === 'quote') return a.detective === true;
      if (tip.id === 'quest') return a.quests === true;
      if (tip.id === 'xp') return a.xp === true;
      return false;
    }).concat(a.events && a.activeEventCommand ? [{
      id: `season-${a.activeEventCommand}`, category: a.activeEventCommand === 'trickortreat' ? 'halloween' : 'season',
      text: `Beim ${a.activeEventName || 'Saison-Event'} kannst du mit !${a.activeEventCommand} mitmachen und Punkte sammeln.`,
    }] : []);
  }
}

function secureRandom(max: number): number { return Math.floor(Math.random() * max); }
