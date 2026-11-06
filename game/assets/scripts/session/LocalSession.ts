import { AttackMode, Battle, BattleCommand, BattleEvent, BattleState, DEFAULT_RULES } from '../core/Battle';
import { Bot, PracticeKind, PRACTICE_GOALS } from './Bot';

export interface SessionOptions { sessionId: string; mode: AttackMode; practice: PracticeKind; seed: number; }
export interface BattleSession {
  submit(command: BattleCommand): void;
  advanceTo(atMs: number): void;
  snapshot(): BattleState;
  drainEvents(): BattleEvent[];
}

export class LocalSession implements BattleSession {
  private battle!: Battle;
  private bot!: Bot;
  private options!: SessionOptions;
  private nextBotAtMs = 0;
  private isPaused = false;
  private usedSessionIds = new Set<string>();

  constructor(options: SessionOptions) { this.initialize(options); }
  get paused(): boolean { return this.isPaused; }
  get practice(): PracticeKind { return this.options.practice; }
  get practiceGoal(): string { return PRACTICE_GOALS[this.options.practice]; }

  submit(command: BattleCommand): void {
    if (this.isPaused) return;
    this.battle.submit(command);
  }

  advanceTo(atMs: number): void {
    if (!Number.isSafeInteger(atMs) || atMs < this.battle.snapshot().nowMs) throw new RangeError('Simulation time must be a monotonic integer');
    if (this.isPaused || this.battle.snapshot().result) return;
    const target = Math.min(atMs, DEFAULT_RULES.roundDurationMs);
    while (this.nextBotAtMs <= target && !this.battle.snapshot().result) {
      const tick = this.nextBotAtMs;
      const current = this.battle.snapshot().nowMs;
      // Observe only the past. Queue the bot command before resolving contacts at its timestamp.
      this.battle.advanceTo(Math.max(current, tick - 1));
      for (const command of this.bot.decide(tick, this.battle.snapshot())) this.submit(command);
      this.battle.advanceTo(tick);
      this.nextBotAtMs += Bot.STEP_MS;
    }
    this.battle.advanceTo(target);
  }

  snapshot(): BattleState { return this.battle.snapshot(); }
  drainEvents(): BattleEvent[] { return this.battle.drainEvents(); }

  pause(): void {
    if (this.isPaused) return;
    this.battle.cancelPending();
    this.isPaused = true;
  }

  resume(): void { this.isPaused = false; }
  restart(options: SessionOptions): void { this.initialize(options); }

  private initialize(options: SessionOptions): void {
    if (!options || this.usedSessionIds.has(options.sessionId)) throw new Error('Restart requires a fresh session identity');
    // Validate before replacing a live session. The bot always uses tap in both A/B comparisons.
    const battle = new Battle(options.sessionId, options.mode, DEFAULT_RULES, 'tap');
    const bot = new Bot(options.practice, options.seed);
    this.options = { ...options };
    this.battle = battle;
    this.bot = bot;
    this.usedSessionIds.add(options.sessionId);
    this.isPaused = false;
    this.nextBotAtMs = 0;
  }
}
