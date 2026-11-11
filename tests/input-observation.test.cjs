const test = require('node:test');
const assert = require('node:assert/strict');
const { InputObservation, inputObservationRequested } = require('../.test-build/InputObservation.js');
const { InputBridge } = require('../.test-build/InputBridge.js');
const { LocalSession } = require('../.test-build/session/LocalSession.js');

function context() {
    return { page: 'battle', mode: 'charge', practice: 'hit', hidden: false,
        sessionId: 'observation-test', nowMs: 0, paused: false, commandSequence: 1,
        fighters: [{ hp: 5, phase: 'charging', chargeStartMs: 0, contactAtMs: null, guardCharges: 2 }],
        recentEvents: [] };
}
function entry(kind = 'touch-cancel', source = 'cocos-input', phase = 'before', cocosSimulate = false) {
    return { source, kind, phase, reportedType: kind, cocosSimulate, pointerIds: [7], sourceTimeStamp: null,
        wallTimeMs: 120, unixTimeMs: 1000000, context: context() };
}

test('input observation is disabled unless the exact explicit query is present', () => {
    assert.equal(inputObservationRequested(undefined, undefined), false);
    for (const value of [true, 1, 'true', '0', '', null]) {
        assert.equal(inputObservationRequested(value, { diagnosticInput: value }), false);
    }
    assert.equal(inputObservationRequested('1', undefined), true);
    assert.equal(inputObservationRequested(undefined, { diagnosticInput: '1', unrelatedLaunchData: 'not-retained' }), true);
    const observer = new InputObservation(false, 'test-build');
    observer.record(entry());
    observer.setNativeCancelObservation('observing');
    assert.equal(observer.snapshot().totalRecords, 0);
    assert.deepEqual(observer.snapshot().records, []);
    assert.equal(observer.snapshot().nativeCancelObservation, 'disabled');
});

test('mouse-derived Cocos, unsimulated Cocos, unknown Cocos, native wx and hide are distinct evidence', () => {
    const observer = new InputObservation(true, 'test-build');
    observer.record(entry('touch-cancel', 'cocos-input', 'before', true));
    observer.record(entry('touch-cancel', 'cocos-input', 'after', true));
    observer.record(entry('touch-cancel', 'cocos-input', 'before', false));
    observer.record(entry('touch-cancel', 'cocos-input', 'before', null));
    observer.record(entry('touch-cancel', 'wechat-platform', 'callback', null));
    observer.record(entry('game-hide', 'cocos-game', 'before', null));
    observer.record(entry('game-hide', 'cocos-game', 'after', null));
    const value = observer.snapshot();
    assert.equal(value.counts.cocosTouchCancel, 3);
    assert.equal(value.counts.cocosMouseCancel, 1);
    assert.equal(value.counts.cocosUnsimulatedCancel, 1);
    assert.equal(value.counts.cocosUnknownCancel, 1);
    assert.equal(value.counts.wechatTouchCancel, 1);
    assert.equal(value.counts.gameHide, 1);
    assert.deepEqual(value.records.map(r => r.delivery), ['mouse-simulated', 'mouse-simulated',
        'cocos-touch-unsimulated', 'unknown', 'wechat-platform-callback', 'lifecycle', 'lifecycle']);
});

test('bounded observation keeps copied state and returned evidence cannot mutate its next snapshot', () => {
    const observer = new InputObservation(true, 'test-build');
    const original = entry();
    observer.record(original);
    original.pointerIds.push(123);
    original.context.fighters[0].hp = 0;
    const copy = observer.snapshot();
    assert.deepEqual(copy.records[0].pointerIds, [7]);
    assert.equal(copy.records[0].context.fighters[0].hp, 5);
    copy.records[0].context.fighters[0].hp = 1;
    copy.counts.cocosTouchCancel = 900;
    assert.equal(observer.snapshot().records[0].context.fighters[0].hp, 5);
    assert.equal(observer.snapshot().counts.cocosTouchCancel, 1);
    for (let i = 0; i < 130; i++) observer.record(entry('touch-start'));
    const bounded = observer.snapshot();
    assert.equal(bounded.records.length, 96);
    assert.equal(bounded.totalRecords, 131);
    assert.equal(bounded.droppedRecords, 35);
    assert.equal(bounded.records[0].sequence, 36);
    assert.equal(bounded.counts.cocosTouchStart, 130);
});

test('observation and tampering with its copies do not change an identical charge/cancel/late-end match transcript', () => {
    function run(enabled) {
        const session = new LocalSession({ sessionId: 'observation-test', mode: 'charge', practice: 'hit', seed: 104729 });
        let sequence = 0;
        const events = [];
        const bridge = new InputBridge(action => {
            session.submit({ sessionId: 'observation-test', actorId: 0, sequence: ++sequence,
                atMs: session.snapshot().nowMs, action });
            session.advanceTo(session.snapshot().nowMs);
            events.push(...session.drainEvents());
        });
        const observer = new InputObservation(enabled, 'test-build');
        const observe = kind => {
            const value = entry(kind);
            const state = session.snapshot();
            value.context.fighters = state.fighters.map(f => ({ hp: f.hp, phase: f.phase,
                chargeStartMs: f.chargeStartMs, contactAtMs: f.contactAtMs, guardCharges: f.guardCharges }));
            observer.record(value);
            observer.observeAfterDraw(120, 1000000, value.context);
            const exported = observer.serialize(value.context, 130, 1000010);
            if (exported) JSON.parse(exported).current.fighters[0].hp = 0;
            const evidence = observer.snapshot();
            for (const row of evidence.records) for (const fighter of row.context.fighters) fighter.hp = 0;
        };
        observe('touch-start'); bridge.downAttack(7, 'charge');
        session.advanceTo(900); observe('touch-cancel'); bridge.cancel(7);
        observe('touch-end'); bridge.up(7);
        session.advanceTo(2000); events.push(...session.drainEvents());
        return { state: session.snapshot(), events, commandCount: sequence };
    }
    const disabled = run(false), enabled = run(true);
    assert.deepEqual(enabled, disabled);
    assert.deepEqual(enabled.state.fighters.map(f => f.hp), [5, 5]);
    assert.equal(enabled.commandCount, 2);
    assert.equal(enabled.events.some(e => e.kind === 'attack-start' || e.kind === 'hit'), false);
});

test('disabled observer does no after-draw or serialization work even with unreadable context', () => {
    const observer = new InputObservation(false, 'test-build');
    const poison = new Proxy({}, { get() { throw new Error('disabled observer read context'); } });
    observer.observeAfterDraw(1, 2, poison);
    assert.equal(observer.serialize(poison, 1, 2), null);
    assert.equal(observer.snapshot().lastAfterDraw, null);
    assert.equal(observer.snapshot().totalRecords, 0);
});

test('after-draw retains one snapshot while event entries preserve their own preceding draw', () => {
    const observer = new InputObservation(true, 'test-build');
    const state = context();
    state.nowMs = 1500; state.fighters[0].hp = 5;
    observer.observeAfterDraw(1500, 1001500, state);
    state.nowMs = 1680; state.fighters[0].hp = 4;
    state.recentEvents = [{ id: 'local-1:2', kind: 'hit', atMs: 1680, actorId: 1, targetId: 0, damage: 1 }];
    const beforeHide = entry('game-hide', 'cocos-game', 'before');
    beforeHide.context = state; observer.record(beforeHide);
    for (let n = 0; n < 1000; n++) observer.observeAfterDraw(2000 + n, 1002000 + n, { ...state, page: 'paused', paused: true });
    const result = observer.snapshot();
    assert.equal(result.totalRecords, 1); assert.equal(result.records.length, 1);
    assert.equal(result.lastAfterDraw.wallTimeMs, 2999);
    assert.equal(result.lastAfterDraw.page, 'paused');
    assert.equal(result.lastAfterDraw.screenPresentationVerified, false);
    assert.equal(result.records[0].lastAfterDraw.nowMs, 1500);
    assert.equal(result.records[0].lastAfterDraw.fighters[0].hp, 5);
    assert.equal(result.records[0].context.fighters[0].hp, 4);
    assert.deepEqual(result.records[0].context.recentEvents[0], { id: 'local-1:2', kind: 'hit', atMs: 1680, actorId: 1, targetId: 0, damage: 1 });
    result.records[0].lastAfterDraw.fighters[0].hp = 0;
    result.lastAfterDraw.fighters[0].hp = 0;
    assert.equal(observer.snapshot().records[0].lastAfterDraw.fighters[0].hp, 5);
    assert.equal(observer.snapshot().lastAfterDraw.fighters[0].hp, 4);
});

test('export schema drops every unlisted field and bounds strings, arrays, invalid times and total characters', () => {
    const observer = new InputObservation(true, 'test-build');
    const secret = 'PRIVATE-NOT-EXPORTED';
    const malicious = { token: secret, appId: secret, launchQuery: { token: secret }, system: secret,
        toJSON() { throw new Error('unlisted object serialized'); } };
    const state = { ...context(), ...malicious };
    state.fighters = [{ ...state.fighters[0], ...malicious }, ...Array.from({ length: 15 }, () => ({ ...context().fighters[0], ...malicious }))];
    state.recentEvents = Array.from({ length: 20 }, () => ({ id: 'e', kind: 'hit', atMs: Infinity,
        actorId: 1, targetId: 0, damage: NaN, ...malicious }));
    observer.observeAfterDraw(1, 2, state);
    observer.record({ ...entry(), ...malicious, context: state, pointerIds: Array.from({ length: 1000 }, (_, n) => n), sourceTimeStamp: Infinity });
    const parsed = JSON.parse(observer.serialize(state, NaN, Infinity));
    assert.equal(JSON.stringify(parsed).includes(secret), false);
    assert.equal(parsed.current.fighters.length, 2);
    assert.equal(parsed.current.recentEvents.length, 8);
    assert.equal(parsed.input.records[0].pointerIds.length, 16);
    assert.equal(parsed.input.records[0].sourceTimeStamp, null);
    assert.equal(parsed.current.recentEvents[0].atMs, 0);
    assert.equal(parsed.exportedWallTimeMs, 0);
    assert.equal(parsed.input.lastAfterDraw.screenPresentationVerified, false);
    assert.match(parsed.afterDrawMeaning, /screen presentation is unverified/);

    const long = '\u0000'.repeat(10000);
    const worst = { ...state, page: long, mode: long, practice: long, sessionId: long,
        fighters: state.fighters.map(f => ({ ...f, phase: long })),
        recentEvents: state.recentEvents.map(e => ({ ...e, id: long, kind: long })) };
    observer.observeAfterDraw(1, 2, worst);
    for (let n = 0; n < 150; n++) observer.record({ ...entry(), reportedType: long, context: worst });
    const json = observer.serialize(worst, 1, 2), bounded = JSON.parse(json);
    assert.ok(json.length <= observer.maxExportChars);
    assert.ok(bounded.exportTrimmedRecords > 0);
    assert.equal(observer.snapshot().records.length, 96); // export trimming never edits the original ring
    assert.equal(bounded.current.sessionId.length, 64);
    assert.equal(bounded.current.fighters[0].phase.length, 32);
    assert.ok(bounded.input.records.length > 0);
});
