import { BattleCommand, BattleState } from '../core/Battle';

export type PracticeKind = 'normal' | 'hit' | 'block' | 'parry';
export const PRACTICE_GOALS: Readonly<Record<PracticeKind, string>> = Object.freeze({
  normal: '观察对手前摇，选择出掌或防御。',
  hit: '对手不会出招。尝试出掌，观察命中和收招。',
  block: '对手固定节奏出掌。提前防御可格挡，太早或太晚会受击。',
  parry: '对手固定节奏出掌。在接触前的短窗口按防御，触发精准反击。',
});

/** Only receives a public snapshot. The command queue and future player input are inaccessible. */
export class Bot {
  static readonly STEP_MS = 20;
  private sequence = 0;
  private randomState: number;
  private nextAttackAt = 1000;
  private observedContact: number | null = null;
  private guardAt: number | null = null;

  constructor(readonly practice: PracticeKind, seed: number) {
    if (!Object.prototype.hasOwnProperty.call(PRACTICE_GOALS, practice) || !Number.isSafeInteger(seed)) throw new Error('Invalid bot options');
    this.randomState = seed >>> 0;
    if (practice !== 'normal') this.nextAttackAt = 1200;
  }

  decide(atMs: number, publicState: Readonly<BattleState>): BattleCommand[] {
    if (publicState.result || this.practice === 'hit') return [];
    const self = publicState.fighters[1];
    const opponent = publicState.fighters[0];
    const send = (action: BattleCommand['action']): BattleCommand[] => [{
      sessionId: publicState.sessionId, actorId: 1, sequence: ++this.sequence, atMs, action,
    }];
    if (this.practice !== 'normal') {
      if (atMs < this.nextAttackAt) return [];
      this.nextAttackAt += 2200;
      // Fixed practice commands still go through all normal state/cooldown restrictions.
      return send('attack');
    }
    if (opponent.phase === 'windup' && opponent.contactAtMs !== this.observedContact) {
      this.observedContact = opponent.contactAtMs;
      const choice = this.random();
      this.guardAt = choice < 0.65 && opponent.contactAtMs !== null
        ? opponent.contactAtMs - (choice < 0.30 ? 60 : 160) : null;
    }
    if (opponent.phase !== 'windup') this.guardAt = null;
    if (this.guardAt !== null && atMs >= this.guardAt && self.phase === 'idle' &&
      self.guardCharges > 0 && atMs >= self.guardReadyAtMs) {
      this.guardAt = null;
      return send('guard');
    }
    if (self.phase !== 'idle' || atMs < this.nextAttackAt) return [];
    this.nextAttackAt = atMs + 1700 + Math.floor(this.random() * 600);
    return send('attack');
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }
}
