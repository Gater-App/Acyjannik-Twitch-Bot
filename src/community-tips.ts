import { createHash } from 'node:crypto';
import type { ChatMessage } from './types.js';
import type { FeatureStore } from './feature-store.js';
import type { ChatProfile } from './chat-response-policy.js';

export type HalloweenTipFrequency = 'normal' | 'frequent';
export const COMMUNITY_TIP_CATEGORIES = [
  { id: 'pet', name: 'Elio', description: 'Community-Katze und ihre Pflege.' },
  { id: 'quest', name: 'Quests', description: 'Ideen einreichen und freigegebene Community-Aufgaben.' },
  { id: 'xp', name: 'XP & Level', description: 'Persönlichen Fortschritt ansehen.' },
  { id: 'communityPortal', name: 'Community-Portal', description: 'Öffentliche Portal-Seite, nur wenn sie erreichbar ist.' },
  { id: 'wheel', name: 'Chaos Wheel', description: 'Aktionen und Status des Glücksrads.' },
  { id: 'drop', name: 'Mystery Drops', description: 'Mitmachen, wenn Jannik einen Drop startet.' },
  { id: 'vault', name: 'Community-Tresor', description: 'Gemeinsam den dreistelligen Code knacken.' },
  { id: 'detective', name: 'Chat-Detektiv', description: 'Freigegebene Zitate erraten oder freiwillig einreichen.' },
  { id: 'imposter', name: 'Imposter', description: 'Bei offener Anmeldung an der Runde teilnehmen.' },
  { id: 'duel', name: 'Duell', description: 'Andere Zuschauer herausfordern.' },
  { id: 'oracle', name: 'Orakel', description: 'Fragen mit dem 8-Ball stellen.' },
  { id: 'rps', name: 'Schere, Stein, Papier', description: 'Kurze Runde gegen das Bot-Orakel.' },
  { id: 'guess', name: 'Zahlenraten', description: 'Bei einer gestarteten Runde mitraten.' },
  { id: 'season', name: 'Saison-Events', description: 'Nur das tatsächlich aktive Event.' },
  { id: 'halloween', name: 'Halloween', description: 'Saisonhinweise während des aktiven Halloween-Events.' },
] as const;
export type CommunityTipCategoryId = typeof COMMUNITY_TIP_CATEGORIES[number]['id'];
export interface CommunityTipSettings { enabled: boolean; portalEnabled: boolean; halloweenEnabled: boolean; halloweenFrequency: HalloweenTipFrequency; enabledCategories?: Partial<Record<CommunityTipCategoryId, boolean>>; }
export interface CommunityTipState { lastSentAt: number; streamId: string | null; sentInStream: string[]; sentHistory: number[]; lastCategory?: string; lastTipId?: string; lastDeliveredAt?: number; lastDeliveredText?: string; lastDeliveredCategory?: string; }
export interface TipAvailability {
  events?: boolean; eightBall?: boolean; rps?: boolean; guess?: boolean; duels?: boolean; pet?: boolean; detective?: boolean;
  quests?: boolean; xp?: boolean; drops?: boolean; imposter?: boolean; wheel?: boolean; vault?: boolean; petCare?: boolean;
  activeEventCommand?: string; activeEventName?: string; activeEventId?: string;
  communityPortal?: boolean;
}
export interface CommunityTip { id: string; category: string; text: string; usageKey?: string; }
export const TIP_ACTIVITY_RULES: Record<ChatProfile, { spacingMs: number; messages: number; hourly: number }> = {
  calm: { spacingMs: 45 * 60_000, messages: 8, hourly: 1 },
  normal: { spacingMs: 30 * 60_000, messages: 6, hourly: 2 },
  lively: { spacingMs: 20 * 60_000, messages: 5, hourly: 3 },
};

export const HALLOWEEN_TIP_INTERVALS: Record<HalloweenTipFrequency, number> = { normal: 45 * 60_000, frequent: 30 * 60_000 };
export const HALLOWEEN_TIP_MINIMUM_GAP_MS = 20 * 60_000;
export const HALLOWEEN_TIP_HOURLY_LIMIT = 2;
export const HALLOWEEN_TIP_MESSAGES = [
  '🎃 Süßes oder Saures? Trau dich! Mit !trickortreat kannst du beim Halloween-Event mitmachen. 👻',
  '👻 Schon deine Halloween-Runde gespielt? Mit !trickortreat warten Süßigkeiten, Streiche und vielleicht eine Überraschung auf dich! 🎃',
  '🍬 Wer hat heute Halloween-Glück? Probier !trickortreat aus und entdecke, was hinter der nächsten Tür wartet!',
  '🎃 Sammelst du schon Kürbisse? Schau mit !pumpkins nach, wie viele du hast!',
  '🦇 Die Halloween-Saison läuft! Mit !trickortreat kannst du mitspielen und mit !pumpkins deinen Kürbisstand prüfen.',
] as const;

const TIPS: CommunityTip[] = [
  { id: 'eightball', category: 'oracle', text: 'Du hast eine Frage? Stell sie dem Orakel mit !8ball FRAGE.' },
  { id: 'rps', category: 'rps', text: 'Lust auf eine schnelle Runde? Fordere das Bot-Orakel mit !rps stein heraus.' },
  { id: 'duel', category: 'duel', text: 'Fordere jemanden aus dem Chat heraus: !duel @Name.' },
  { id: 'guess', category: 'guess', text: 'Lust auf Zahlenraten? Wenn Jannik eine Runde startet, kannst du mit !guess ZAHL mitraten.' },
  { id: 'pet', category: 'pet', text: 'Lerne Elio kennen: Mit !pet kannst du den Zustand der Community-Katze ansehen.' },
  { id: 'pet-care', category: 'pet', usageKey: 'pet', text: 'Elio freut sich über Besuch: Mit !feed und !play kannst du dich um die Community-Katze kümmern.' },
  { id: 'detective-guess', category: 'detective', text: 'Bei einer laufenden Chat-Detektiv-Runde kannst du mit !wer @Name den Absender eines freigegebenen Zitats erraten.', usageKey: 'detective' },
  { id: 'quote', category: 'detective', usageKey: 'detective', text: 'Reiche freiwillig ein Zitat ein: erst !quoteoptin, dann !savequote TEXT.' },
  { id: 'quest', category: 'quest', text: 'Hast du eine Spielidee für alle? Schlage sie mit !quest IDEE vor. Nach Moderationsfreigabe kann sie zur Abstimmung stehen.' },
  { id: 'quest-vote', category: 'quest', usageKey: 'quest', text: 'Aus einer freigegebenen Quest-Idee kann eine Community-Abstimmung werden. Jannik oder ein Mod startet die ausgewählte Quest.' },
  { id: 'xp', category: 'xp', text: 'Mit !level siehst du deinen Community-Fortschritt und deine XP.' },
  { id: 'drop', category: 'drop', text: 'Wenn Jannik einen Mystery Drop startet, mach während des Countdowns mit !claim mit.' },
  { id: 'imposter', category: 'imposter', text: 'Wenn die Imposter-Anmeldung offen ist, kannst du mit !joinimposter mitspielen.' },
  { id: 'wheel', category: 'wheel', text: 'Beim Chaos Wheel startet Jannik eine Community-Aktion. Mit !wheel kannst du den Rad-Status ansehen.' },
  { id: 'vault', category: 'vault', text: 'Wenn der Community-Tresor offen ist, knackt ihr gemeinsam den dreistelligen Code: !code 427.' },
  { id: 'community-portal', category: 'communityPortal', text: 'Kennst du schon unser Community-Portal? Schau deine XP an, besuche Elio 🐱 und entdecke die Community-Spiele: https://twitch.gater-app.de/community' },
];
const FEATURE_COMMANDS: Record<string, string> = {
  '8ball': 'eightball', rps: 'rps', duel: 'duel', accept: 'duel',
  pet: 'pet', feed: 'pet', play: 'pet', petcare: 'pet', savequote: 'detective', quoteoptin: 'detective', quest: 'quest',
  wer: 'detective', joinimposter: 'imposter', leaveimposter: 'imposter', sus: 'imposter', guess: 'guess',
  claim: 'drop', wheel: 'wheel', wheelstatus: 'wheel', code: 'vault',
  trickortreat: 'season-trickortreat', pumpkins: 'season-trickortreat', gift: 'season-gift', egghunt: 'season-egghunt', eventscore: 'season-eventscore',
  level: 'xp', xptop: 'xp', rank: 'xp',
  help: 'community-portal', community: 'community-portal',
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
    const raw = this.store.config<unknown>('community_tip_settings', { enabled: false, portalEnabled: false });
    const value=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
    const enabledCategories:Partial<Record<CommunityTipCategoryId,boolean>>={};
    if(value.enabledCategories&&typeof value.enabledCategories==='object')for(const {id} of COMMUNITY_TIP_CATEGORIES){
      const stored=(value.enabledCategories as Record<string,unknown>)[id];if(typeof stored==='boolean')enabledCategories[id]=stored;
    }
    return { enabled: value.enabled===true, portalEnabled:value.portalEnabled===true,
      halloweenEnabled:value.halloweenEnabled!==false, halloweenFrequency:value.halloweenFrequency==='normal'?'normal':'frequent',
      ...(Object.keys(enabledCategories).length?{enabledCategories}:{}) };
  }
  configure(enabled: boolean): CommunityTipSettings {
    this.store.setConfig('community_tip_settings', { ...this.settings(), enabled });
    return this.settings();
  }
  configurePortal(enabled:boolean):CommunityTipSettings { this.store.setConfig('community_tip_settings',{...this.settings(),portalEnabled:enabled});return this.settings(); }
  configureHalloween(enabled:boolean,frequency:HalloweenTipFrequency=this.settings().halloweenFrequency):CommunityTipSettings {
    if(typeof enabled!=='boolean'||(frequency!=='normal'&&frequency!=='frequent'))throw new Error('Halloween-Einstellung ungültig.');
    this.store.setConfig('community_tip_settings',{...this.settings(),halloweenEnabled:enabled,halloweenFrequency:frequency});return this.settings();
  }
  configureCategories(value:unknown):CommunityTipSettings {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Die Hinweis-Kategorien sind ungültig.');
    const input=value as Record<string,unknown>,next:Partial<Record<CommunityTipCategoryId,boolean>>={};
    if(Object.keys(input).some(key=>!COMMUNITY_TIP_CATEGORIES.some(category=>category.id===key))
      ||Object.values(input).some(enabled=>typeof enabled!=='boolean'))throw new Error('Die Hinweis-Kategorien sind ungültig.');
    for(const {id} of COMMUNITY_TIP_CATEGORIES)if(typeof input[id]==='boolean')next[id]=input[id] as boolean;
    const current=this.settings();
    this.store.setConfig('community_tip_settings',{...current,enabledCategories:next,
      ...(typeof next.communityPortal==='boolean'?{portalEnabled:next.communityPortal}:{}),
      ...(typeof next.halloween==='boolean'?{halloweenEnabled:next.halloween}:{})});
    return this.settings();
  }
  markDelivered(tip:CommunityTip,now=Date.now()):void {
    const state=this.state();this.store.setConfig('community_tip_state',{...state,lastDeliveredAt:now,lastDeliveredText:tip.text,lastDeliveredCategory:tip.category});
  }
  state() {
    const raw = this.store.config<unknown>('community_tip_state', { lastSentAt: 0, streamId: null, sentInStream: [], sentHistory: [] });
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      lastSentAt: Number.isFinite(value.lastSentAt) ? Math.max(0, Number(value.lastSentAt)) : 0,
      streamId: typeof value.streamId === 'string' ? value.streamId : null,
      sentInStream: Array.isArray(value.sentInStream) ? value.sentInStream.filter((id): id is string => typeof id === 'string') : [],
      sentHistory: Array.isArray(value.sentHistory) ? value.sentHistory.filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0).slice(-24) : [],
      ...(typeof value.lastCategory === 'string' ? { lastCategory: value.lastCategory } : {}),
      ...(typeof value.lastTipId === 'string' ? { lastTipId: value.lastTipId } : {}),
      ...(typeof value.lastDeliveredAt === 'number'&&Number.isFinite(value.lastDeliveredAt)&&value.lastDeliveredAt>0?{lastDeliveredAt:value.lastDeliveredAt}:{}),
      ...(typeof value.lastDeliveredText === 'string'?{lastDeliveredText:value.lastDeliveredText}:{}),
      ...(typeof value.lastDeliveredCategory === 'string'?{lastDeliveredCategory:value.lastDeliveredCategory}:{}),
    };
  }
  observe(message: ChatMessage, now = Date.now()): void {
    if (this.recentEventIds.has(message.eventId)) return;
    this.recentEventIds.add(message.eventId);
    if (this.recentEventIds.size > 2000) this.recentEventIds.delete(this.recentEventIds.values().next().value!);
    const command = message.message.trim().match(/^!([a-z0-9_-]+)/iu)?.[1]?.toLowerCase();
    if(command==='help'||command==='community'){
      this.featureUsedAt.set('community-portal',now);
      this.store.setConfig('community_tip_recent_usage',Object.fromEntries(this.featureUsedAt));
      return;
    }
    if (message.isModerator) return;
    if (command) {
      const topic = FEATURE_COMMANDS[command];
      if (topic && (this.settings().enabled||topic==='community-portal')) {
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
  categoryCatalog(availability:TipAvailability) {
    return COMMUNITY_TIP_CATEGORIES.map(category=>{
      const enabled=this.categoryEnabled(category.id),tips=this.available(availability,true).filter(tip=>tip.category===category.id);
      const available=category.id==='halloween'?this.halloweenAvailable(availability):tips.length>0;
      const reason=!enabled?'Hinweise ausgeschaltet':available?'Funktion verfügbar':category.id==='communityPortal'?'Portal ist deaktiviert oder derzeit nicht erreichbar':category.id==='season'?'Kein passendes Saison-Event aktiv':'Funktion derzeit deaktiviert';
      const examples=TIPS.filter(tip=>tip.category===category.id).map(tip=>tip.text);
      if(category.id==='halloween')examples.push(...HALLOWEEN_TIP_MESSAGES);
      if(category.id==='season'&&!examples.length)examples.push('Beim aktiven Saison-Event kannst du mit dem angezeigten Mitmach-Befehl Punkte sammeln.');
      return {...category,enabled,available,reason,previews:examples,availablePreviews:tips.map(tip=>tip.text)};
    });
  }
  get eligibleActivityMessages():number { return this.activityCount; }
  consumeActivity():void { this.activityCount=0; }
  alignStream(streamId:string|null):void {
    if(this.activeStreamId!==streamId){this.activeStreamId=streamId;this.activityCount=0;}
  }
  status(profile: ChatProfile, now = Date.now(), availability:TipAvailability = {}) {
    const state = this.state(), rules = TIP_ACTIVITY_RULES[profile];
    const recent = this.sentAt.filter(at => now - at < 60 * 60_000).length;
    const halloween=this.halloweenState(),active=this.halloweenAvailable(availability);
    const halloweenInterval=Math.max(HALLOWEEN_TIP_MINIMUM_GAP_MS,HALLOWEEN_TIP_INTERVALS[this.settings().halloweenFrequency]);
    return { ...this.settings(), profile, lastTipAt: state.lastSentAt || null, lastDeliveredAt:state.lastDeliveredAt||null,
      lastDeliveredText:state.lastDeliveredText||null,lastDeliveredCategory:state.lastDeliveredCategory||null,
      nextEarliestAt: state.lastSentAt ? state.lastSentAt + rules.spacingMs : null,
      activityMessages: this.activityCount, requiredMessages: rules.messages, hourlyLimit: rules.hourly, sentThisHour: recent,
      halloweenActive:active,halloweenLastSentAt:halloween.lastSentAt||null,
      halloweenNextEarliestAt:active?Math.max(halloween.lastSentAt?halloween.lastSentAt+halloweenInterval:now,state.lastSentAt?state.lastSentAt+rules.spacingMs:now):null,
      halloweenSentThisHour:halloween.history.filter(at=>now-at<60*60_000).length,halloweenMinimumGapMs:HALLOWEEN_TIP_MINIMUM_GAP_MS,
      halloweenHourlyLimit:HALLOWEEN_TIP_HOURLY_LIMIT,halloweenPreviews:HALLOWEEN_TIP_MESSAGES };
  }

  shouldEvaluate(profile: ChatProfile, availability: TipAvailability, busy: boolean, now = Date.now()): boolean {
    if (!this.settings().enabled || busy || this.activityCount < TIP_ACTIVITY_RULES[profile].messages) return false;
    const state = this.state(), rules = TIP_ACTIVITY_RULES[profile];
    if (state.lastSentAt && now - state.lastSentAt < rules.spacingMs) return false;
    if (this.sentAt.filter(at => now - at < 60 * 60_000).length >= rules.hourly) return false;
    const usedInStream = this.activeStreamId === undefined || state.streamId === this.activeStreamId ? state.sentInStream : [];
    if(this.halloweenDue(profile,availability,now))return true;
    return this.candidates(availability, usedInStream, now).length > 0;
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
    const candidates = this.candidates(input.availability, sentInStream, now);
    const halloweenDue=this.halloweenDue(input.profile,input.availability,now),random=input.random??secureRandom;
    if (!candidates.length&&!halloweenDue) return undefined;
    const chooseHalloween=halloweenDue&&(!candidates.length||random(3)<2);
    const selected:CommunityTip|undefined=chooseHalloween?{id:'halloween-reminder',category:'halloween',text:this.nextHalloweenMessage()}:candidates[random(candidates.length)];
    if (!selected) return undefined;
    if (this.featureUsedAt.has(selected.id) && now - this.featureUsedAt.get(selected.id)! < 15 * 60_000) return undefined;
    if (input.allowSend && !input.allowSend(selected)) return undefined;
    this.store.setConfig('community_tip_state', { ...state,lastSentAt: now, streamId: input.streamId,
      sentInStream: selected.id==='halloween-reminder'?sentInStream:[...sentInStream, selected.id], sentHistory: [...this.sentAt.filter(at => now - at < 60 * 60_000), now].slice(-24), lastCategory: selected.category,lastTipId:selected.id });
    this.sentAt.push(now);
    if(selected.id==='halloween-reminder')this.recordHalloweenReminder(now);
    this.activityCount = 0;
    return { ...selected, streamId: input.streamId };
  }

  private available(a: TipAvailability,ignoreCategorySettings=false): CommunityTip[] {
    return TIPS.filter(tip => {
      if(!ignoreCategorySettings&&!this.categoryEnabled(tip.category as CommunityTipCategoryId))return false;
      if (tip.id === 'community-portal') return this.settings().enabled&&this.settings().portalEnabled&&a.communityPortal===true;
      if (tip.id === 'eightball') return a.eightBall === true;
      if (tip.id === 'rps') return a.rps === true;
      if (tip.id === 'guess') return a.guess === true;
      if (tip.id === 'duel') return a.duels === true;
      if (tip.id === 'pet') return a.pet === true;
      if (tip.id === 'pet-care') return a.pet === true && a.petCare === true;
      if (tip.id === 'quote' || tip.id === 'detective-guess') return a.detective === true;
      if (tip.id === 'quest' || tip.id === 'quest-vote') return a.quests === true;
      if (tip.id === 'xp') return a.xp === true;
      if (tip.id === 'drop') return a.drops === true;
      if (tip.id === 'imposter') return a.imposter === true;
      if (tip.id === 'wheel') return a.wheel === true;
      if (tip.id === 'vault') return a.vault === true;
      return false;
    }).concat(this.categoryEnabled('season')&&a.events && a.activeEventCommand && a.activeEventId!=='halloween' ? [{
      id: `season-${a.activeEventCommand}`, category: a.activeEventCommand === 'trickortreat' ? 'halloween' : 'season',
      text: `Beim ${a.activeEventName || 'Saison-Event'} kannst du mit !${a.activeEventCommand} mitmachen und Punkte sammeln.`,
    }] : []);
  }

  private candidates(availability: TipAvailability, sentInStream: string[], now: number): CommunityTip[] {
    const state=this.state();
    const candidates=this.available(availability).filter(tip=>!sentInStream.includes(tip.id)
      &&(!this.featureUsedAt.has(tip.usageKey||tip.id)||now-this.featureUsedAt.get(tip.usageKey||tip.id)!>15*60_000));
    const rotated=candidates.filter(tip=>tip.category!==state.lastCategory);
    return rotated.length?rotated:candidates;
  }

  private categoryEnabled(category:CommunityTipCategoryId):boolean {
    const settings=this.settings();
    if(category==='communityPortal'&&!settings.portalEnabled)return false;
    if(category==='halloween'&&!settings.halloweenEnabled)return false;
    return settings.enabledCategories?.[category]!==false;
  }

  private halloweenAvailable(a:TipAvailability):boolean {
    const s=this.settings();return s.enabled&&s.halloweenEnabled&&this.categoryEnabled('halloween')&&a.events===true&&a.activeEventId==='halloween'&&a.activeEventCommand==='trickortreat';
  }
  private halloweenState():{lastSentAt:number;history:number[];nextVariant:number} {
    const raw=this.store.config<unknown>('community_halloween_tip_state',{lastSentAt:0,history:[],nextVariant:0}),v=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
    return {lastSentAt:typeof v.lastSentAt==='number'&&Number.isFinite(v.lastSentAt)?Math.max(0,v.lastSentAt):0,
      history:Array.isArray(v.history)?v.history.filter((at):at is number=>typeof at==='number'&&Number.isFinite(at)&&at>0).slice(-24):[],
      nextVariant:typeof v.nextVariant==='number'&&Number.isInteger(v.nextVariant)?Math.max(0,v.nextVariant)%HALLOWEEN_TIP_MESSAGES.length:0};
  }
  private halloweenDue(profile:ChatProfile,a:TipAvailability,now:number):boolean {
    if(!this.halloweenAvailable(a))return false;
    const h=this.halloweenState(),interval=Math.max(HALLOWEEN_TIP_MINIMUM_GAP_MS,HALLOWEEN_TIP_INTERVALS[this.settings().halloweenFrequency]),lastTip=this.state().lastSentAt;
    const commandUsed=this.featureUsedAt.get('season-trickortreat');
    return h.history.filter(at=>now-at<60*60_000).length<HALLOWEEN_TIP_HOURLY_LIMIT
      &&now>=h.lastSentAt+interval&&(!lastTip||now-lastTip>=TIP_ACTIVITY_RULES[profile].spacingMs)
      &&(!commandUsed||now-commandUsed>=15*60_000);
  }
  private nextHalloweenMessage():string { return HALLOWEEN_TIP_MESSAGES[this.halloweenState().nextVariant]||HALLOWEEN_TIP_MESSAGES[0]; }
  private recordHalloweenReminder(now:number):void {
    const h=this.halloweenState();this.store.setConfig('community_halloween_tip_state',{lastSentAt:now,
      history:[...h.history.filter(at=>now-at<60*60_000),now].slice(-24),nextVariant:(h.nextVariant+1)%HALLOWEEN_TIP_MESSAGES.length});
  }
}

function secureRandom(max: number): number { return Math.floor(Math.random() * max); }
