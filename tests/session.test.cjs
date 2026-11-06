const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalSession } = require('../.test-build/session/LocalSession.js');
const { Battle } = require('../.test-build/core/Battle.js');
const opts = (mode = 'tap', practice = 'hit', sessionId = 'local') => ({ sessionId, mode, practice, seed: 42 });
const cmd = (atMs, sequence, action, sessionId = 'local') => ({ sessionId, actorId: 0, atMs, sequence, action });

test('charge threshold is exactly1200ms and cancellation produces no attack', () => {
  for (const [held, expected] of [[1199, 4], [1200, 3]]) {
    const s = new LocalSession(opts('charge'));
    s.submit(cmd(0, 1, 'charge-start')); s.submit(cmd(held, 2, 'charge-release'));
    s.advanceTo(held + 480); assert.equal(s.snapshot().fighters[1].hp, expected);
  }
  const s = new LocalSession(opts('charge'));
  s.submit(cmd(0, 1, 'charge-start')); s.submit(cmd(1000, 2, 'charge-cancel')); s.submit(cmd(1200, 3, 'charge-release'));
  s.advanceTo(2000); assert.equal(s.snapshot().fighters[1].hp, 5);
  assert.equal(s.drainEvents().filter(e => e.kind === 'attack-start').length, 0);
});

test('pause cancels charging and pending inputs without simulation advancing or replay', () => {
  const s = new LocalSession(opts('charge'));
  s.submit(cmd(0, 1, 'charge-start')); s.submit(cmd(1500, 2, 'charge-release'));
  s.advanceTo(500); s.pause();
  s.advanceTo(50000); assert.equal(s.snapshot().nowMs, 500);
  assert.equal(s.snapshot().fighters[0].phase, 'idle');
  s.resume(); s.advanceTo(2000); assert.equal(s.snapshot().fighters[1].hp, 5);
});

test('restart changes identity and discards old commands/events; snapshots are isolated', () => {
  const s = new LocalSession(opts());
  s.submit(cmd(0, 1, 'attack')); s.advanceTo(480);
  s.restart(opts('tap', 'hit', 'next'));
  s.submit(cmd(1000, 2, 'attack', 'local')); s.advanceTo(2000);
  assert.equal(s.snapshot().fighters[1].hp, 5); assert.deepEqual(s.drainEvents(), []);
  const copy = s.snapshot(); copy.fighters[0].hp = -10;
  assert.equal(s.snapshot().fighters[0].hp, 5);
  assert.throws(() => s.restart(opts('tap', 'hit', 'next')), /identity/);
});

test('scripted practice has the same opponent attacks in both control modes', () => {
  function run(mode) { const s = new LocalSession(opts(mode, 'block')); s.advanceTo(6000); return s.drainEvents(); }
  assert.deepEqual(run('tap'), run('charge'));
  assert.ok(run('tap').some(e => e.kind === 'hit'));
});

test('normal bot and session results are independent of render frame partition', () => {
  function run(steps) {
    const s = new LocalSession(opts('tap', 'normal'));
    for (let n = 0; n < 20; n++) s.submit(cmd(n * 1400, n + 1, 'attack'));
    let t = 0, n = 0;
    while (t < 30000) { t = Math.min(30000, t + steps[n++ % steps.length]); s.advanceTo(t); }
    return { state: s.snapshot(), events: s.drainEvents() };
  }
  assert.deepEqual(run([1]), run([16, 17]));
  assert.deepEqual(run([33]), run([100, 7, 221]));
});

test('session source replacement uses the same consumer and ordinary Battle API', () => {
  function consume(session) {
    session.submit(cmd(0, 1, 'attack')); session.advanceTo(480);
    return { state: session.snapshot(), events: session.drainEvents() };
  }
  assert.deepEqual(consume(new Battle('local', 'tap')), consume(new LocalSession(opts())));
});

test('bot cannot react to unobserved future commands', () => {
  const a = new LocalSession(opts('tap', 'normal'));
  const b = new LocalSession(opts('tap', 'normal'));
  b.submit(cmd(50000, 10, 'attack'));
  a.advanceTo(5000); b.advanceTo(5000);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual(a.drainEvents(), b.drainEvents());
});

test('pause freezes active windup and resume keeps the remaining duration', () => {
  const s = new LocalSession(opts());
  s.submit(cmd(0, 1, 'attack')); s.advanceTo(100); s.pause();
  s.advanceTo(10000); assert.equal(s.snapshot().nowMs, 100);
  s.submit(cmd(100, 2, 'attack')); // input while paused is not queued
  s.resume(); s.advanceTo(479); assert.equal(s.snapshot().fighters[1].hp, 5);
  s.advanceTo(480); assert.equal(s.snapshot().fighters[1].hp, 4);
  assert.equal(s.drainEvents().filter(e => e.kind === 'attack-start').length, 1);
});

test('practice bot obeys the same stun and attack mutual exclusion rules', () => {
  const s = new LocalSession(opts('tap', 'block'));
  s.submit(cmd(720, 1, 'attack')); // player's contact at bot scheduled startup1200
  s.advanceTo(1680);
  assert.equal(s.snapshot().fighters[0].hp, 5);
  assert.equal(s.snapshot().fighters[1].hp, 4);
  const events = s.drainEvents();
  assert.equal(events.filter(e => e.kind === 'hit' && e.actorId === 1).length, 0);
});

test('pause cancellation is reliable after the per-round command budget is exhausted', () => {
  const s = new LocalSession(opts('charge'));
  s.submit(cmd(0, 0, 'charge-start')); s.advanceTo(0);
  for (let i = 1; i < 8192; i++) s.submit(cmd(1000, i, 'guard'));
  s.pause();
  assert.equal(s.snapshot().fighters[0].phase, 'idle');
  s.resume(); s.advanceTo(2000);
  assert.equal(s.snapshot().fighters[1].hp, 5);
});
