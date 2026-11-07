import { ActorId, BattleEvent, BattleState, DEFAULT_RULES } from './core/Battle';
import { ParryMotion, FighterPose, Point } from './ParryMotion';

export interface ArmSolution {
  elbow: Point; wrist: Point; reachable: boolean; requestedDistance: number; solvedDistance: number; error: number;
}
export function solveTwoBone(shoulder: Point, upperLength: number, foreLength: number, palm: Point, palmOffset: number): ArmSolution {
  return { elbow: [...shoulder], wrist: [...shoulder], reachable: false, requestedDistance: 0, solvedDistance: 0, error: 1 };
}

export interface CharacterSample {
  semanticClip: string;
  normalizedTime: number;
  lunge: number;
  pose: FighterPose;
}

/** Pure, read-only actor presentation boundary. */
export class CharacterTimeline {
  private motion = new ParryMotion();
  private sessionId: string | null = null;
  private seen = new Set<string>();
  private attacks = new Map<ActorId, { atMs: number; damage: number }>();
  reset(sessionId: string | null = null): void {
    this.sessionId = sessionId; this.seen.clear(); this.attacks.clear(); this.motion.reset(sessionId);
  }
  consume(state: Readonly<BattleState>, events: readonly BattleEvent[]): void {
    if (state.sessionId !== this.sessionId) this.reset(state.sessionId);
    const fresh: BattleEvent[] = [];
    for (const event of [...events].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))) {
      // A premature transport batch is retryable once its rule time arrives.
      if (event.sessionId !== this.sessionId || event.atMs > state.nowMs || this.seen.has(event.id)) continue;
      this.seen.add(event.id); fresh.push(event);
      if (event.kind === 'attack-start' && event.actorId !== undefined && event.atMs <= state.nowMs) {
        const current = this.attacks.get(event.actorId);
        if (!current || event.atMs > current.atMs) this.attacks.set(event.actorId, { atMs: event.atMs, damage: event.damage ?? DEFAULT_RULES.baseDamage });
      }
      if (event.kind === 'ended') this.attacks.clear();
    }
    for (const [actorId, attack] of this.attacks) {
      if (state.result || state.nowMs > attack.atMs + DEFAULT_RULES.windupMs + DEFAULT_RULES.recoveryMs) this.attacks.delete(actorId);
    }
    this.motion.consume(state, fresh);
  }
  sample(state: Readonly<BattleState>, nowMs = state.nowMs, resultElapsedMs = 0): [CharacterSample, CharacterSample] {
    if (!Number.isFinite(nowMs) || !Number.isFinite(resultElapsedMs)) throw new Error('Character time must be finite');
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    const poses = this.motion.sample(state, nowMs, [
      { root: [-.55, 0, 0], facing: 1, cheek: [.18, 1.9, .16] },
      { root: [.55, 0, 0], facing: -1, cheek: [-.18, 1.9, .16] },
    ]);
    return state.fighters.map((f, side) => {
      const age = Math.max(0, nowMs - f.phaseStartMs);
      let semanticClip = 'idle', normalizedTime = (Math.max(0, nowMs) % 2000) / 2000, lunge = 0;
      if (f.phase === 'charging') { semanticClip = 'charge'; normalizedTime = age / DEFAULT_RULES.fullChargeMs; }
      else if (f.phase === 'windup') {
        const attack = state.sessionId === this.sessionId ? this.attacks.get(side as ActorId) : undefined;
        semanticClip = attack?.atMs === f.phaseStartMs && attack.damage > DEFAULT_RULES.baseDamage ? 'attack-heavy' : 'attack-light';
        normalizedTime = age / DEFAULT_RULES.windupMs;
      } else if (f.phase === 'guard' || f.phase === 'parried') { semanticClip = 'guard'; normalizedTime = age / 60; }
      else if (f.phase === 'counter') { semanticClip = 'counter'; normalizedTime = age / DEFAULT_RULES.counterWindupMs; lunge = .34 * clamp(normalizedTime); }
      else if (f.phase === 'counter-recovery') { semanticClip = 'counter-recovery'; normalizedTime = age / DEFAULT_RULES.counterRecoveryMs; lunge = .34 * (1 - clamp(normalizedTime)); }
      else if (f.phase === 'recovery') { semanticClip = 'recovery'; normalizedTime = age / DEFAULT_RULES.recoveryMs; }
      else if (f.phase === 'stunned') { semanticClip = 'hit'; normalizedTime = age / DEFAULT_RULES.stunMs; }
      if (state.result !== null) {
        semanticClip = state.result === 'draw' ? 'idle' : (state.result === 'player') === (side === 0) ? 'victory' : 'defeat';
        normalizedTime = state.result === 'draw' ? 0 : resultElapsedMs / 900; lunge = 0;
      }
      return { semanticClip, normalizedTime: clamp(normalizedTime), lunge, pose: poses[side] };
    }) as [CharacterSample, CharacterSample];
  }
}
