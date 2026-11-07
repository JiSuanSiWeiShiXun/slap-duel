import { ActorId, BattleEvent, BattleState, DEFAULT_RULES } from './core/Battle';
import { ParryMotion, FighterPose, Point } from './ParryMotion';

export interface ArmSolution {
  elbow: Point; wrist: Point; reachable: boolean; requestedDistance: number; solvedDistance: number; error: number;
}
export function solveTwoBone(shoulder: Point, upperLength: number, foreLength: number, palm: Point, palmOffset: number): ArmSolution {
  if (![...shoulder, ...palm, upperLength, foreLength, palmOffset].every(Number.isFinite) || upperLength <= 0 || foreLength <= 0 || palmOffset < 0) throw new Error('Arm geometry must be finite and positive');
  const target: Point = [palm[0], palm[1] - palmOffset, palm[2]];
  const delta = target.map((v, i) => v - shoulder[i]) as Point;
  const requestedDistance = Math.hypot(...delta), min = Math.abs(upperLength - foreLength) + 1e-7, max = upperLength + foreLength - 1e-7;
  const solvedDistance = Math.max(min, Math.min(requestedDistance, max));
  const direction = requestedDistance > 1e-9 ? delta.map(v => v / requestedDistance) as Point : [1, 0, 0] as Point;
  const dot = (a: Point, b: Point) => a.reduce((s,v,i) => s+v*b[i],0);
  let bend: Point = [0, -1, -.15], projection = dot(bend, direction);
  bend = bend.map((v,i) => v-direction[i]*projection) as Point;
  if (Math.hypot(...bend) < 1e-8) { bend = [0,0,1]; projection = dot(bend,direction); bend = bend.map((v,i)=>v-direction[i]*projection) as Point; }
  const bendLength = Math.hypot(...bend); bend = bend.map(v=>v/bendLength) as Point;
  const along = (upperLength ** 2 - foreLength ** 2 + solvedDistance ** 2) / (2 * solvedDistance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const elbow = shoulder.map((v,i)=>v+direction[i]*along+bend[i]*height) as Point;
  const wrist = shoulder.map((v,i)=>v+direction[i]*solvedDistance) as Point;
  return { elbow, wrist, reachable: requestedDistance >= min && requestedDistance <= max, requestedDistance, solvedDistance,
    error: Math.hypot(...wrist.map((v,i)=>v-target[i])) };
}

export interface ContactAnchors { root: Point; cheek: Point; leadPalm: Point; rearPalm: Point; }
export interface ContactTargets { lead: Point | null; rear: Point | null; }
// Rule-time visual hold makes the actual contact drawable even when a frame lands just after the hit.
export const COUNTER_CONTACT_HOLD_MS = 48;
/** Targets use actual post-apply bone anchors; no socket or animation duration is a rule clock. */
export function characterContacts(state: Readonly<BattleState>, anchors: readonly [ContactAnchors, ContactAnchors]): [ContactTargets, ContactTargets] {
  if (anchors.some(a=>[...a.root,...a.cheek,...a.leadPalm,...a.rearPalm].some(v=>!Number.isFinite(v)))) throw new Error('Contact anchors must be finite');
  const clamp = (n: number) => Math.max(0,Math.min(1,n));
  const lerp = (a: Point,b: Point,t: number): Point => a.map((v,i)=>v+(b[i]-v)*clamp(t)) as Point;
  const guarded = anchors.map((a,i)=>[a.cheek[0]+(i===0?.10:-.10),a.cheek[1]-.025,a.cheek[2]+.07] as Point);
  return state.fighters.map((f,i)=>{
    if (state.result) return {lead:null,rear:null};
    const own=anchors[i], other=anchors[1-i], facing=i===0?1:-1, age=state.nowMs-f.phaseStartMs;
    let lead: Point|null=null, rear: Point|null=null;
    // Source clips are L-led; explicit two-hand targets preserve semantic duties at either station.
    if (['charging','guard','windup','recovery','parried'].includes(f.phase)) rear=[own.root[0]-facing*.43,1.05,.3];
    if (f.phase==='charging') {
      const charge=clamp(age/DEFAULT_RULES.fullChargeMs);
      lead=[own.root[0]+facing*(.23-.12*charge),1.35+.10*charge,.4-.08*charge];
    }
    if (f.phase==='guard') lead=lerp(own.leadPalm,guarded[i],age/60);
    if (f.phase==='counter'||f.phase==='counter-recovery') lead=guarded[i];
    if (f.phase==='parried') lead=guarded[f.parriedBy??1-i];
    const rest: Point=[(i===0?-.55:.55)+facing*.48,1.25,.48];
    if (f.phase==='windup') lead=lerp([(i===0?-.55:.55)+facing*.25,1.55,.15],state.fighters[1-i].phase==='guard'?guarded[1-i]:other.cheek,(age/DEFAULT_RULES.windupMs-.65)/.35);
    if (f.phase==='recovery') lead=lerp(other.cheek,rest,age/DEFAULT_RULES.recoveryMs);
    if (f.phase==='counter') rear=lerp([own.root[0]-facing*.35,1.65,.18],other.cheek,(age/DEFAULT_RULES.counterWindupMs-.32)/.68);
    if (f.phase==='counter-recovery') rear=lerp(other.cheek,[(i===0?-.55:.55)-facing*.35,1.1,.25],(age-COUNTER_CONTACT_HOLD_MS)/(DEFAULT_RULES.counterRecoveryMs-COUNTER_CONTACT_HOLD_MS));
    return {lead,rear};
  }) as [ContactTargets,ContactTargets];
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
      else if (f.phase === 'counter-recovery') { semanticClip = 'counter-recovery'; normalizedTime = (age - COUNTER_CONTACT_HOLD_MS) / (DEFAULT_RULES.counterRecoveryMs - COUNTER_CONTACT_HOLD_MS); lunge = .34 * (1 - clamp(normalizedTime)); }
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
