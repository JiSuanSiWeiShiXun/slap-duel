import { BattleEvent, BattleState } from './core/Battle';
import { ParryMotion, FighterPose } from './ParryMotion';

export interface CharacterSample {
  semanticClip: string;
  normalizedTime: number;
  lunge: number;
  pose: FighterPose;
}

/** Pure, read-only actor presentation boundary. */
export class CharacterTimeline {
  private motion = new ParryMotion();
  reset(sessionId: string | null = null): void { this.motion.reset(sessionId); }
  consume(state: Readonly<BattleState>, events: readonly BattleEvent[]): void { this.motion.consume(state, events); }
  sample(state: Readonly<BattleState>, nowMs = state.nowMs, resultElapsedMs = 0): [CharacterSample, CharacterSample] {
    return this.motion.sample(state, nowMs).map(pose => ({ semanticClip: 'idle', normalizedTime: 0, lunge: 0, pose })) as [CharacterSample, CharacterSample];
  }
}
