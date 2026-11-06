const test = require('node:test');
const assert = require('node:assert/strict');
const { Battle, DEFAULT_RULES } = require('../.test-build/core/Battle.js');
const command = (actorId, atMs, sequence, action = 'attack', sessionId = 'test') => ({ sessionId, actorId, atMs, sequence, action });

test('tap contact occurs at 480ms, never a frame early', () => {
  const b = new Battle('test', 'tap');
  b.submit(command(0, 0, 1)); b.advanceTo(479);
  assert.equal(b.snapshot().fighters[1].hp, 5);
  b.advanceTo(480); assert.equal(b.snapshot().fighters[1].hp, 4);
  assert.equal(b.drainEvents().find(e => e.kind === 'hit').atMs, 480);
});

test('five legal attacks end once and duplicate input cannot cause damage twice', () => {
  const b = new Battle('test', 'tap');
  for (let i = 0; i < 5; i++) { const c = command(0, i * 1100, i); b.submit(c); b.submit(c); }
  b.advanceTo(6000);
  assert.equal(b.snapshot().result, 'player');
  const events = b.drainEvents();
  assert.equal(events.filter(e => e.kind === 'hit').length, 5);
  assert.equal(events.filter(e => e.kind === 'ended').length, 1);
  b.advanceTo(10000); assert.deepEqual(b.drainEvents(), []);
});

test('simultaneous lethal contacts draw independent of insertion order', () => {
  function play(reverse) {
    const b = new Battle('test', 'tap', { ...DEFAULT_RULES, maxHp: 1 });
    const cmds = [command(0, 0, 1), command(1, 0, 1)];
    for (const c of reverse ? cmds.reverse() : cmds) b.submit(c);
    b.advanceTo(480); return { state: b.snapshot(), events: b.drainEvents() };
  }
  assert.deepEqual(play(false), play(true));
  assert.equal(play(false).state.result, 'draw');
  assert.equal(play(false).events.filter(e => e.kind === 'ended').length, 1);
});

test('guard distinguishes precise, normal and expired windows at exact boundaries', () => {
  for (const [elapsed, kind, hp] of [[0, 'parry', 5], [79, 'parry', 5], [80, 'block', 5], [81, 'block', 5], [299, 'block', 5], [300, 'hit', 4], [301, 'hit', 4]]) {
    const b = new Battle('test', 'tap');
    b.submit(command(0, 0, 1)); b.submit(command(1, 480 - elapsed, 1, 'guard'));
    b.advanceTo(480);
    const events = b.drainEvents();
    assert.ok(events.some(e => e.kind === kind), `elapsed ${elapsed}: ${kind}`);
    assert.equal(b.snapshot().fighters[1].hp, hp);
    assert.equal(b.snapshot().fighters[0].hp, kind === 'parry' ? 4 : 5);
    assert.equal(events.filter(e => e.kind === 'parry').length, kind === 'parry' ? 1 : 0);
  }
});

test('guard cooldown, exhaustion and restoration obey exact timestamps', () => {
  const b = new Battle('test', 'tap');
  for (const [at, seq] of [[0, 1], [649, 2], [650, 3], [1300, 4]]) b.submit(command(0, at, seq, 'guard'));
  b.advanceTo(1300); assert.equal(b.snapshot().fighters[0].guardCharges, 0);
  assert.deepEqual(b.drainEvents().filter(e => e.kind === 'rejected').map(e => e.reason), ['guard-cooldown', 'guard-empty']);
  b.advanceTo(1799); assert.equal(b.snapshot().fighters[0].guardCharges, 0);
  b.advanceTo(1800); assert.equal(b.snapshot().fighters[0].guardCharges, 1);
  b.advanceTo(3599); assert.equal(b.snapshot().fighters[0].guardCharges, 1);
  b.advanceTo(3600); assert.equal(b.snapshot().fighters[0].guardCharges, 2);
  assert.equal(b.snapshot().fighters[0].guardRestoreAtMs, null);
  b.advanceTo(4000); b.submit(command(0, 4000, 5, 'guard')); b.advanceTo(4000);
  assert.equal(b.snapshot().fighters[0].guardRestoreAtMs, 5800);
});

test('taking damage cancels pending contact and locks input until stun ends', () => {
  const b = new Battle('test', 'tap');
  b.submit(command(0, 0, 1)); b.submit(command(1, 100, 1));
  b.submit(command(1, 829, 2)); b.submit(command(1, 830, 3));
  b.advanceTo(600); assert.equal(b.snapshot().fighters[0].hp, 5);
  assert.equal(b.snapshot().fighters[1].contactAtMs, null);
  b.advanceTo(830); assert.equal(b.snapshot().fighters[1].phase, 'windup');
  assert.equal(b.snapshot().fighters[1].contactAtMs, 1310);
  assert.ok(b.drainEvents().some(e => e.kind === 'rejected' && e.atMs === 829));
});

test('same-actor commands use sequence order and do not depend on enqueue order', () => {
  function run(reverse) {
    const b = new Battle('test', 'tap');
    const cmds = [command(0, 0, 2, 'attack'), command(0, 0, 1, 'guard')];
    for (const c of reverse ? cmds.reverse() : cmds) b.submit(c);
    b.advanceTo(1000); return { state: b.snapshot(), events: b.drainEvents() };
  }
  assert.deepEqual(run(false), run(true));
  assert.equal(run(false).state.fighters[1].hp, 5);
});

test('contacts at 60s resolve before timeout and terminal snapshots stay frozen', () => {
  const b = new Battle('test', 'tap'); b.submit(command(0, 59520, 1));
  b.advanceTo(60000); assert.equal(b.snapshot().result, 'player');
  const events = b.drainEvents(); assert.deepEqual(events.slice(-2).map(e => e.kind), ['hit', 'ended']);
  const ended = b.snapshot(); b.advanceTo(100000); assert.deepEqual(b.snapshot(), ended);
  const draw = new Battle('test', 'tap'); draw.advanceTo(60000); assert.equal(draw.snapshot().result, 'draw');
});

test('exact event transcript is invariant under 1/16/17/33/100 and uneven steps', () => {
  const transcript = [command(0, 0, 1), command(1, 430, 1, 'guard'), command(1, 1000, 2),
    command(0, 1300, 2, 'guard'), command(0, 2000, 3), command(1, 2000, 3),
    command(0, 3000, 4), command(1, 3500, 4), command(0, 4100, 5)];
  function run(steps) {
    const b = new Battle('test', 'tap'); for (const c of transcript) b.submit(c);
    let t = 0, i = 0; const events = [];
    while (t < 7000) { t = Math.min(7000, t + steps[i++ % steps.length]); b.advanceTo(t); events.push(...b.drainEvents()); }
    return { state: b.snapshot(), events };
  }
  const baseline = run([1]);
  for (const steps of [[16, 17], [33], [100], [17, 255, 3, 91]]) assert.deepEqual(run(steps), baseline);
});

test('invalid identity, values, old time and mutated caller inputs cannot corrupt state', () => {
  const b = new Battle('test', 'tap');
  for (const c of [command(0, 0, 1, 'attack', 'old'), command(2, 0, 2), command(0, NaN, 3), command(0, 0, -1), command(0, 0, 4, 'anything')]) b.submit(c);
  b.advanceTo(1000); assert.equal(b.snapshot().fighters[1].hp, 5);
  b.submit(command(0, 999, 8)); b.advanceTo(1000);
  assert.ok(b.drainEvents().some(e => e.reason === 'invalid-time'));
  const c = command(0, 1001, 9); b.submit(c); c.actorId = 1; c.atMs = 4000;
  b.advanceTo(1481); assert.equal(b.snapshot().fighters[1].hp, 4);
  assert.throws(() => b.advanceTo(1480), /monotonic/);
  assert.throws(() => b.advanceTo(Infinity), /monotonic/);
});

test('rule configuration rejects incomplete or inconsistent values before a match', () => {
  assert.throws(() => new Battle('test', 'tap', { version: 'broken' }), /Invalid rule/);
  assert.throws(() => new Battle('test', 'tap', { ...DEFAULT_RULES, windupMs: 0 }), /Invalid rule/);
  assert.throws(() => new Battle('test', 'tap', { ...DEFAULT_RULES, parryWindowMs: 301 }), /Parry/);
});
