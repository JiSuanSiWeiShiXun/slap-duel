const test = require('node:test');
const assert = require('node:assert/strict');
const { ActiveSessionClock } = require('../.test-build/ActiveSessionClock.js');

test('active clock has zero epoch, preserves sub-millisecond remainder and ignores render partition', () => {
    let wall = 9234.25;
    const clock = new ActiveSessionClock(() => wall);
    assert.equal(clock.nowMs(), 0);
    clock.start();
    for (const [elapsed, expected] of [[0, 0], [.99, 0], [1, 1], [999, 999], [1000, 1000], [1001, 1001], [1517.4, 1517]]) {
        wall = 9234.25 + elapsed;
        assert.equal(clock.nowMs(), expected);
    }
    wall = 9234.25 + 60001;
    assert.equal(clock.nowMs(), 60001); // host, rather than clock, handles the round limit
});

test('freeze uses resolved snapshot, excludes pause gap and resumes from that exact snapshot', () => {
    let wall = 100;
    const clock = new ActiveSessionClock(() => wall);
    clock.start(); wall = 1100;
    assert.equal(clock.nowMs(), 1000);
    wall = 100000;
    clock.freezeAt(900); // no unseen catch-up; rollback is trusted lifecycle only
    wall = 1000000;
    assert.equal(clock.nowMs(), 900);
    clock.resume(900);
    wall += 79.99; assert.equal(clock.nowMs(), 979);
    wall += .01; assert.equal(clock.nowMs(), 980);
    clock.start(); assert.equal(clock.nowMs(), 0); // fresh session can reset identity/time
});

test('defensive source regression never creates decreasing or unsafe command time', () => {
    let wall = 100;
    const clock = new ActiveSessionClock(() => wall);
    clock.start(50);
    wall = 0; assert.equal(clock.nowMs(), 50);
    wall = 300; assert.equal(clock.nowMs(), 250);
    wall = 200; assert.equal(clock.nowMs(), 250);
    wall = 301; assert.equal(clock.nowMs(), 251);
    wall = Number.MAX_VALUE; assert.equal(clock.nowMs(), Number.MAX_SAFE_INTEGER);
});

test('invalid epochs and non-finite host time fail before altering a valid anchor', () => {
    let wall = 100;
    const clock = new ActiveSessionClock(() => wall);
    clock.start(20);
    for (const at of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => clock.start(at), RangeError);
        assert.throws(() => clock.freezeAt(at), RangeError);
        assert.throws(() => clock.resume(at), RangeError);
    }
    wall = 120; assert.equal(clock.nowMs(), 40);
    wall = Infinity; assert.throws(() => clock.nowMs(), RangeError);
    assert.throws(() => clock.resume(50), RangeError);
    wall = 130; assert.equal(clock.nowMs(), 50);
});
