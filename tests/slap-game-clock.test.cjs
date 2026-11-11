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
function fixture(mode = 'charge', practice = 'hit') {
    let wall = 10000;
    const source = fs.readFileSync(process.env.SLAP_CLOCK_TEST_SOURCE || path.join(root, 'game/assets/scripts/SlapGame.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS, experimentalDecorators: true, useDefineForClassFields: false } }).outputText;
    const module = { exports: {} };
    const cc = { _decorator: { ccclass: () => value => value }, Component: class {},
        game: { frameRate: 60 }, Game: { EVENT_HIDE: 'game-hide', EVENT_SHOW: 'game-show' } };
    vm.runInNewContext(compiled, { exports: module.exports, module, console,
        performance: { now: () => wall }, Date,
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
    game.renderPage = () => {};
    game.drawState = state => { game.drawn = state; };
    game.publishInputObservation = game.publishCastDiagnostics = game.publishFrameDiagnostics = () => {};
    game.enterBattle();
    return { game, at(ms) { wall = 10000 + ms; },
        tick(ms, dt = 1 / 60) { wall = 10000 + ms; game.update(dt); },
        state() { return game.session.snapshot(); },
        events() { return game.trace; },
        hit() { return game.trace.find(e => e.kind === 'hit' && e.actorId === 0); } };
}

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
