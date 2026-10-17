import type { AppConfig, GameOutcome, HalloweenEvent, Player } from './types.js';
import { Database } from './database.js';
import { randomInt as cryptoRandomInt } from 'node:crypto';

const EVENT_KEYS: HalloweenEvent[] = [
  'TREAT', 'TRICK', 'JACKPOT', 'GHOST', 'WITCH', 'EMPTY_HOUSE', 'GOLDEN_PUMPKIN',
];

export function chooseEvent(weights: AppConfig['eventWeights'], random: () => number): HalloweenEvent {
  const total = EVENT_KEYS.reduce((sum, event) => sum + weights[event], 0);
  validateWeights(weights,total);
  const sample = random();
  if (!Number.isFinite(sample)) throw new Error('Zufallsquelle lieferte keinen gültigen Wert.');
  const roll = Math.floor(Math.min(1 - Number.EPSILON, Math.max(0, sample)) * total);
  return chooseEventFromRoll(weights,roll);
}

export function chooseEventFromRoll(weights:AppConfig['eventWeights'],roll:number):HalloweenEvent {
  const total=EVENT_KEYS.reduce((sum,event)=>sum+weights[event],0);validateWeights(weights,total);
  if(!Number.isSafeInteger(roll)||roll<0||roll>=total)throw new Error('Zufallswert liegt außerhalb der Ereignisgewichte.');
  let cursor = 0;
  for (const event of EVENT_KEYS) {
    cursor += weights[event];
    if (roll < cursor) return event;
  }
  throw new Error('Ereignisgewicht konnte nicht zugeordnet werden.');
}

export function chooseEventSecure(weights:AppConfig['eventWeights']):HalloweenEvent {
  const total=EVENT_KEYS.reduce((sum,event)=>sum+weights[event],0);validateWeights(weights,total);
  return chooseEventFromRoll(weights,cryptoRandomInt(total));
}

function validateWeights(weights:AppConfig['eventWeights'],total:number):void {
  if (!Number.isSafeInteger(total) || total <= 0 || total>=2**48 || EVENT_KEYS.some(event => !Number.isSafeInteger(weights[event]) || weights[event] < 0)) throw new Error('Ereignisgewichte müssen nichtnegative ganze Zahlen mit positiver Summe im unterstützten Zufallsbereich sein.');
}

function randomInt(min: number, max: number, random: () => number): number {
  return min + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (max - min + 1));
}

export function resolveOutcome(event: HalloweenEvent, config: AppConfig, random: () => number): Pick<GameOutcome, 'event' | 'delta'> {
  return resolveOutcomeUsing(event,config,(min,max)=>randomInt(min,max,random));
}

function resolveOutcomeSecure(event:HalloweenEvent,config:AppConfig):Pick<GameOutcome,'event'|'delta'> {
  return resolveOutcomeUsing(event,config,(min,max)=>cryptoRandomInt(min,max+1));
}

function resolveOutcomeUsing(event:HalloweenEvent,config:AppConfig,pick:(min:number,max:number)=>number):Pick<GameOutcome,'event'|'delta'> {
  switch (event) {
    case 'TREAT': return { event, delta: pick(config.gameValues.treat.min, config.gameValues.treat.max) };
    case 'TRICK': return { event, delta: -pick(config.gameValues.trick.min, config.gameValues.trick.max) };
    case 'JACKPOT': return { event, delta: pick(config.gameValues.jackpot.min, config.gameValues.jackpot.max) };
    case 'GHOST': return { event, delta: -pick(config.gameValues.ghost.min, config.gameValues.ghost.max) };
    case 'WITCH': return { event, delta: pick(config.gameValues.witch.min, config.gameValues.witch.max) };
    case 'EMPTY_HOUSE': return { event, delta: 0 };
    case 'GOLDEN_PUMPKIN': return { event, delta: pick(config.gameValues.goldenPumpkin.min, config.gameValues.goldenPumpkin.max) };
  }
}

export class GameService {
  private readonly random:(()=>number)|undefined;
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    random?: () => number,
  ) { this.random=random; }

  get active(): boolean { return this.database.isActive; }

  start(now = Date.now()): boolean {
    if (this.active) return false;
    this.database.setActive(true, now);
    return true;
  }

  end(now = Date.now()): { ended: boolean; winner?: Player } {
    if (!this.active) return { ended: false };
    const winner = this.database.topPlayers(1)[0];
    this.database.setActive(false, now);
    return winner ? { ended: true, winner } : { ended: true };
  }

  play(userId: string, displayName: string, now = Date.now(),
    delivery?: { eventId: string; replyParentMessageId?: string; category?: 'season' | 'halloween'; format: (outcome: GameOutcome) => string }):
    { ok: true; outcome: GameOutcome; deliveryId?: string } | { ok: false; reason: 'inactive' | 'cooldown'; remainingMs?: number } {
    if (!this.active) return { ok: false, reason: 'inactive' };
    const event = this.random?chooseEvent(this.config.eventWeights,this.random):chooseEventSecure(this.config.eventWeights);
    const resolved = this.random?resolveOutcome(event,this.config,this.random):resolveOutcomeSecure(event,this.config);
    const applied = this.database.applyPlay(userId, displayName, resolved.delta, now, this.config.cooldownMs,
      delivery ? { eventId: delivery.eventId, ...(delivery.replyParentMessageId ? { replyParentMessageId: delivery.replyParentMessageId } : {}), ...(delivery.category ? { category: delivery.category } : {}), format: player => delivery.format({ ...resolved, pumpkins: player.pumpkins }) } : undefined);
    if (!applied.accepted) return { ok: false, reason: 'cooldown', remainingMs: applied.remainingMs };
    return { ok: true, outcome: { ...resolved, pumpkins: applied.player.pumpkins }, ...(delivery ? { deliveryId: delivery.eventId } : {}) };
  }

  pumpkins(userId: string): number { return this.database.getPlayer(userId).pumpkins; }
  top(limit = 10): Player[] { return this.database.topPlayers(limit); }
}


export function formatCooldown(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes <= 1 ? 'weniger als 1 Minute' : `${minutes} Minuten`;
}
