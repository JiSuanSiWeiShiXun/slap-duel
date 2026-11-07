import { ActorId, BattleEvent, BattleState, Rules, DEFAULT_RULES } from './core/Battle';

export type Point = [number, number, number];
export type HandId = 'lead' | 'rear';
export interface FighterAnchors { root: Point; facing: 1 | -1; cheek: Point; }
export type ArenaAnchors = readonly [FighterAnchors, FighterAnchors];
export interface ArmPose { shoulder: Point; elbow: Point; wrist: Point; palm: Point; palmYaw: number; }
export interface FighterPose {
  body: Point; bodyYaw: number; bodyRoll: number; head: Point; headRoll: number;
  arms: Record<HandId, ArmPose>; scale: Point; blockingHand: HandId; counterHand: HandId;
}
export interface MotionKey { t: number; lower: number; turn: number; lean: number; guard: number; reach: number; }
export interface MotionClip { name: string; keys: readonly MotionKey[]; }

/** Original editable joint clips. t is a normalized rule interval, never a wall clock. */
export const PARRY_CLIPS: Readonly<Record<'guard' | 'counter' | 'recovery', MotionClip>> = {
  guard: { name: 'guard_raise_lead', keys: [
    { t: 0, lower: 0, turn: 0, lean: 0, guard: 0, reach: 0 },
    { t: 1, lower: -0.04, turn: -8, lean: -3, guard: 1, reach: 0 },
  ] },
  counter: { name: 'parry_catch_rise_rear_slap', keys: [
    { t: 0, lower: -0.04, turn: -8, lean: -3, guard: 1, reach: 0 },
    { t: 0.32, lower: -0.18, turn: -18, lean: -8, guard: 1, reach: -0.14 },
    { t: 0.62, lower: -0.09, turn: 4, lean: 0, guard: 1, reach: 0.14 },
    { t: 1, lower: 0.04, turn: 30, lean: 7, guard: 1, reach: 1 },
  ] },
  recovery: { name: 'counter_rear_recover', keys: [
    { t: 0, lower: 0.04, turn: 30, lean: 7, guard: 1, reach: 1 },
    { t: 0.25, lower: 0.02, turn: 22, lean: 4, guard: 0.8, reach: 0.92 },
    { t: 1, lower: 0, turn: 0, lean: 0, guard: 0, reach: 0 },
  ] },
};
export const DEFAULT_ANCHORS: ArenaAnchors = [
  { root: [-1.25, 0, 0], facing: 1, cheek: [0.34, 1.8, 0.34] },
  { root: [1.25, 0, 0], facing: -1, cheek: [-0.34, 1.8, 0.34] },
];
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp = (a: Point, b: Point, t: number): Point => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const copy = (a: Point): Point => [...a];
const sampleClip = (clip: MotionClip, progress: number): MotionKey => {
  const t = clamp(progress), keys = clip.keys;
  let i = 1;
  while (i < keys.length - 1 && keys[i].t < t) i++;
  const a = keys[i - 1], b = keys[i], f = clamp((t - a.t) / (b.t - a.t));
  return { t, lower: mix(a.lower, b.lower, f), turn: mix(a.turn, b.turn, f), lean: mix(a.lean, b.lean, f), guard: mix(a.guard, b.guard, f), reach: mix(a.reach, b.reach, f) };
};
const transform = (p: Point, body: Point, yaw: number, roll: number): Point => {
  const y = yaw * Math.PI / 180, z = roll * Math.PI / 180;
  const x0 = p[0] * Math.cos(z) - p[1] * Math.sin(z), y0 = p[0] * Math.sin(z) + p[1] * Math.cos(z);
  return add(body, [x0 * Math.cos(y) + p[2] * Math.sin(y), y0, -x0 * Math.sin(y) + p[2] * Math.cos(y)]);
};
interface Chain { atMs: number; actor: ActorId; target: ActorId; hitAtMs: number | null; }

/** Session-scoped presentation consumer. It owns no Battle or command/damage callback. */
export class ParryMotion {
  private sessionId: string | null = null;
  private seen = new Set<string>();
  private chains: Chain[] = [];

  reset(sessionId: string | null = null): void { this.sessionId = sessionId; this.seen.clear(); this.chains = []; }

  consume(state: Readonly<BattleState>, events: readonly BattleEvent[], rules: Readonly<Rules> = DEFAULT_RULES): void {
    if (state.sessionId !== this.sessionId) this.reset(state.sessionId);
    // Network/session adapters may hand us a batch; reconstruct by rule time, not arrival order.
    for (const event of [...events].sort((a, b) => a.atMs - b.atMs)) {
      if (event.sessionId !== this.sessionId || this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      if (event.kind === 'ended') { this.chains = []; continue; }
      if (event.actorId === undefined || event.targetId === undefined) continue;
      if (event.kind === 'parry') {
        this.chains.push({ atMs: event.atMs, actor: event.actorId, target: event.targetId, hitAtMs: null });
      } else if (event.kind === 'counter-hit') {
        const chain = this.chains.find(c => c.actor === event.actorId && c.target === event.targetId && c.atMs + rules.counterWindupMs === event.atMs);
        if (chain) chain.hitAtMs = event.atMs;
      }
    }
    if (state.result) this.chains = [];
    else this.chains = this.chains.filter(c => state.nowMs <= c.atMs + rules.counterWindupMs + Math.max(rules.counterRecoveryMs, rules.stunMs));
  }

  sample(state: Readonly<BattleState>, nowMs: number = state.nowMs, anchors: ArenaAnchors = DEFAULT_ANCHORS, rules: Readonly<Rules> = DEFAULT_RULES): [FighterPose, FighterPose] {
    if (!Number.isFinite(nowMs)) throw new Error('Motion time must be finite');
    for (const anchor of anchors) {
      if (!anchor.root.every(Number.isFinite) || !anchor.cheek.every(Number.isFinite) || (anchor.facing !== 1 && anchor.facing !== -1)) throw new Error('Invalid motion anchors');
    }
    const chainFor = (actor: number) => state.sessionId === this.sessionId && !state.result
      ? this.chains.find(c => c.actor === actor && c.atMs <= nowMs && nowMs <= c.atMs + rules.counterWindupMs + rules.counterRecoveryMs) : undefined;
    const clipKeys = state.fighters.map((f, i) => {
      if (state.result) return sampleClip(PARRY_CLIPS.guard, 0);
      const chain = chainFor(i);
      if (chain) {
        const age = nowMs - chain.atMs;
        if (age <= rules.counterWindupMs) return sampleClip(PARRY_CLIPS.counter, age / rules.counterWindupMs);
        if (chain.hitAtMs !== null) return sampleClip(PARRY_CLIPS.recovery, (nowMs - chain.hitAtMs) / rules.counterRecoveryMs);
      }
      if (f.phase === 'counter') return sampleClip(PARRY_CLIPS.counter, (nowMs - f.phaseStartMs) / rules.counterWindupMs);
      if (f.phase === 'counter-recovery') return sampleClip(PARRY_CLIPS.recovery, (nowMs - f.phaseStartMs) / rules.counterRecoveryMs);
      return sampleClip(PARRY_CLIPS.guard, f.phase === 'guard' ? (nowMs - f.phaseStartMs) / 60 : 0);
    });
    const poses = anchors.map((anchor, i) => {
      const key = clipKeys[i], facing = anchor.facing;
      const body = add(anchor.root, [0, key.lower, 0]), yaw = facing * key.turn, roll = facing * key.lean;
      const head = transform([0, 1.8, 0], body, yaw, roll);
      const shoulder = (hand: HandId) => transform([facing * (hand === 'lead' ? 0.3 : -0.3), 1.36, hand === 'lead' ? 0.26 : 0.05], body, yaw, roll);
      const arm = (hand: HandId): ArmPose => {
        const palm = add(anchor.root, [facing * (hand === 'lead' ? 0.48 : -0.43), hand === 'lead' ? 1.25 : 1.05, hand === 'lead' ? 0.48 : 0.3]);
        return { shoulder: shoulder(hand), elbow: copy(palm), wrist: copy(palm), palm, palmYaw: 0 };
      };
      return { body, bodyYaw: yaw, bodyRoll: roll, head, headRoll: 0, arms: { lead: arm('lead'), rear: arm('rear') }, scale: [1, 1, 1] as Point, blockingHand: 'lead' as HandId, counterHand: 'rear' as HandId };
    }) as [FighterPose, FighterPose];
    const cheek = (actor: number): Point => transform(anchors[actor].cheek, poses[actor].body, poses[actor].bodyYaw, poses[actor].bodyRoll);
    const guardPalm = (actor: number): Point => add(cheek(actor), [anchors[actor].facing * 0.12, -0.03, 0.1]);

    for (const actor of [0, 1] as const) {
      const f = state.fighters[actor], target = (1 - actor) as ActorId, pose = poses[actor], key = clipKeys[actor], facing = anchors[actor].facing;
      const age = nowMs - f.phaseStartMs;
      pose.arms.lead.palm = lerp(pose.arms.lead.palm, guardPalm(actor), key.guard);
      if (f.phase === 'windup' || f.phase === 'recovery' || f.phase === 'charging') {
        const rest = add(anchors[actor].root, [facing * 0.48, 1.25, 0.48]);
        const preparation = add(rest, [-facing * 0.25, 0.1, -0.08]);
        const endpoint = state.fighters[target].phase === 'guard' ? guardPalm(target) : cheek(target);
        if (f.phase === 'windup') pose.arms.lead.palm = age < rules.windupMs * 0.65 ? preparation : lerp(preparation, endpoint, clamp((age / rules.windupMs - 0.65) / 0.35));
        if (f.phase === 'recovery') pose.arms.lead.palm = lerp(endpoint, rest, clamp(age / 220));
        if (f.phase === 'charging') pose.arms.lead.palm = preparation;
      }
      if (f.phase === 'parried' && f.parriedBy !== null) pose.arms.lead.palm = guardPalm(f.parriedBy);
      const chain = chainFor(actor);
      const inCounter = !state.result && (f.phase === 'counter' || f.phase === 'counter-recovery' || chain);
      if (inCounter) {
        const counterTarget = f.counterTargetId ?? chain?.target ?? target;
        const prepared = add(anchors[actor].root, [-facing * 0.4, 1.75 + key.lower, 0.22]);
        const rest = pose.arms.rear.palm;
        const endpoint = cheek(counterTarget);
        const reach = key.reach;
        const recovering = f.phase === 'counter-recovery' || (chain?.hitAtMs !== null && chain?.hitAtMs !== undefined && nowMs >= chain.hitAtMs);
        pose.arms.rear.palm = reach < 0 ? add(prepared, [-facing * -reach, 0, -0.04]) : lerp(recovering ? rest : prepared, endpoint, clamp(reach));
        pose.arms.rear.palmYaw = facing * (recovering ? 35 * clamp(reach) : mix(-35, 35, clamp(reach))) || 0;
      }
      // A head reacts only once the public state says damage actually happened.
      if (f.phase === 'stunned') pose.headRoll = -facing * Math.sin(clamp(age / rules.stunMs) * Math.PI) * 22;
      for (const hand of ['lead', 'rear'] as const) {
        const arm = pose.arms[hand];
        // The elbow stays visibly below the shoulder/wrist line; palm is the contact anchor.
        arm.wrist = copy(arm.palm);
        arm.elbow = add(lerp(arm.shoulder, arm.wrist, 0.5), [0, -0.24, -0.12]);
      }
    }
    return poses;
  }
}
