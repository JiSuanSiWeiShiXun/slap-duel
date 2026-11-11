const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const compiler = process.env.COCOS_TSC || 'E:/DevTools/CocosCreator/3.8.8/resources/resources/3d/engine/node_modules/typescript/bin/tsc';
const ts = require(path.resolve(path.dirname(compiler), '../lib/typescript.js'));

// Run the actual input/update/lifecycle methods. Only engine/display surfaces
// are stubbed; LocalSession, Battle, Bot, InputBridge and clock are real modules.
// The optional source override is test-process-only for replaying the retained
// pre-fix bytes, never a production input or a live game's write/debug API.
function fixture(mode = 'charge', practice = 'hit', clockOptions = {}) {
    let wall = 10000;
    let unix = 1700000010000, unixShift = 0, wallBase = wall, unixBase = unix;
    let nativeFault = null, nativeReads = 0, renders = 0;
    const nativePerformance = { now() {
        nativeReads++;
        assert.equal(this, nativePerformance, 'native now must retain its receiver');
        if (nativeFault === 'throw') throw Error('native unavailable');
        if (nativeFault === 'nan') return NaN;
        if (nativeFault === 'backward') return (wallBase - 1) * (clockOptions.unit === 'us' ? 1000 : 1);
        return wall * (clockOptions.unit === 'us' ? 1000 : 1);
    } };
    class HostDate extends Date { static now() { return unix; } }
    const wx = clockOptions.wechat ? {
        getPerformance: () => nativePerformance,
        getDeviceInfo: () => ({ platform: clockOptions.unit === 'us' ? 'ios' : 'devtools', privateDeviceField: 'not-retained' }),
    } : undefined;
    const source = fs.readFileSync(process.env.SLAP_CLOCK_TEST_SOURCE || path.join(root, 'game/assets/scripts/SlapGame.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS, experimentalDecorators: true, useDefineForClassFields: false } }).outputText;
    const module = { exports: {} };
    const cc = { _decorator: { ccclass: () => value => value }, Component: class {},
        game: { frameRate: 60 }, Game: { EVENT_HIDE: 'game-hide', EVENT_SHOW: 'game-show' } };
    vm.runInNewContext(compiled, { exports: module.exports, module, console,
        performance: clockOptions.wechat ? { now: () => unix } : nativePerformance, Date: HostDate, wx,
        require(name) {
            if (name === 'cc') return cc;
            if (name === './CharacterView') return { CharacterView: class { count = 2; sample() {} } };
            if (name === './ArenaView') return {};
            if (name === './BuildInfo') return { BUILD_ID: 'unit-clock-test' };
            return require(path.resolve(root, '.test-build', `${name}.js`));
        },
    }, { filename: 'SlapGame.ts' });
    const game = new module.exports.SlapGame();
    game.ready = true;
    game.page = 'intro';
    game.roundSetup = { mode };
    game.practice = practice;
    game.renderPage = () => { renders++; };
    game.drawState = state => { game.drawn = state; };
    game.publishInputObservation = game.publishCastDiagnostics = game.publishFrameDiagnostics = () => {};
    if (game.runtimeClock && clockOptions.wechat && clockOptions.calibrate !== false) {
        game.runtimeClock.beginCalibration();
        game.runtimeClock.pollCalibration();
        for (const elapsed of [150, 300]) {
            wall = 10000 + elapsed; unix = 1700000010000 + elapsed;
            game.runtimeClock.pollCalibration();
        }
        wallBase = wall; unixBase = unix;
    }
    game.enterBattle();
    const at = ms => { wall = wallBase + ms; unix = unixBase + ms + unixShift; };
    return { game, at,
        tick(ms, dt = 1 / 60) { at(ms); game.update(dt); },
        jumpUnix(ms) { unixShift += ms; unix += ms; },
        fault(kind) { nativeFault = kind; },
        reads() { return nativeReads; }, renders() { return renders; },
        state() { return game.session.snapshot(); },
        events() { return game.trace; },
        hit() { return game.trace.find(e => e.kind === 'hit' && e.actorId === 0); } };
}

test('wechat battle elapsed ignores a post-start Date jump using native elapsed time', () => {
    for (const unit of ['ms', 'us']) {
        const f = fixture('charge', 'hit', { wechat: true, unit });
        f.game.bridge.downAttack(1, 'charge'); f.tick(100);
        f.jumpUnix(60000); f.tick(200);
        assert.equal(f.state().nowMs, 200, `native ${unit}: Unix forward step must not fast-forward battle`);
        assert.equal(f.state().result, null);
        f.at(1200); f.game.bridge.up(1); f.tick(1680);
        assert.equal(f.hit()?.damage, 2);
        assert.equal(f.hit()?.atMs, 1680);
    }
});

test('browser shared performance failure cannot escape diagnostics before the battle freezes', () => {
    const f = fixture('charge', 'parry');
    f.game.bridge.downAttack(7, 'charge'); f.tick(1541);
    f.fault('throw'); f.at(2475);
    assert.doesNotThrow(() => f.game.update(1 / 60));
    assert.equal(f.game.page, 'clock-error'); assert.equal(f.game.session.paused, true);
    assert.equal(f.state().nowMs, 1541); assert.equal(f.state().fighters[0].hp, 5);
    assert.equal(f.state().fighters[0].phase, 'idle');
    assert.equal(f.game.runtimeClock.snapshot().status, 'invalid');
    assert.doesNotThrow(() => f.game.frameDiagnostics());
});

test('real begin and failed enter commit no partial session, then retry initializes a fresh complete round', async () => {
    const f = fixture('charge', 'parry', { wechat: true });
    f.game.bridge.downAttack(7, 'charge'); f.at(1200); f.game.bridge.up(7); f.tick(1300);
    const oldId = f.state().sessionId, oldRound = f.game.round;
    assert.ok(f.game.sequence > 0);
    let scheduled;
    f.game.catalog = { manager: { roleId: 'manager', facets: { positive: 'p', negative: 'n' } } };
    f.game.isValid = true;
    f.game.clearActors = () => {};
    f.game.prepareActors = async () => {};
    f.game.scheduleOnce = callback => { scheduled = callback; };
    f.game.page = 'menu'; f.game.begin('parry');
    assert.equal(f.game.page, 'loading'); assert.equal(f.game.session, null);
    assert.equal(f.game.trace.length, 0); assert.equal(f.game.motion.sessionId, null);
    await scheduled(); assert.equal(f.game.page, 'intro');
    f.fault('throw'); f.game.enterBattle();
    assert.equal(f.game.page, 'clock-error'); assert.equal(f.game.session, null);
    assert.equal(f.game.clockRetryTarget, 'enter'); assert.equal(f.game.round, oldRound);
    f.fault(null); f.game.retryRuntimeClock(); f.tick(10000); f.tick(10150); f.tick(10300);
    assert.equal(f.game.page, 'battle'); assert.equal(f.game.session.paused, false);
    assert.notEqual(f.state().sessionId, oldId); assert.equal(f.game.motion.sessionId, f.state().sessionId);
    assert.equal(f.game.sequence, 0); assert.equal(f.state().nowMs, 0);
    assert.equal(f.events().length, 0); assert.equal(f.game.round, oldRound + 1);
    f.game.bridge.up(7); assert.equal(f.game.sequence, 0);
});

test('wx cold startup waits for two observed intervals without creating a Battle or forcing retry', () => {
    const f = fixture('tap', 'hit', { wechat: true, calibrate: false });
    assert.equal(f.game.session, null);
    assert.equal(f.game.page, 'clock-error');
    f.tick(8000); assert.equal(f.game.session, null);
    assert.equal(f.game.runtimeClock.snapshot().status, 'calibrating');
    f.tick(8150); assert.equal(f.game.session, null);
    f.tick(8300); assert.equal(f.game.page, 'battle');
    assert.equal(f.state().nowMs, 0); assert.equal(f.game.sequence, 0);
    f.tick(8400); assert.equal(f.state().nowMs, 100);
});

test('wx clock loss freezes resolved state before clearing charge, with no repeated reads or late release', () => {
    for (const unit of ['ms', 'us']) for (const fault of ['throw', 'nan', 'backward']) for (const delivery of ['update', 'input']) {
        const f = fixture('charge', 'parry', { wechat: true, unit });
        f.game.bridge.downAttack(7, 'charge'); f.tick(1541); // enemy contact in139ms
        f.fault(fault); f.at(2475);
        if (delivery === 'update') assert.doesNotThrow(() => f.game.update(1 / 60));
        else assert.doesNotThrow(() => f.game.bridge.up(7));
        assert.equal(f.game.page, 'clock-error'); assert.equal(f.game.session.paused, true);
        assert.equal(f.state().nowMs, 1541); assert.equal(f.state().fighters[0].hp, 5);
        assert.equal(f.state().fighters[0].phase, 'idle');
        const frozen = f.state(), reads = f.reads(), renders = f.renders();
        f.tick(10000); f.tick(20000); f.game.bridge.up(7);
        assert.deepEqual(f.state(), frozen);
        assert.equal(f.reads(), reads); assert.equal(f.renders(), renders);
        assert.equal(f.events().some(e => e.kind === 'attack-start' && e.actorId === 0), false);
        f.fault(null); f.game.retryRuntimeClock();
        f.tick(21000); f.tick(21150); f.tick(21300);
        assert.equal(f.game.page, 'paused'); assert.equal(f.state().nowMs, 1541);
        f.at(22000); f.game.resume(); assert.equal(f.game.page, 'battle');
        f.tick(22138); assert.equal(f.state().fighters[0].hp, 5);
        f.tick(22139); assert.equal(f.state().fighters[0].hp, 4);
        assert.equal(f.events().filter(e => e.kind === 'hit' && e.actorId === 1).length, 1);
    }
});

test('failed resume and explicit retry preserve released windup timing on the fixed native provider', () => {
    const f = fixture('tap', 'hit', { wechat: true, unit: 'us' });
    f.game.bridge.downAttack(2, 'tap'); f.game.bridge.up(2); f.tick(100); f.game.pause();
    f.fault('throw'); assert.doesNotThrow(() => f.game.resume());
    assert.equal(f.game.page, 'clock-error'); assert.equal(f.state().nowMs, 100);
    f.fault(null); f.game.retryRuntimeClock();
    f.tick(10000); f.tick(10150); f.tick(10300);
    assert.equal(f.game.page, 'paused');
    f.at(11000); f.game.resume();
    f.tick(11379); assert.equal(f.state().fighters[1].hp, 5);
    f.tick(11380); assert.equal(f.state().fighters[1].hp, 4);
});

test('hide discards incomplete clock windows and pending start/resume intent until explicit action', () => {
    const first = fixture('tap', 'hit', { wechat: true, calibrate: false });
    first.tick(0); first.tick(150); first.game.hide(); first.tick(10000);
    assert.equal(first.game.runtimeClock.snapshot().status, 'suspended');
    first.game.show(); first.tick(20000); first.tick(20150); first.tick(20300);
    assert.equal(first.game.runtimeClock.snapshot().status, 'ready');
    assert.equal(first.game.session, null); assert.equal(first.game.page, 'clock-error');
    first.game.retryRuntimeClock(); first.tick(21000); first.tick(21150); first.tick(21300);
    assert.equal(first.game.page, 'battle'); assert.equal(first.state().nowMs, 0);

    const resume = fixture('charge', 'hit', { wechat: true });
    resume.game.bridge.downAttack(7, 'charge'); resume.tick(100); resume.fault('throw'); resume.tick(200);
    resume.fault(null); resume.game.retryRuntimeClock(); resume.tick(300); resume.game.hide();
    resume.game.show(); resume.tick(10000); resume.tick(10150); resume.tick(10300);
    assert.equal(resume.game.page, 'clock-error'); assert.equal(resume.game.session.paused, true);
    resume.game.bridge.up(7); assert.equal(resume.events().some(e => e.kind === 'attack-start'), false);
});

test('wx ready provider retains scale and excludes hidden duration, and fresh rounds clear old touch identity', () => {
    for (const unit of ['ms', 'us']) {
        const f = fixture('charge', 'hit', { wechat: true, unit });
        f.game.bridge.downAttack(7, 'charge'); f.tick(500); f.game.hide();
        const scale = f.game.runtimeClock.snapshot().scaleToMs;
        f.jumpUnix(-60000); f.tick(90000); f.game.show();
        assert.equal(f.game.page, 'paused'); f.game.bridge.up(7);
        f.at(91000); f.game.resume(); f.tick(91200);
        assert.equal(f.state().nowMs, 700); assert.equal(f.game.runtimeClock.snapshot().scaleToMs, scale);
        const old = f.state().sessionId;
        f.at(95000); f.game.page = 'intro'; f.game.enterBattle();
        assert.notEqual(f.state().sessionId, old); assert.equal(f.state().nowMs, 0);
        f.game.bridge.up(7); assert.equal(f.game.sequence, 0);
        f.game.bridge.downAttack(7, 'charge'); f.at(96200); f.game.bridge.up(7); f.tick(96680);
        assert.equal(f.hit()?.damage, 2); assert.equal(f.hit()?.atMs, 1680);
    }
});

test('clock retry only prepares a paused session; calibration touches and Date drift never auto-resume', () => {
    const f = fixture('charge', 'hit', { wechat: true });
    f.game.bridge.downAttack(7, 'charge'); f.tick(300); f.fault('throw'); f.tick(400);
    f.fault(null); f.game.retryRuntimeClock();
    f.tick(1000); f.game.bridge.downAttack(7, 'charge'); f.tick(1150); f.tick(1300);
    assert.equal(f.game.page, 'paused'); assert.equal(f.game.session.paused, true);
    f.game.bridge.up(7); const frozen = f.state();
    f.jumpUnix(60000); f.tick(5000);
    assert.deepEqual(f.state(), frozen); assert.equal(f.events().some(e => e.kind === 'attack-start'), false);
    f.at(6000); f.game.resume(); f.tick(6100);
    assert.equal(f.game.page, 'battle'); assert.equal(f.state().nowMs, 400);
    assert.equal(f.events().some(e => e.kind === 'attack-start'), false);
});

test('an explicit Continue can await clock readiness, but hide revokes that pending continuation', () => {
    for (const interrupted of [false, true]) {
        const f = fixture('tap', 'hit', { wechat: true });
        f.tick(300); f.game.pause(); f.game.runtimeClock.beginCalibration();
        f.at(10000); f.game.resume(); assert.equal(f.game.page, 'clock-error');
        f.tick(10000); f.tick(10150);
        if (interrupted) { f.game.hide(); f.game.show(); f.tick(20000); f.tick(20150); f.tick(20300); }
        else f.tick(10300);
        assert.equal(f.game.page, interrupted ? 'clock-error' : 'battle');
        assert.equal(f.game.session.paused, interrupted);
        assert.equal(f.state().nowMs, 300);
    }
});

test('actual charge callbacks use wall hold duration across a >1s clamped render gap', () => {
    const f = fixture();
    f.game.bridge.downAttack(7, 'charge');
    f.tick(1517.4); // engine supplied only one frame of dt after a long gap
    f.game.bridge.up(7);
    assert.equal(f.state().fighters[0].phase, 'windup');
    assert.equal(f.state().fighters[0].phaseStartMs, 1517);
    f.tick(1997.4);
    assert.equal(f.hit()?.damage, 2);
    assert.equal(f.hit()?.atMs, 1997);
    assert.equal(f.state().fighters[1].hp, 3);
});

test('charge boundary neighbors work with no rendered frame between down and up', () => {
    for (const [held, damage] of [[0, 1], [1199, 1], [1200, 2], [1201, 2]]) {
        const f = fixture();
        f.game.bridge.downAttack(1, 'charge');
        f.at(held); f.game.bridge.up(1);
        assert.equal(f.state().nowMs, held);
        f.tick(held + 480);
        assert.equal(f.hit()?.damage, damage, `hold=${held}`);
        assert.equal(f.hit()?.atMs, held + 480);
    }
});

test('tap input is stamped at callback time and advances by active wall even with zero or huge dt', () => {
    const f = fixture('tap');
    f.at(1500); f.game.bridge.downAttack(1, 'tap'); f.game.bridge.up(1);
    assert.equal(f.state().fighters[0].contactAtMs, 1980);
    f.tick(1979, 999); assert.equal(f.state().fighters[1].hp, 5);
    f.tick(1980, 0); assert.equal(f.state().fighters[1].hp, 4);
    assert.equal(f.hit()?.damage, 1);
    f.tick(2580, 0); assert.equal(f.state().fighters[0].phase, 'idle');
});

test('guard callback is queued before same-timestamp contact and keeps strict 80ms boundary', () => {
    // Practice attacker starts at1200, contact1680. At>=1681 the hit has
    // already happened; at1600 the 80ms age is a block, at1601 it is a parry.
    for (const [at, kind] of [[1379, 'hit'], [1380, 'hit'], [1381, 'block'], [1600, 'block'],
        [1601, 'parry'], [1679, 'parry'], [1680, 'parry'], [1681, 'hit']]) {
        const f = fixture('tap', 'parry');
        f.tick(1200); // stale frame remains at1200 until the guard callback
        f.at(at); f.game.bridge.downGuard(3);
        f.tick(Math.max(at, 1680));
        const contact = f.events().find(e => ['parry', 'block', 'hit'].includes(e.kind));
        assert.equal(contact?.kind, kind, `guard=${at}`);
        assert.equal(contact?.atMs, 1680);
        assert.equal(f.state().fighters[0].hp, kind === 'hit' ? 4 : 5);
        if (kind === 'parry') {
            f.tick(1859); assert.equal(f.state().fighters[1].hp, 5);
            f.tick(1860); assert.equal(f.state().fighters[1].hp, 4);
            assert.equal(f.events().filter(e => e.kind === 'counter-hit').length, 1);
        }
    }
});

test('hide freezes at resolved snapshot before bridge cancellation and drops all hidden wall time', () => {
    const f = fixture('charge', 'parry');
    f.game.bridge.downAttack(7, 'charge');
    f.tick(1600); // bot contact scheduled at1680; charge is still held
    f.at(3000); f.game.hide(); // must not catch up to3000 and take that hit
    const frozen = f.state();
    assert.equal(f.game.page, 'paused');
    assert.equal(frozen.nowMs, 1600);
    assert.equal(frozen.fighters[0].phase, 'idle');
    assert.equal(frozen.fighters[0].hp, 5);
    f.tick(70000); assert.deepEqual(f.state(), frozen);
    f.game.resume(); assert.equal(f.game.page, 'paused'); // hidden cannot resume
    f.game.show(); f.game.bridge.up(7); // late release has no ownership
    assert.deepEqual(f.state(), frozen);
    f.at(80000); f.game.resume();
    f.tick(80079); assert.equal(f.state().fighters[0].hp, 5);
    f.tick(80080); assert.equal(f.state().fighters[0].hp, 4);
    assert.equal(f.events().some(e => e.kind === 'attack-start' && e.actorId === 0), false);
});

test('ordinary pause preserves windup remaining time and repeated hide/show never auto-resumes', () => {
    const f = fixture('tap');
    f.game.bridge.downAttack(1, 'tap'); f.game.bridge.up(1);
    f.tick(100);
    f.at(2000); f.game.pause();
    assert.equal(f.state().nowMs, 100);
    f.game.hide(); f.game.hide(); f.at(50000); f.game.show(); f.game.show();
    assert.equal(f.game.page, 'paused');
    f.game.resume();
    f.tick(50379); assert.equal(f.state().fighters[1].hp, 5);
    f.tick(50380); assert.equal(f.state().fighters[1].hp, 4);
    f.tick(50980); assert.equal(f.state().fighters[0].phase, 'idle');
});

test('confirmed counter across pause retains exact remaining time in both attack modes', () => {
    for (const mode of ['tap', 'charge']) {
        const f = fixture(mode, 'parry');
        f.at(1630); f.game.bridge.downGuard(9);
        f.tick(1780); f.game.pause();
        assert.equal(f.state().fighters[0].phase, 'counter');
        f.at(10000); f.game.resume();
        f.tick(10079); assert.equal(f.state().fighters[1].hp, 5);
        f.tick(10080); assert.equal(f.state().fighters[1].hp, 4);
        assert.equal(f.events().filter(e => e.kind === 'counter-hit').length, 1);
    }
});

test('fresh round resets active clock, sequence, identity and old held pointer', () => {
    const f = fixture();
    f.game.bridge.downAttack(1, 'charge'); f.tick(500); f.game.pause();
    const oldId = f.state().sessionId;
    f.at(90000); f.game.page = 'intro'; f.game.enterBattle();
    assert.notEqual(f.state().sessionId, oldId);
    assert.equal(f.state().nowMs, 0); assert.equal(f.game.sequence, 0);
    f.game.bridge.up(1); assert.equal(f.game.sequence, 0);
    f.game.bridge.downAttack(2, 'charge');
    f.at(91200); f.game.bridge.up(2); f.tick(91680);
    assert.equal(f.hit()?.damage, 2);
    assert.equal(f.hit()?.atMs, 1680);
});

test('beyond round limit resolves result without submitting invalid-time or ended input', () => {
    for (const mode of ['tap', 'charge']) {
        const f = fixture(mode);
        f.at(60001); f.game.bridge.downAttack(1, mode);
        assert.equal(f.state().nowMs, 60000);
        assert.equal(f.state().result, 'draw');
        assert.equal(f.game.page, 'result');
        assert.equal(f.game.sequence, 0);
        assert.equal(f.events().filter(e => e.kind === 'rejected' || e.kind === 'attack-start').length, 0);
        f.at(70000); f.game.bridge.up(1); f.game.submit('guard');
        assert.equal(f.game.sequence, 0);
        f.tick(80000); assert.equal(f.state().nowMs, 60000);
        assert.equal(f.events().filter(e => e.kind === 'ended').length, 1);
    }
});

test('normal bot keeps identical transcript under different render schedules with identical callback times', () => {
    function run(dense) {
        const f = fixture('tap', 'normal');
        if (dense) for (let t = 20; t < 1000; t += 20) f.tick(t);
        f.tick(1000);
        if (dense) for (let t = 1020; t < 1430; t += 20) f.tick(t);
        f.at(1430); f.game.bridge.downGuard(1);
        if (dense) for (let t = 1440; t < 2000; t += 20) f.tick(t);
        f.tick(2000);
        return { state: f.state(), events: Array.from(f.events(), e => ({ ...e })) };
    }
    const sparse = run(false), dense = run(true);
    assert.deepEqual(sparse, dense);
    assert.equal(sparse.events.filter(e => e.kind === 'parry').length, 1);
    assert.equal(sparse.events.filter(e => e.kind === 'counter-hit').length, 1);
});

const touch = (id, simulate) => ({ getID: () => id, type: 'touch-cancel', simulate });

test('TOUCH_CANCEL during released windup freezes the139ms threat before a934ms delayed hide', () => {
    const f = fixture('charge', 'parry');
    f.at(1000); f.game.bridge.downAttack(7, 'charge');
    f.tick(1355); f.game.touchEnd({ ...touch(7), type: 'touch-end' });
    assert.equal(f.game.page, 'battle'); // ordinary release remains an attack, not a pause
    f.tick(1541);
    assert.equal(f.state().fighters[0].phase, 'windup');
    assert.equal(f.state().fighters[0].contactAtMs, 1835);
    assert.equal(f.state().fighters[1].contactAtMs - f.state().nowMs, 139);
    f.game.touchCancel(touch(7)); // pointer was already released: cancellation still ends local control
    assert.equal(f.game.page, 'paused');
    const frozen = f.state();
    assert.equal(frozen.nowMs, 1541);
    assert.equal(frozen.fighters[0].contactAtMs, 1835); // do not revoke an already released attack
    f.tick(2475); // cancel→system hide gap934ms cannot continue gameplay
    assert.deepEqual(f.state(), frozen);
    f.game.hide(); f.tick(50000); f.game.show();
    assert.deepEqual(f.state(), frozen);
    assert.equal(f.game.page, 'paused');
    f.at(60000); f.game.resume();
    f.tick(60138); assert.equal(f.state().fighters[0].hp, 5);
    f.tick(60139); assert.equal(f.state().fighters[0].hp, 4);
    assert.equal(f.events().filter(e => e.kind === 'hit' && e.actorId === 1).length, 1);
    assert.equal(f.events().find(e => e.kind === 'hit' && e.actorId === 1).atMs, 1680);
});

test('TOUCH_CANCEL freezes before held-charge cleanup can catch up a pending hit', () => {
    const f = fixture('charge', 'parry');
    f.at(1000); f.game.bridge.downAttack(7, 'charge');
    f.tick(1541);
    assert.equal(f.state().fighters[0].phase, 'charging');
    f.at(2475); // callback wall clock is already past the contact; last resolved snapshot is safe
    f.game.touchCancel(touch(7));
    assert.equal(f.game.page, 'paused');
    assert.equal(f.state().nowMs, 1541);
    assert.equal(f.state().fighters[0].phase, 'idle');
    assert.equal(f.state().fighters[0].hp, 5);
    f.game.touchEnd({ ...touch(7), type: 'touch-end' });
    f.game.hide(); f.game.show(); f.at(3000); f.game.resume();
    f.tick(3138); assert.equal(f.state().fighters[0].hp, 5);
    f.tick(3139); assert.equal(f.state().fighters[0].hp, 4);
    assert.equal(f.events().some(e => e.kind === 'attack-start' && e.actorId === 0), false);
});

test('TOUCH_CANCEL null/unknown IDs clear all pointers and repeated lifecycle callbacks never revive old input', () => {
    for (const id of [null, 99]) {
        const f = fixture();
        f.game.bridge.downAttack(1, 'charge'); f.game.bridge.downGuard(2);
        f.tick(500); f.game.touchCancel(touch(id));
        assert.equal(f.game.page, 'paused');
        assert.equal(f.state().fighters[0].phase, 'idle');
        const frozen = f.state(), sequence = f.game.sequence;
        for (let n = 0; n < 3; n++) {
            f.game.touchCancel(touch(id)); f.game.hide(); f.game.show();
            f.game.touchEnd({ ...touch(1), type: 'touch-end' });
            f.game.touchEnd({ ...touch(2), type: 'touch-end' });
            f.tick(10000 + n * 1000);
            assert.deepEqual(f.state(), frozen);
            assert.equal(f.game.sequence, sequence);
        }
        f.at(20000); f.game.resume(); f.tick(22000);
        assert.deepEqual(f.state().fighters.map(x => x.hp), [5, 5]);
        assert.equal(f.events().some(e => e.kind === 'attack-start'), false);
        // Reusing both old IDs is legal only because all pointer ownership was cleared.
        f.game.bridge.downGuard(2); assert.equal(f.state().fighters[0].phase, 'guard');
        f.game.bridge.up(2); f.tick(22300);
        f.game.bridge.downAttack(1, 'charge'); assert.equal(f.state().fighters[0].phase, 'charging');
    }
});

test('TOUCH_CANCEL pauses both control modes and mouse/unsimulated delivery without diagnostic dependence', () => {
    const { InputObservation } = require('../.test-build/InputObservation.js');
    for (const mode of ['tap', 'charge']) for (const simulate of [true, false, undefined]) for (const enabled of [false, true]) {
        const f = fixture(mode);
        f.game.inputObservation = new InputObservation(enabled, 'unit-clock-test');
        f.game.bridge.downAttack(3, mode);
        f.tick(100); f.game.touchCancel(touch(null, simulate));
        assert.equal(f.game.page, 'paused');
        const frozen = f.state();
        if (mode === 'charge') assert.equal(frozen.fighters[0].phase, 'idle');
        else assert.equal(frozen.fighters[0].contactAtMs, 480);
        f.tick(10000); assert.deepEqual(f.state(), frozen);
        f.game.touchEnd({ ...touch(3, simulate), type: 'touch-end' });
        f.at(20000); f.game.resume(); f.tick(20379);
        assert.equal(f.state().fighters[1].hp, 5);
        f.tick(20380);
        assert.equal(f.state().fighters[1].hp, mode === 'tap' ? 4 : 5);
    }
});

test('TOUCH_CANCEL outside battle safely clears held pointers without navigating or submitting gameplay', () => {
    const f = fixture();
    f.game.page = 'intro';
    f.game.bridge.downAttack(1, 'charge'); f.game.bridge.downGuard(2);
    const before = f.state(), sequence = f.game.sequence;
    f.game.touchCancel(touch(null));
    assert.equal(f.game.page, 'intro');
    assert.deepEqual(f.state(), before); assert.equal(f.game.sequence, sequence);
    f.game.page = 'battle';
    f.game.bridge.downAttack(1, 'charge');
    assert.equal(f.state().fighters[0].phase, 'charging');
    f.game.touchCancel(touch(2)); assert.equal(f.game.page, 'paused');
    f.game.touchEnd({ ...touch(1), type: 'touch-end' });
    assert.equal(f.events().some(e => e.kind === 'attack-start'), false);
});
