const test = require('node:test');
const assert = require('node:assert/strict');
const { CharacterTimeline } = require('../.test-build/CharacterTimeline.js');
const { Battle, DEFAULT_RULES } = require('../.test-build/core/Battle.js');
const freeze = v => { Object.freeze(v); for (const child of Object.values(v)) if (child && typeof child === 'object') freeze(child); return v; };
const command = (sessionId, actorId, atMs, action, sequence = 1) => ({ sessionId, actorId, atMs, action, sequence });
function counterFrames(defender = 0) {
  const b = new Battle('clips', 'tap'), t = new CharacterTimeline(), frames = [];
  b.submit(command('clips', 1 - defender, 0, 'attack')); b.submit(command('clips', defender, 430, 'guard'));
  for (const now of [0, 430, 480, 659, 660, 661, 920]) {
    b.advanceTo(now); const state = freeze(b.snapshot()), events = freeze(b.drainEvents()); t.consume(state, events);
    frames.push({ state, events, samples: t.sample(state) });
  }
  return { b, t, frames };
}
test('compiled timeline maps every rule phase with deterministic read-only samples', () => {
  const b = new Battle('phases', 'charge'), t = new CharacterTimeline(), idle = b.snapshot();
  const expected = { idle: 'idle', charging: 'charge', windup: 'attack-light', recovery: 'recovery', guard: 'guard', parried: 'guard', counter: 'counter', 'counter-recovery': 'counter-recovery', stunned: 'hit' };
  for (const [phase, semanticClip] of Object.entries(expected)) {
    const state = freeze({ ...idle, nowMs: 51, fighters: [{ ...idle.fighters[0], phase, phaseStartMs: 1 }, idle.fighters[1]] });
    t.consume(state, []); const samples = t.sample(state);
    assert.equal(samples[0].semanticClip, semanticClip); assert.deepEqual(t.sample(state), samples);
    assert.ok(samples[0].normalizedTime >= 0 && samples[0].normalizedTime <= 1);
  }
});
test('attack-start damage survives the short UI trace and is session scoped', () => {
  const b = new Battle('heavy', 'charge'), t = new CharacterTimeline();
  b.submit(command('heavy', 0, 0, 'charge-start')); b.submit(command('heavy', 0, 1200, 'charge-release', 2)); b.advanceTo(1230);
  const state = freeze(b.snapshot()), events = b.drainEvents();
  t.consume(state, [...events, ...Array.from({ length: 40 }, (_, i) => ({ id: 'noise'+i, sessionId: 'heavy', kind: 'rejected', atMs: 1230 }))]);
  assert.equal(t.sample(state)[0].semanticClip, 'attack-heavy');
  t.consume(state, [...events].reverse()); assert.equal(t.sample(state)[0].semanticClip, 'attack-heavy');
  const next = { ...state, sessionId: 'next' }; t.consume(next, events);
  assert.equal(t.sample(next)[0].semanticClip, 'attack-light');
});
test('charge reaches full at1200 and stays there until cancelled', () => {
  const b = new Battle('charge', 'charge'), t = new CharacterTimeline(); b.submit(command('charge', 0, 0, 'charge-start'));
  for (const now of [0, 600, 1200, 2401]) { b.advanceTo(now); const s = b.snapshot(); t.consume(s, b.drainEvents()); assert.equal(t.sample(s)[0].normalizedTime, Math.min(now / 1200, 1)); }
  b.submit(command('charge', 0, 2401, 'charge-cancel', 2)); b.advanceTo(2401); t.consume(b.snapshot(), b.drainEvents()); assert.equal(t.sample(b.snapshot())[0].semanticClip, 'idle');
});
test('parry catches before hit and counter contact remains exactly180ms on either side', () => {
  for (const side of [0,1]) {
    const { t, frames } = counterFrames(side), catchFrame = frames[2], before = frames[3], hit = frames[4], after = frames[5];
    assert.equal(catchFrame.samples[side].semanticClip, 'counter'); assert.equal(catchFrame.samples[side].normalizedTime, 0);
    assert.equal(before.samples[side].normalizedTime, 179 / 180); assert.equal(before.samples[1-side].pose.headRoll, 0);
    assert.equal(before.state.fighters[1-side].hp, 5); assert.equal(hit.state.fighters[1-side].hp, 4);
    assert.equal(hit.samples[side].semanticClip, 'counter-recovery'); assert.equal(hit.samples[side].normalizedTime, 0);
    assert.equal(hit.samples[1-side].semanticClip, 'hit'); assert.notEqual(after.samples[1-side].pose.headRoll, 0);
    assert.notEqual(hit.samples[side].pose.blockingHand, hit.samples[side].pose.counterHand);
    assert.deepEqual(t.sample(before.state), t.sample(before.state));
  }
});
test('all fresh batches, duplicates, old sessions and expired attacks do not replay', () => {
  const { frames } = counterFrames(), t = new CharacterTimeline(), reverse = new CharacterTimeline(), events = frames.flatMap(f => f.events), state = frames.at(-1).state;
  for (const f of frames) t.consume(f.state, f.events);
  reverse.consume(state, [...events].reverse()); assert.deepEqual(reverse.sample(state), t.sample(state));
  reverse.consume(state, events); assert.deepEqual(reverse.sample(state), t.sample(state));
  const late = { ...state, nowMs: 3000 }; reverse.consume(late, events); assert.deepEqual(reverse.sample(late), new CharacterTimeline().sample(late));
});
test('result uses actual winner and a separate elapsed time, including timeout with both alive', () => {
  const s = new Battle('end', 'tap').snapshot(), t = new CharacterTimeline();
  for (const result of ['player', 'bot', 'draw']) {
    const state = freeze({ ...s, nowMs: 60000, result }); t.consume(state, []);
    const first = t.sample(state, state.nowMs, 0), half = t.sample(state, state.nowMs, 450), last = t.sample(state, state.nowMs, 900);
    assert.deepEqual(first.map(f => f.semanticClip), result === 'draw' ? ['idle','idle'] : result === 'player' ? ['victory','defeat'] : ['defeat','victory']);
    assert.deepEqual(first.map(f => f.normalizedTime), [0,0]); assert.deepEqual(last.map(f => f.normalizedTime), result === 'draw' ? [0,0] : [1,1]);
    assert.deepEqual(t.sample(state, state.nowMs, 450), half); assert.equal(state.nowMs, 60000);
  }
});
