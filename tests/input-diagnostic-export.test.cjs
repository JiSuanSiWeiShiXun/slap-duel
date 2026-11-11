const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const compiler = process.env.COCOS_TSC || 'E:/DevTools/CocosCreator/3.8.8/resources/resources/3d/engine/node_modules/typescript/bin/tsc';
const ts = require(path.resolve(path.dirname(compiler), '../lib/typescript.js'));
const { LocalSession } = require('../.test-build/session/LocalSession.js');

// Actual diagnostic/UI/lifecycle methods with display and platform API stubs.
// This proves wiring and isolation, not physical device visibility or clipboard permission.
function fixture({ enabled = true, wx, browser = false, clipboard } = {}) {
    let wall = 10000;
    const listeners = [], removed = [], controls = [];
    const nativeCancel = [];
    const api = wx === undefined ? { getLaunchOptionsSync: () => ({ query: { diagnosticInput: enabled ? '1' : '0', token: 'PRIVATE-LAUNCH' } }),
        onTouchCancel: callback => nativeCancel.push(callback), offTouchCancel: callback => nativeCancel.splice(nativeCancel.indexOf(callback), 1) } : wx;
    const cc = { _decorator: { ccclass: () => value => value }, Component: class {}, sys: { isBrowser: browser },
        director: { on(event, callback, owner) { listeners.push({ event, callback, owner }); },
            off(event, callback, owner) { removed.push({ event, callback, owner }); } },
        Director: { EVENT_AFTER_DRAW: 'after-draw' }, Game: { EVENT_HIDE: 'hide', EVENT_SHOW: 'show' },
        game: { off() {} }, view: { getScaleX: () => 1, getScaleY: () => 1, off() {} },
        screen: { windowSize: { width: 720, height: 1280 } }, input: { off() {} },
        Input: { EventType: { TOUCH_START: 'start', TOUCH_END: 'end', TOUCH_CANCEL: 'cancel' } } };
    const source = fs.readFileSync(path.join(root, 'game/assets/scripts/SlapGame.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS, experimentalDecorators: true, useDefineForClassFields: false } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, console, Date, wx: api,
        navigator: clipboard ? { clipboard } : undefined, performance: { now: () => wall },
        require(name) {
            if (name === 'cc') return cc;
            if (name === './CharacterView') return { CharacterView: class { clear() {} } };
            if (name === './ArenaView') return {};
            if (name === './BuildInfo') return { BUILD_ID: 'test-diagnostic-build' };
            return require(path.resolve(root, '.test-build', `${name}.js`));
        } }, { filename: 'SlapGame.ts' });
    const game = new module.exports.SlapGame();
    game.ui = { children: [] };
    game.session = new LocalSession({ sessionId: 'local-1', mode: 'charge', practice: 'parry', seed: 104729 });
    game.page = 'paused';
    game.panel = () => {};
    game.labelAt = value => ({ string: value, isValid: true });
    game.buttonAt = (name, rect, action) => { controls.push({ name, rect, action }); };
    game.prepareInputObservation(browser && enabled ? '1' : undefined);
    return { game, api, listeners, removed, controls, nativeCancel, at(ms) { wall = 10000 + ms; } };
}

test('copy button/listener exist only in explicitly enabled paused diagnostic UI', () => {
    const off = fixture({ enabled: false });
    off.game.renderPage();
    assert.equal(off.controls.some(c => c.name === '复制诊断'), false);
    assert.equal(off.listeners.length, 0);
    off.game.inputObservationContext = () => { throw new Error('disabled context read'); };
    off.game.observeInputAfterDraw(); off.game.copyInputDiagnostic();
    assert.equal(off.game.inputObservation.snapshot().lastAfterDraw, null);

    const on = fixture(); on.game.renderPage();
    assert.equal(on.controls.filter(c => c.name === '复制诊断').length, 1);
    assert.equal(on.listeners.length, 1);
    on.controls.length = 0; on.game.page = 'confirm'; on.game.renderPage();
    assert.equal(on.controls.some(c => c.name === '复制诊断'), false);
});

test('wx copy exports draw-before-hide HP evidence and reports success only after success callback', () => {
    let request;
    const f = fixture({ wx: { setClipboardData(options) { request = options; } } });
    // Custom API has no launch flag, so enable the exact explicit browser-value path.
    f.game.prepareInputObservation('1');
    f.game.page = 'battle';
    f.game.session.advanceTo(1500); f.at(1500); f.game.observeInputAfterDraw();
    f.game.session.advanceTo(1680); f.game.consume(f.game.session.drainEvents()); f.at(1685);
    f.game.hide(); f.game.observeInputAfterDraw(); f.game.show();
    f.game.renderPage();
    const before = f.game.session.snapshot();
    f.controls.find(c => c.name === '复制诊断').action();
    assert.match(f.game.inputDiagnosticCopyStatus, /正在复制/);
    const data = JSON.parse(request.data);
    assert.equal(data.build, 'test-diagnostic-build');
    assert.equal(JSON.stringify(data).includes('PRIVATE-LAUNCH'), false);
    const hide = data.input.records.find(r => r.kind === 'game-hide' && r.phase === 'before');
    assert.equal(hide.lastAfterDraw.nowMs, 1500);
    assert.equal(hide.lastAfterDraw.fighters[0].hp, 5);
    assert.equal(hide.context.fighters[0].hp, 4);
    assert.ok(hide.context.recentEvents.some(e => e.kind === 'hit' && e.atMs === 1680 && e.actorId === 1));
    assert.equal(data.input.lastAfterDraw.page, 'paused');
    assert.equal(data.input.lastAfterDraw.screenPresentationVerified, false);
    request.success(); assert.match(f.game.inputDiagnosticCopyStatus, /已复制/);
    request.fail(); assert.match(f.game.inputDiagnosticCopyStatus, /已复制/); // first completion wins
    assert.deepEqual(f.game.session.snapshot(), before);
    assert.equal(f.game.sequence, 0);
});

test('copy failure, thrown API, absent API and pending duplicate are distinct from success', () => {
    for (const mode of ['callback-failure', 'throw', 'missing']) {
        let calls = 0, request;
        const wx = mode === 'missing' ? {} : { setClipboardData(options) { calls++; request = options; if (mode === 'throw') throw new Error('PRIVATE-ERROR'); } };
        const f = fixture({ wx }); f.game.prepareInputObservation('1');
        f.game.copyInputDiagnostic(); f.game.copyInputDiagnostic();
        if (mode === 'callback-failure') {
            assert.equal(calls, 1); assert.match(f.game.inputDiagnosticCopyStatus, /正在复制/);
            request.fail(); assert.match(f.game.inputDiagnosticCopyStatus, /复制失败/);
        } else assert.match(f.game.inputDiagnosticCopyStatus, mode === 'throw' ? /复制失败/ : /无法复制/);
        assert.equal(f.game.inputDiagnosticCopyStatus.includes('PRIVATE-ERROR'), false);
        assert.equal(f.game.inputDiagnosticCopyBusy, false);
    }
});

test('Web clipboard promise success/failure is user-requested and never changes combat', async () => {
    for (const success of [true, false]) {
        let calls = 0;
        const f = fixture({ wx: null, browser: true, clipboard: { writeText(data) {
            calls++; assert.equal(JSON.parse(data).schemaVersion, 1);
            return success ? Promise.resolve() : Promise.reject(new Error('denied'));
        } } });
        const before = f.game.session.snapshot();
        f.game.copyInputDiagnostic(); await Promise.resolve();
        assert.equal(calls, 1);
        assert.match(f.game.inputDiagnosticCopyStatus, success ? /已复制/ : /复制失败/);
        assert.deepEqual(f.game.session.snapshot(), before);
    }
});

test('new pause clears old copy feedback and ignores completion from an older panel', () => {
    const requests = [];
    const f = fixture({ wx: { setClipboardData(options) { requests.push(options); } } });
    f.game.prepareInputObservation('1'); f.game.renderPage(); f.game.copyInputDiagnostic();
    assert.match(f.game.inputDiagnosticCopyStatus, /正在复制/);
    f.game.battleUI = () => {};
    f.game.page = 'battle'; f.game.renderPage();
    f.game.page = 'paused'; f.game.renderPage();
    assert.equal(f.game.inputDiagnosticCopyStatus, '');
    requests[0].success(); assert.equal(f.game.inputDiagnosticCopyStatus, '');
    f.game.copyInputDiagnostic(); requests[1].success();
    assert.match(f.game.inputDiagnosticCopyStatus, /已复制/);
    f.game.renderPage(); assert.match(f.game.inputDiagnosticCopyStatus, /已复制/); // resize of same panel
    f.game.page = 'battle'; f.game.renderPage();
    f.game.page = 'paused'; f.game.renderPage();
    assert.equal(f.game.inputDiagnosticCopyStatus, '');
});

test('destroy removes the identical after-draw/native callbacks and suppresses pending copy completion', () => {
    let request;
    const f = fixture(); f.api.setClipboardData = options => { request = options; };
    f.game.copyInputDiagnostic();
    const registered = f.listeners[0], native = f.nativeCancel[0];
    f.game.observeInputAfterDraw();
    const saved = f.game.inputObservation.snapshot();
    f.game.onDestroy();
    assert.equal(f.removed[0].callback, registered.callback);
    assert.equal(f.removed[0].owner, registered.owner);
    assert.equal(f.nativeCancel.includes(native), false);
    const beforeStatus = f.game.inputDiagnosticCopyStatus;
    request.success(); assert.equal(f.game.inputDiagnosticCopyStatus, beforeStatus);
    f.at(9999); registered.callback.call(registered.owner);
    assert.deepEqual(f.game.inputObservation.snapshot().lastAfterDraw, saved.lastAfterDraw);
    assert.equal(f.game.inputAfterDrawSubscribed, false);
});
