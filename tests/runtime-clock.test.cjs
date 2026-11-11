const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeClock, RuntimeClockError, CLOCK_CALIBRATION, clockDiagnostic } = require('../.test-build/RuntimeClock.js');

function wxFixture({ scale = 1, platform = 'devtools', legacy = false, startPolling = true } = {}) {
    let raw = 10000 * scale, date = 1700000000000, readDateCount = 0, rawCount = 0;
    let fault = null, dateFault = null;
    const perf = { now() { assert.equal(this, perf); rawCount++;
        if (fault === 'throw') throw Error('PRIVATE-NATIVE-ERROR');
        if (fault === 'nan') return NaN;
        if (fault === 'infinity') return Infinity;
        return raw;
    } };
    const dateHost = { now() { assert.equal(this, dateHost); readDateCount++;
        if (dateFault === 'throw') throw Error('Date must not be read');
        return dateFault === 'nan' ? NaN : date;
    } };
    const api = { getPerformance() { assert.equal(this, api); return perf; },
        [legacy ? 'getSystemInfoSync' : 'getDeviceInfo']: () => ({ platform, secret: 'PRIVATE-SYSTEM', model: 'not-retained' }) };
    const clock = new RuntimeClock({ wx: api, Date: dateHost,
        performance: { now() { throw Error('wx must never fall back to global performance'); } } });
    if (startPolling) clock.pollCalibration();
    return { clock, perf, api, dateHost,
        advance(ms) { raw += ms * scale; date += ms; },
        offsetRaw(n) { raw += n; }, offsetDate(n) { date += n; },
        fault(n) { fault = n; }, dateFault(n) { dateFault = n; },
        counts() { return { rawCount, readDateCount }; },
        calibrate() { if (clock.snapshot().calibration.length === 0) clock.pollCalibration();
            for (let i = 0; i < 2; i++) { this.advance(150); clock.pollCalibration(); } },
    };
}

test('wx units use three samples/two intervals and normalize both milliseconds and microseconds', () => {
    for (const [scale, expectedUnit] of [[1, 'ms'], [1000, 'us']]) {
        const f = wxFixture({ scale });
        assert.equal(f.clock.snapshot().status, 'calibrating');
        assert.throws(() => f.clock.readMs(), RuntimeClockError);
        f.advance(150); f.clock.pollCalibration();
        assert.equal(f.clock.snapshot().status, 'calibrating');
        f.advance(150); f.clock.pollCalibration();
        assert.equal(f.clock.snapshot().status, 'ready');
        assert.equal(f.clock.snapshot().rawUnit, expectedUnit);
        assert.equal(f.clock.snapshot().scaleToMs, 1 / scale);
        assert.deepEqual(f.clock.snapshot().calibrationRatios, [scale, scale]);
        assert.equal(f.clock.readMs(), 10300);
        f.advance(1517.4); assert.ok(Math.abs(f.clock.readMs() - 11817.4) < 1e-7);
    }
});

test('measured units override platform expectations without guessing from raw magnitude', () => {
    for (const [scale, platform] of [[1, 'ios'], [1000, 'devtools'], [1000, undefined]]) {
        const f = wxFixture({ scale, platform }); f.calibrate();
        assert.equal(f.clock.snapshot().status, 'ready');
        assert.equal(f.clock.snapshot().scaleToMs, 1 / scale);
    }
});

test('ready wx source never reads Date again, changes scale or changes captured provider', () => {
    const f = wxFixture({ scale: 1000 }); f.calibrate();
    const counts = f.counts(); f.dateFault('throw');
    f.api.getPerformance = () => { throw Error('Provider must be frozen'); };
    for (const jump of [60000, -120000, 999999999]) {
        f.offsetDate(jump); f.advance(100); f.clock.pollCalibration();
        assert.ok(Number.isFinite(f.clock.readMs()));
        assert.equal(f.clock.snapshot().scaleToMs, .001);
    }
    assert.equal(f.counts().readDateCount, counts.readDateCount);
});

test('browser binds genuine performance, uses milliseconds, and does not access Date', () => {
    let raw = 42;
    const performance = { now() { assert.equal(this, performance); return raw; } };
    const clock = new RuntimeClock({ performance, Date: { now() { throw Error('Browser must not access Date'); } } });
    assert.equal(clock.snapshot().status, 'ready');
    assert.equal(clock.snapshot().provider, 'browser-performance');
    raw = 1559.4; assert.equal(clock.readMs(), 1559.4);
    clock.pollCalibration(); assert.equal(clock.readMs(), 1559.4);
    const now = () => 100;
    const shim = new RuntimeClock({ performance: { now }, Date: { now } });
    assert.equal(shim.snapshot().status, 'unavailable');
    assert.equal(shim.snapshot().reason, 'wall-clock-provider');
});

test('wx missing/null/throwing/invalid native API refuses global performance and Date fallback', () => {
    const apis = [{}, { getPerformance: () => null }, { getPerformance: () => ({}) },
        { getPerformance() { throw Error('private'); } }, { getPerformance: () => ({ now: () => NaN }) }];
    for (const wx of apis) {
        let fallbackCalls = 0;
        const clock = new RuntimeClock({ wx, performance: { now() { fallbackCalls++; return 1; } }, Date });
        clock.pollCalibration();
        assert.equal(clock.snapshot().status, 'unavailable');
        assert.throws(() => clock.readMs(), RuntimeClockError);
        assert.equal(fallbackCalls, 0);
        assert.equal(JSON.stringify(clock.snapshot()).includes('private'), false);
    }
    assert.equal(new RuntimeClock({ Date }).snapshot().status, 'unavailable');
});

test('calibration interval minimum and maximum include boundary neighbors', () => {
    const early = wxFixture(); early.advance(149); early.clock.pollCalibration();
    assert.equal(early.clock.snapshot().calibration.length, 1);
    early.advance(1); early.clock.pollCalibration();
    assert.equal(early.clock.snapshot().calibration.length, 2);
    early.advance(151); early.clock.pollCalibration(); assert.equal(early.clock.snapshot().status, 'ready');
    for (const elapsed of [999, 1000, 1001]) {
        const f = wxFixture(); f.advance(elapsed); f.clock.pollCalibration();
        assert.equal(f.clock.snapshot().status, elapsed <= 1000 ? 'calibrating' : 'unavailable');
        if (elapsed > 1000) assert.equal(f.clock.snapshot().reason, 'calibration-too-long');
    }
});

test('unit tolerance includes exact boundaries and rejects immediate neighbors plus unknown/zero units', () => {
    for (const scale of [.899999, .9, 1.1, 1.100001, 899.999, 900, 1100, 1100.001, 10, 0]) {
        const f = wxFixture({ scale }); f.calibrate();
        const expected = [.9, 1.1, 900, 1100].includes(scale);
        assert.equal(f.clock.snapshot().status, expected ? 'ready' : 'unavailable', `ratio=${scale}`);
    }
});

test('two conflicting interval units fail rather than changing scale during a match', () => {
    const f = wxFixture(); f.advance(150); f.clock.pollCalibration();
    f.advance(150); f.offsetRaw(149850); f.clock.pollCalibration();
    assert.equal(f.clock.snapshot().status, 'unavailable');
    assert.equal(f.clock.snapshot().reason, 'unit-ambiguous');
    assert.equal(f.clock.snapshot().scaleToMs, null);
});

test('calibration rejects wall forward/backward steps and native forward/backward anomalies', () => {
    for (const anomaly of ['date-forward', 'date-backward', 'raw-forward', 'raw-backward']) {
        const f = wxFixture(); f.advance(150);
        if (anomaly === 'date-forward') f.offsetDate(60000);
        if (anomaly === 'date-backward') f.offsetDate(-1000);
        if (anomaly === 'raw-forward') f.offsetRaw(60000);
        if (anomaly === 'raw-backward') f.offsetRaw(-1000);
        f.clock.pollCalibration(); assert.equal(f.clock.snapshot().status, 'unavailable', anomaly);
        assert.throws(() => f.clock.readMs(), RuntimeClockError);
    }
});

test('calibration brackets reject Date movement during a read and do not retain unbounded polls', () => {
    for (const width of [19, 20, 21, -1]) {
        let date = 1000, calls = 0;
        const clock = new RuntimeClock({ wx: { getPerformance: () => ({ now: () => 1 }) },
            Date: { now: () => date + (++calls % 2 === 0 ? width : 0) } });
        clock.pollCalibration();
        assert.equal(clock.snapshot().status, width >= 0 && width <= 20 ? 'calibrating' : 'unavailable');
    }
    const stalled = wxFixture();
    for (let n = 0; n < CLOCK_CALIBRATION.maxPolls + 1; n++) stalled.clock.pollCalibration();
    assert.equal(stalled.clock.snapshot().reason, 'calibration-stalled');
    assert.equal(stalled.clock.snapshot().calibration.length, 1);
});

test('invalid runtime source is sticky until explicit retry and snapshot remains read-only', () => {
    for (const fault of ['throw', 'nan', 'infinity', 'backward']) {
        const f = wxFixture(); f.calibrate();
        if (fault === 'backward') f.offsetRaw(-1); else f.fault(fault);
        assert.throws(() => f.clock.readMs(), RuntimeClockError);
        assert.equal(f.clock.snapshot().status, 'invalid');
        f.fault(null); f.advance(1000);
        assert.throws(() => f.clock.readMs(), RuntimeClockError);
        f.clock.beginCalibration(); f.calibrate(); assert.equal(f.clock.snapshot().status, 'ready');
        const before = f.counts(), snapshot = f.clock.snapshot();
        snapshot.calibration[0].raw = -999; snapshot.calibrationRatios.push(5);
        assert.notEqual(f.clock.snapshot().calibration[0].raw, -999);
        assert.equal(f.clock.snapshot().calibrationRatios.length, 2);
        assert.deepEqual(f.counts(), before);
        assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
    }
});

test('hidden calibration is discarded and cannot complete until explicitly begun again', () => {
    const f = wxFixture(); f.advance(150); f.clock.pollCalibration(); f.clock.interruptCalibration();
    f.advance(10000); f.clock.pollCalibration();
    assert.equal(f.clock.snapshot().status, 'suspended');
    assert.equal(f.clock.snapshot().calibration.length, 0);
    f.clock.beginCalibration(); f.calibrate(); assert.equal(f.clock.snapshot().status, 'ready');
    f.clock.interruptCalibration(); assert.equal(f.clock.snapshot().status, 'ready');
});

test('platform compatibility reads only platform and persists no system/device data', () => {
    for (const legacy of [false, true]) {
        const f = wxFixture({ legacy }); f.calibrate();
        assert.equal(f.clock.snapshot().platformClass, 'devtools');
        assert.equal(JSON.stringify(f.clock.snapshot()).includes('PRIVATE-SYSTEM'), false);
    }
    const clock = new RuntimeClock({ wx: { getPerformance: () => ({ now: () => 0 }),
        getDeviceInfo() { throw Error('private'); } }, Date: { now: () => 0 } });
    assert.equal(clock.snapshot().platformClass, 'unknown');
    assert.equal(clock.snapshot().status, 'calibrating');
});

test('cold loading does not count toward calibration; first observable update starts the bounded window', () => {
    const f = wxFixture({ startPolling: false });
    assert.equal(f.clock.snapshot().calibration.length, 0);
    assert.equal(f.counts().readDateCount, 0);
    f.advance(8000); f.clock.pollCalibration();
    assert.equal(f.clock.snapshot().status, 'calibrating');
    assert.equal(f.clock.snapshot().calibration.length, 1);
    f.calibrate(); assert.equal(f.clock.snapshot().status, 'ready');
    assert.deepEqual(f.clock.snapshot().calibrationRatios, [1, 1]);
});

test('clock diagnostic rejects unknown fields and bounds samples, ratios, enums and failed raw values', () => {
    const f = wxFixture({ scale: 1000 }); f.calibrate(); f.offsetRaw(-1);
    assert.throws(() => f.clock.readMs());
    const snapshot = f.clock.snapshot();
    assert.equal(snapshot.failure.reason, 'backward');
    assert.equal(snapshot.failure.lastGoodRaw, 10300000);
    assert.equal(snapshot.failure.observedRaw, 10299999);
    const privateFields = { token: 'PRIVATE-CLOCK', platform: { model: 'PRIVATE-CLOCK' },
        toJSON() { throw Error('unknown object must not serialize'); } };
    const value = { ...snapshot, ...privateFields,
        calibration: Array.from({ length: 1000 }, () => ({ ...snapshot.calibration[0], ...privateFields })),
        calibrationRatios: [1000, 1000, ...Array(1000).fill('PRIVATE-CLOCK')],
        failure: { ...snapshot.failure, ...privateFields },
    };
    const exported = clockDiagnostic(value), json = JSON.stringify(exported);
    assert.equal(exported.calibration.length, 3); assert.equal(exported.calibrationRatios.length, 2);
    assert.equal(exported.failure.observedRaw, 10299999);
    assert.equal(json.includes('PRIVATE-CLOCK'), false); assert.ok(json.length < 4096);
    const bad = clockDiagnostic({ ...value, status: 'PRIVATE-CLOCK', scaleToMs: 'PRIVATE-CLOCK', lastRaw: Infinity,
        rawUnit: { ...privateFields }, failure: { observedRaw: NaN, lastGoodRaw: Infinity, reason: 'PRIVATE-CLOCK' } });
    assert.equal(bad.status, 'unavailable'); assert.equal(bad.scaleToMs, null); assert.equal(bad.lastRaw, null);
    assert.equal(JSON.stringify(bad).includes('PRIVATE-CLOCK'), false);
    exported.failure.observedRaw = -55;
    assert.equal(f.clock.snapshot().failure.observedRaw, 10299999);
});
