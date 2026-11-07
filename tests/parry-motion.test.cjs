const test = require('node:test');
const assert = require('node:assert/strict');
const { ParryMotion, DEFAULT_ANCHORS } = require('../.test-build/ParryMotion.js');
const { Battle, DEFAULT_RULES } = require('../.test-build/core/Battle.js');
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const freeze = value => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return value; };
function scenario(defender = 0, end = 920, steps = [480, 659, 660, 920]) {
  const battle = new Battle('motion', 'tap'), motion = new ParryMotion();
  const cmd = (actorId, atMs, action) => ({ actorId, atMs, action, sequence: 1, sessionId: 'motion' });
  battle.submit(cmd(1 - defender, 0, 'attack')); battle.submit(cmd(defender, 430, 'guard'));
  const frames = [];
  for (const at of steps.filter(at => at <= end)) {
    battle.advanceTo(at); const state = freeze(battle.snapshot()), events = freeze(battle.drainEvents());
    motion.consume(state, events); frames.push({ state, events, poses: motion.sample(state) });
  }
  return { battle, motion, frames };
}

test('legal guard starts immediately, reaches face within60ms and resets the whole pose', () => {
  const b = new Battle('motion', 'tap'), m = new ParryMotion();
  b.submit({ sessionId: 'motion', actorId: 0, atMs: 0, sequence: 1, action: 'guard' });
  const frames = [];
  for (const at of [0, 1, 30, 60, 299, 300]) { b.advanceTo(at); m.consume(b.snapshot(), b.drainEvents()); frames.push(m.sample(b.snapshot())); }
  const target = frames[3][0].arms.lead.palm;
  assert.ok(distance(frames[1][0].arms.lead.palm, target) < distance(frames[0][0].arms.lead.palm, target));
  assert.ok(distance(frames[2][0].arms.lead.palm, target) < distance(frames[1][0].arms.lead.palm, target));
  assert.deepEqual(frames[3][0].arms.lead.palm, frames[4][0].arms.lead.palm);
  assert.deepEqual(frames[5][0], frames[0][0]);
});

test('both sides catch with lead, rise and turn, then contact with the other hand at rule time', () => {
  for (const defender of [0, 1]) {
    const { frames, motion } = scenario(defender);
    const attacker = 1 - defender, [start, pre, contact, recovered] = frames;
    assert.notEqual(start.poses[defender].blockingHand, start.poses[defender].counterHand);
    assert.ok(distance(start.poses[defender].arms.lead.palm, start.poses[attacker].arms.lead.palm) < 1e-9);
    assert.equal(start.poses[attacker].headRoll, 0); assert.equal(pre.poses[attacker].headRoll, 0);
    assert.ok(pre.poses[defender].body[1] > start.poses[defender].body[1]);
    assert.notEqual(pre.poses[defender].bodyYaw, start.poses[defender].bodyYaw);
    const cheek = DEFAULT_ANCHORS[attacker].cheek.map((v, i) => v + DEFAULT_ANCHORS[attacker].root[i]);
    assert.ok(distance(contact.poses[defender].arms.rear.palm, cheek) < 1e-9, 'counter palm reaches the opposite cheek in either direction');
    assert.ok(distance(pre.poses[defender].arms.rear.palm, cheek) > 0, 'no early contact');
    assert.equal(contact.state.fighters[attacker].hp, 4);
    const afterHit = { ...contact.state, nowMs: 661 };
    assert.notEqual(motion.sample(afterHit)[attacker].headRoll, 0);
    const idle = new Battle('idle', 'tap').snapshot();
    assert.deepEqual(recovered.poses[defender], new ParryMotion().sample(idle)[defender]);
    for (const frame of frames) for (const pose of frame.poses) {
      assert.ok(pose.scale.every(n => Number.isFinite(n) && n > 0));
      for (const arm of Object.values(pose.arms)) for (const p of [arm.shoulder, arm.elbow, arm.wrist, arm.palm]) assert.ok(p.every(Number.isFinite));
      assert.deepEqual(motion.sample(frame.state, frame.state.nowMs), motion.sample(frame.state, frame.state.nowMs));
    }
  }
});

test('all fresh events survive batches and duplicate events cannot restart or replay old motions', () => {
  const { frames } = scenario(0), events = frames.flatMap(f => f.events), last = frames.at(-1).state;
  const chronological = new ParryMotion(), batch = new ParryMotion();
  for (const frame of frames) chronological.consume(frame.state, frame.events);
  batch.consume(last, [...events].reverse());
  assert.deepEqual(batch.sample(last), chronological.sample(last));
  batch.consume(last, events); assert.deepEqual(batch.sample(last), chronological.sample(last));
  const late = { ...last, nowMs: 2000 };
  batch.consume(late, events); assert.deepEqual(batch.sample(late), new ParryMotion().sample(late));
});

test('same rule time freezes poses; new identity and ended remove pending presentation chains', () => {
  const { motion, frames } = scenario(0, 659);
  const frame = frames.at(-1), frozen = motion.sample(frame.state);
  assert.deepEqual(motion.sample(frame.state), frozen);
  const next = freeze(new Battle('next', 'tap').snapshot());
  motion.consume(next, frames.flatMap(f => f.events));
  assert.deepEqual(motion.sample(next), new ParryMotion().sample(next));
  const ended = { ...frame.state, result: 'draw' };
  motion.consume(ended, [{ id: 'end', sessionId: 'motion', atMs: 659, kind: 'ended' }]);
  const poses = motion.sample(ended);
  assert.ok(distance(poses[0].arms.rear.palm, frozen[0].arms.rear.palm) > 0.1);
  assert.deepEqual(motion.sample(ended), poses);
  assert.throws(() => motion.sample(next, Infinity), /finite/);
  assert.throws(() => motion.sample(next, 0, [{ ...DEFAULT_ANCHORS[0], root: [NaN, 0, 0] }, DEFAULT_ANCHORS[1]]), /anchors/);
});
