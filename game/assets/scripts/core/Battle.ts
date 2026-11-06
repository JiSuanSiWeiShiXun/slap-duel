/** Pure deterministic combat. Time is simulation milliseconds; no engine or wall clock. */
export type ActorId = 0 | 1;
export type AttackMode = 'charge' | 'tap';
export type ActionKind = 'charge-start' | 'charge-release' | 'charge-cancel' | 'attack' | 'guard';
export interface BattleCommand {
  sessionId: string; actorId: ActorId; sequence: number; atMs: number; action: ActionKind;
}
export interface FighterState {
  hp: number;
  mode: AttackMode;
  phase: 'idle' | 'charging' | 'windup' | 'recovery' | 'guard' | 'stunned';
  phaseStartMs: number; phaseEndMs: number;
  guardCharges: number; guardReadyAtMs: number; guardRestoreAtMs: number | null;
  chargeStartMs: number | null; contactAtMs: number | null;
}
export interface BattleState {
  sessionId: string; nowMs: number; fighters: [FighterState, FighterState];
  result: null | 'player' | 'bot' | 'draw';
}
export interface BattleEvent {
  id: string; sessionId: string; atMs: number;
  kind: 'attack-start' | 'hit' | 'block' | 'parry' | 'rejected' | 'ended';
  actorId?: ActorId; targetId?: ActorId; damage?: number; reason?: string;
}
export interface Rules {
  version: string; maxHp: number; baseDamage: number; chargedDamage: number;
  windupMs: number; recoveryMs: number; stunMs: number; fullChargeMs: number;
  guardDurationMs: number; parryWindowMs: number; maxGuardCharges: number;
  guardCooldownMs: number; guardRestoreMs: number; roundDurationMs: number;
}
export const DEFAULT_RULES: Readonly<Rules> = Object.freeze({
  version: 'prototype-0.1', maxHp: 5, baseDamage: 1, chargedDamage: 2,
  windupMs: 480, recoveryMs: 600, stunMs: 350, fullChargeMs: 1200,
  guardDurationMs: 300, parryWindowMs: 80, maxGuardCharges: 2,
  guardCooldownMs: 650, guardRestoreMs: 1800, roundDurationMs: 60000,
});
const ACTIONS: readonly string[] = ['charge-start', 'charge-release', 'charge-cancel', 'attack', 'guard'];
const ACTORS: readonly ActorId[] = [0, 1];
const MAX_COMMANDS = 8192;

export class Battle {
  readonly rules: Readonly<Rules>;
  private state: BattleState;
  private queue: BattleCommand[] = [];
  private seen = new Set<string>();
  private events: BattleEvent[] = [];
  private eventSequence = 0;
  private damage: [number, number] = [1, 1];
  private capacityReported = false;

  constructor(sessionId: string, mode: AttackMode, rules: Readonly<Rules> = DEFAULT_RULES, opponentMode: AttackMode = mode) {
    if (!sessionId || !['tap', 'charge'].includes(mode) || !['tap', 'charge'].includes(opponentMode)) throw new Error('Invalid battle identity or mode');
    if (!rules || typeof rules.version !== 'string' || !rules.version) throw new Error('Invalid rule: version');
    for (const key of Object.keys(DEFAULT_RULES) as (keyof Rules)[]) {
      const value = rules[key];
      if (key !== 'version' && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new Error(`Invalid rule: ${key}`);
    }
    if (rules.parryWindowMs > rules.guardDurationMs) throw new Error('Parry window exceeds guard duration');
    this.rules = Object.freeze({ ...rules });
    const fighter = (): FighterState => ({
      hp: rules.maxHp, mode, phase: 'idle', phaseStartMs: 0, phaseEndMs: 0,
      guardCharges: rules.maxGuardCharges, guardReadyAtMs: 0, guardRestoreAtMs: null,
      chargeStartMs: null, contactAtMs: null,
    });
    this.state = { sessionId, nowMs: 0, fighters: [fighter(), fighter()], result: null };
    this.state.fighters[1].mode = opponentMode;
  }

  submit(command: BattleCommand): void {
    if (!command || command.sessionId !== this.state.sessionId) return;
    if (this.seen.size >= MAX_COMMANDS) {
      if (!this.capacityReported) { this.emit('rejected', { reason: 'command-capacity' }); this.capacityReported = true; }
      return;
    }
    if ((command.actorId !== 0 && command.actorId !== 1) ||
      !Number.isSafeInteger(command.sequence) || command.sequence < 0 ||
      !Number.isSafeInteger(command.atMs) || command.atMs < 0 || !ACTIONS.includes(command.action)) {
      // Invalid messages have no rule effects and cannot flood the event stream.
      return;
    }
    const key = `${command.actorId}:${command.sequence}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (command.atMs < this.state.nowMs || command.atMs > this.rules.roundDurationMs || this.state.result) {
      this.emit('rejected', { actorId: command.actorId, reason: this.state.result ? 'ended' : 'invalid-time' });
      return;
    }
    this.queue.push({ ...command });
    this.queue.sort((a, b) => a.atMs - b.atMs || a.actorId - b.actorId || a.sequence - b.sequence);
  }

  advanceTo(atMs: number): void {
    if (!Number.isSafeInteger(atMs) || atMs < this.state.nowMs) throw new RangeError('Simulation time must be a monotonic integer');
    if (this.state.result) return;
    const target = Math.min(atMs, this.rules.roundDurationMs);
    this.resolveTimestamp();
    while (this.state.nowMs < target && !this.state.result) {
      let next = target;
      if (this.queue.length) next = Math.min(next, this.queue[0].atMs);
      for (const fighter of this.state.fighters) {
        if (fighter.contactAtMs !== null) next = Math.min(next, fighter.contactAtMs);
        if (fighter.guardRestoreAtMs !== null) next = Math.min(next, fighter.guardRestoreAtMs);
        if (fighter.phase !== 'idle' && fighter.phase !== 'charging' && fighter.phase !== 'windup') next = Math.min(next, fighter.phaseEndMs);
      }
      if (next <= this.state.nowMs) throw new Error('Combat schedule failed to advance');
      this.state.nowMs = next;
      this.resolveTimestamp();
    }
  }

  snapshot(): BattleState {
    return { ...this.state, fighters: [{ ...this.state.fighters[0] }, { ...this.state.fighters[1] }] };
  }

  drainEvents(): BattleEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Lifecycle cleanup cannot be denied by the player-input budget. Other actions stay frozen. */
  cancelPending(): void {
    this.queue = [];
    for (const actorId of ACTORS) {
      // Reuse the legal cancel transition; this trusted lifecycle action never deals damage.
      this.apply({ sessionId: this.state.sessionId, actorId, sequence: 0, atMs: this.state.nowMs, action: 'charge-cancel' });
    }
  }

  private resolveTimestamp(): void {
    const now = this.state.nowMs;
    for (const fighter of this.state.fighters) {
      if (fighter.guardRestoreAtMs !== null && fighter.guardRestoreAtMs <= now) {
        fighter.guardCharges = Math.min(this.rules.maxGuardCharges, fighter.guardCharges + 1);
        fighter.guardRestoreAtMs = fighter.guardCharges === this.rules.maxGuardCharges ? null : now + this.rules.guardRestoreMs;
      }
      if (fighter.phase !== 'idle' && fighter.phase !== 'charging' && fighter.phase !== 'windup' && fighter.phaseEndMs <= now) this.setPhase(fighter, 'idle', now);
    }
    while (this.queue.length && this.queue[0].atMs === now) this.apply(this.queue.shift()!);
    const contacts = ACTORS.filter(actor => this.state.fighters[actor].contactAtMs === now);
    if (contacts.length) this.resolveContacts(contacts);
    if (!this.state.result && now === this.rules.roundDurationMs) this.finish();
  }

  private apply(command: BattleCommand): void {
    const fighter = this.state.fighters[command.actorId];
    const now = this.state.nowMs;
    const reject = (reason: string): void => this.emit('rejected', { actorId: command.actorId, reason });
    if (command.action === 'charge-cancel') {
      if (fighter.phase === 'charging') { fighter.chargeStartMs = null; this.setPhase(fighter, 'idle', now); }
      return;
    }
    if (command.action === 'charge-release') {
      if (fighter.phase !== 'charging') return reject('not-charging');
      const charged = now - fighter.chargeStartMs! >= this.rules.fullChargeMs;
      this.startAttack(command.actorId, charged ? this.rules.chargedDamage : this.rules.baseDamage);
      return;
    }
    if (fighter.phase !== 'idle') return reject(fighter.phase);
    if (command.action === 'guard') {
      if (fighter.guardCharges === 0) return reject('guard-empty');
      if (now < fighter.guardReadyAtMs) return reject('guard-cooldown');
      fighter.guardCharges--;
      fighter.guardReadyAtMs = now + this.rules.guardCooldownMs;
      if (fighter.guardRestoreAtMs === null) fighter.guardRestoreAtMs = now + this.rules.guardRestoreMs;
      this.setPhase(fighter, 'guard', now + this.rules.guardDurationMs);
    } else if (command.action === 'charge-start') {
      if (fighter.mode !== 'charge') return reject('wrong-mode');
      fighter.chargeStartMs = now;
      this.setPhase(fighter, 'charging', now + this.rules.fullChargeMs);
    } else if (command.action === 'attack') {
      if (fighter.mode !== 'tap') return reject('wrong-mode');
      this.startAttack(command.actorId, this.rules.baseDamage);
    }
  }

  private startAttack(actor: ActorId, damage: number): void {
    const fighter = this.state.fighters[actor];
    fighter.chargeStartMs = null;
    fighter.contactAtMs = this.state.nowMs + this.rules.windupMs;
    this.damage[actor] = damage;
    this.setPhase(fighter, 'windup', fighter.contactAtMs);
    this.emit('attack-start', { actorId: actor, targetId: (1 - actor) as ActorId, damage });
  }

  private resolveContacts(contacts: ActorId[]): void {
    // Read both defenses from one pre-contact snapshot; no side gets first-hit priority.
    const before = this.snapshot();
    const losses: [number, number] = [0, 0];
    for (const actor of contacts) {
      const target = (1 - actor) as ActorId;
      const defender = before.fighters[target];
      if (defender.phase === 'guard') {
        if (this.state.nowMs - defender.phaseStartMs < this.rules.parryWindowMs) {
          losses[actor] += this.rules.baseDamage;
          this.emit('parry', { actorId: target, targetId: actor, damage: this.rules.baseDamage });
        } else this.emit('block', { actorId: target, targetId: actor, damage: 0 });
      } else {
        losses[target] += this.damage[actor];
        this.emit('hit', { actorId: actor, targetId: target, damage: this.damage[actor] });
      }
    }
    for (const actor of contacts) {
      const fighter = this.state.fighters[actor];
      fighter.contactAtMs = null;
      this.setPhase(fighter, 'recovery', this.state.nowMs + this.rules.recoveryMs);
    }
    for (const actor of ACTORS) {
      if (!losses[actor]) continue;
      const fighter = this.state.fighters[actor];
      fighter.hp = Math.max(0, fighter.hp - losses[actor]);
      fighter.contactAtMs = null;
      fighter.chargeStartMs = null;
      this.setPhase(fighter, 'stunned', this.state.nowMs + this.rules.stunMs);
    }
    if (this.state.fighters.some(f => f.hp === 0)) this.finish();
  }

  private setPhase(fighter: FighterState, phase: FighterState['phase'], end: number): void {
    fighter.phase = phase; fighter.phaseStartMs = this.state.nowMs; fighter.phaseEndMs = end;
  }

  private finish(): void {
    if (this.state.result) return;
    const [player, bot] = this.state.fighters;
    this.state.result = player.hp === bot.hp ? 'draw' : player.hp > bot.hp ? 'player' : 'bot';
    this.queue = [];
    this.emit('ended', { reason: this.state.result });
  }

  private emit(kind: BattleEvent['kind'], fields: Omit<Partial<BattleEvent>, 'id' | 'sessionId' | 'atMs' | 'kind'> = {}): void {
    // Bounded by the per-round command cap plus the finite legal attack/round budget.
    this.events.push({ id: `${this.state.sessionId}:${++this.eventSequence}`, sessionId: this.state.sessionId, atMs: this.state.nowMs, kind, ...fields });
  }
}
