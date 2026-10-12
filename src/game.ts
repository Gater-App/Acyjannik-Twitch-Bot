import type { AppConfig, GameOutcome, HalloweenEvent, Player } from './types.js';
import { Database } from './database.js';

const EVENT_KEYS: HalloweenEvent[] = [
  'TREAT', 'TRICK', 'JACKPOT', 'GHOST', 'WITCH', 'EMPTY_HOUSE', 'GOLDEN_PUMPKIN',
];

export function chooseEvent(weights: AppConfig['eventWeights'], random: () => number): HalloweenEvent {
  const total = EVENT_KEYS.reduce((sum, event) => sum + weights[event], 0);
  const roll = Math.min(0.999999999, Math.max(0, random())) * total;
  let cursor = 0;
  for (const event of EVENT_KEYS) {
    cursor += weights[event];
    if (roll < cursor) return event;
  }
  return 'EMPTY_HOUSE';
}

function randomInt(min: number, max: number, random: () => number): number {
  return min + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (max - min + 1));
}

export function resolveOutcome(event: HalloweenEvent, config: AppConfig, random: () => number): Pick<GameOutcome, 'event' | 'delta'> {
  switch (event) {
    case 'TREAT': return { event, delta: randomInt(config.gameValues.treat.min, config.gameValues.treat.max, random) };
    case 'TRICK': return { event, delta: -randomInt(config.gameValues.trick.min, config.gameValues.trick.max, random) };
    case 'JACKPOT': return { event, delta: randomInt(config.gameValues.jackpot.min, config.gameValues.jackpot.max, random) };
    case 'GHOST': return { event, delta: -randomInt(config.gameValues.ghost.min, config.gameValues.ghost.max, random) };
    case 'WITCH': return { event, delta: randomInt(config.gameValues.witch.min, config.gameValues.witch.max, random) };
    case 'EMPTY_HOUSE': return { event, delta: 0 };
    case 'GOLDEN_PUMPKIN': return { event, delta: randomInt(config.gameValues.goldenPumpkin.min, config.gameValues.goldenPumpkin.max, random) };
  }
}

export class GameService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly random: () => number = Math.random,
  ) {}

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

  play(userId: string, displayName: string, now = Date.now()):
    { ok: true; outcome: GameOutcome } | { ok: false; reason: 'inactive' | 'cooldown'; remainingMs?: number } {
    if (!this.active) return { ok: false, reason: 'inactive' };
    const event = chooseEvent(this.config.eventWeights, this.random);
    const resolved = resolveOutcome(event, this.config, this.random);
    const applied = this.database.applyPlay(userId, displayName, resolved.delta, now, this.config.cooldownMs);
    if (!applied.accepted) return { ok: false, reason: 'cooldown', remainingMs: applied.remainingMs };
    return { ok: true, outcome: { ...resolved, pumpkins: applied.player.pumpkins } };
  }

  pumpkins(userId: string): number { return this.database.getPlayer(userId).pumpkins; }
  top(limit = 10): Player[] { return this.database.topPlayers(limit); }
}

export function formatCooldown(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes <= 1 ? 'weniger als 1 Minute' : `${minutes} Minuten`;
}
