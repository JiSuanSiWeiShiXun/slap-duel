/** Platform elapsed-time boundary. Date is only a temporary unit reference during wx calibration. */
export type ClockStatus = 'calibrating' | 'ready' | 'invalid' | 'unavailable' | 'suspended';
export type ClockReason = 'missing-api' | 'thrown' | 'nonfinite' | 'backward' | 'unit-ambiguous'
    | 'calibration-too-long' | 'calibration-stalled' | 'calibration-interrupted' | 'not-ready' | 'wall-clock-provider';
export type ClockSample = { raw: number; dateBeforeMs: number; dateAfterMs: number };
export type RuntimeClockHost = {
    performance?: { now?: () => number };
    Date?: { now: () => number };
    wx?: {
        getPerformance?: () => { now?: () => number };
        getDeviceInfo?: () => { platform?: unknown };
        getSystemInfoSync?: () => { platform?: unknown };
    };
};

export class RuntimeClockError extends Error {
    constructor(readonly reason: ClockReason) { super(`Runtime clock unavailable: ${reason}`); this.name = 'RuntimeClockError'; }
}

// Three retained samples, two 150–1000ms intervals, ±10% around the disjoint 1 and 1000 ratios.
// Short brackets reduce quantisation/call overhead; slow or disturbed calibration is retried, never guessed.
export const CLOCK_CALIBRATION = Object.freeze({ minIntervalMs: 150, maxIntervalMs: 1000,
    maxBracketMs: 20, relativeTolerance: .1, maxPolls: 240 });

export class RuntimeClock {
    private status: ClockStatus = 'unavailable';
    private reason: ClockReason | null = null;
    private provider: 'wx-performance' | 'browser-performance' | 'unavailable' = 'unavailable';
    private platformClass: 'devtools' | 'device' | 'unknown' = 'unknown';
    private rawUnit: 'ms' | 'us' | 'unknown' = 'unknown';
    private scaleToMs: number | null = null;
    private readRaw: (() => number) | null = null;
    private readDate: (() => number) | null = null;
    private lastRaw: number | null = null;
    private samples: ClockSample[] = [];
    private ratios: number[] = [];
    private polls = 0;
    private failure: { reason: ClockReason; observedRaw: number | null; lastGoodRaw: number | null } | null = null;

    constructor(private readonly host: RuntimeClockHost) { this.beginCalibration(); }

    /** Start/retry only before a new battle, or while the existing battle is frozen. */
    beginCalibration(): void {
        this.status = 'unavailable'; this.reason = null; this.provider = 'unavailable';
        this.platformClass = 'unknown'; this.rawUnit = 'unknown'; this.scaleToMs = null;
        this.readRaw = this.readDate = null; this.lastRaw = null;
        this.samples = []; this.ratios = []; this.polls = 0; this.failure = null;
        try {
            if (this.host.wx) {
                this.provider = 'wx-performance';
                const api = this.host.wx;
                // Keep only the platform classification, never the returned device/system object.
                try {
                    const platform = typeof api.getDeviceInfo === 'function' ? api.getDeviceInfo().platform
                        : typeof api.getSystemInfoSync === 'function' ? api.getSystemInfoSync().platform : undefined;
                    this.platformClass = platform === 'devtools' ? 'devtools' : typeof platform === 'string' ? 'device' : 'unknown';
                } catch { /* Platform is advisory. Measured units, rather than an OS guess, decide scale. */ }
                if (typeof api.getPerformance !== 'function' || typeof this.host.Date?.now !== 'function') return this.fail('missing-api');
                const performance = api.getPerformance();
                if (!performance || typeof performance.now !== 'function') return this.fail('missing-api');
                this.readRaw = performance.now.bind(performance);
                this.readDate = this.host.Date.now.bind(this.host.Date);
                this.status = 'calibrating';
                // The first observable menu/loading update starts the window.
                // Constructor -> first frame may include seconds of normal cold loading.
            } else {
                this.provider = 'browser-performance';
                const performance = this.host.performance;
                if (!performance || typeof performance.now !== 'function') return this.fail('missing-api');
                if (performance.now === this.host.Date?.now) return this.fail('wall-clock-provider');
                this.readRaw = performance.now.bind(performance);
                this.checkedRaw();
                this.rawUnit = 'ms'; this.scaleToMs = 1; this.status = 'ready';
            }
        } catch (error) { this.fail(error instanceof RuntimeClockError ? error.reason : 'thrown'); }
    }

    /** Driven by menu/loading updates. No timers, no commands, and no Date access once ready. */
    pollCalibration(): void {
        if (this.status !== 'calibrating') return;
        try {
            if (++this.polls > CLOCK_CALIBRATION.maxPolls) return this.fail('calibration-stalled');
            const sample = this.calibrationSample();
            if (this.samples.length === 0) { this.samples.push(sample); return; }
            const previous = this.samples[this.samples.length - 1];
            const elapsed = this.midpoint(sample) - this.midpoint(previous);
            if (elapsed < 0) return this.fail('backward');
            if (elapsed < CLOCK_CALIBRATION.minIntervalMs) return;
            if (elapsed > CLOCK_CALIBRATION.maxIntervalMs) return this.fail('calibration-too-long');
            const ratio = (sample.raw - previous.raw) / elapsed;
            const low = 1 - CLOCK_CALIBRATION.relativeTolerance, high = 1 + CLOCK_CALIBRATION.relativeTolerance;
            const unit = ratio >= low && ratio <= high ? 'ms'
                : ratio >= 1000 * low && ratio <= 1000 * high ? 'us' : 'unknown';
            this.samples.push(sample); this.ratios.push(ratio);
            if (unit === 'unknown' || (this.rawUnit !== 'unknown' && this.rawUnit !== unit)) return this.fail('unit-ambiguous');
            this.rawUnit = unit;
            if (this.samples.length === 3) {
                this.scaleToMs = unit === 'us' ? .001 : 1;
                this.status = 'ready'; this.reason = null;
                this.readDate = null; // Unit reference is deliberately unreachable during running.
            }
        } catch (error) { this.fail(error instanceof RuntimeClockError ? error.reason : 'thrown'); }
    }

    /** Hidden intervals must never complete an in-flight calibration window. */
    interruptCalibration(): void {
        if (this.status !== 'calibrating') return;
        this.status = 'suspended'; this.reason = 'calibration-interrupted';
        this.samples = []; this.ratios = []; this.readDate = null;
    }

    readMs(): number {
        if (this.status !== 'ready' || this.scaleToMs === null) throw new RuntimeClockError(this.reason ?? 'not-ready');
        try { return this.checkedRaw() * this.scaleToMs; }
        catch (error) {
            const reason = error instanceof RuntimeClockError ? error.reason : 'thrown';
            this.fail(reason, 'invalid'); throw new RuntimeClockError(reason);
        }
    }

    /** White-listed, bounded, detached evidence. Inspecting it never reads a clock. */
    snapshot() {
        return { status: this.status, reason: this.reason, provider: this.provider, platformClass: this.platformClass,
            rawUnit: this.rawUnit, scaleToMs: this.scaleToMs, lastRaw: this.lastRaw,
            normalizedMs: this.lastRaw !== null && this.scaleToMs !== null ? this.lastRaw * this.scaleToMs : null,
            calibration: this.samples.map(s => ({ ...s })), calibrationRatios: this.ratios.slice(),
            failure: this.failure ? { ...this.failure } : null,
            legacyObservationTimeMeaning: 'InputObservation.wallTimeMs uses global performance; Cocos3.8.8 wx shim is Date.now, not this provider' };
    }

    private fail(reason: ClockReason, status: ClockStatus = 'unavailable'): void {
        this.status = status; this.reason = reason; this.readDate = null;
        if (!this.failure || this.failure.reason !== reason) this.failure = { reason, observedRaw: null, lastGoodRaw: this.lastRaw };
    }
    private checkedRaw(): number {
        if (!this.readRaw) throw new RuntimeClockError('missing-api');
        let raw: number;
        try { raw = this.readRaw(); }
        catch {
            this.failure = { reason: 'thrown', observedRaw: null, lastGoodRaw: this.lastRaw };
            throw new RuntimeClockError('thrown');
        }
        if (!Number.isFinite(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER) {
            this.failure = { reason: 'nonfinite', observedRaw: Number.isFinite(raw) ? raw : null, lastGoodRaw: this.lastRaw };
            throw new RuntimeClockError('nonfinite');
        }
        if (this.lastRaw !== null && raw < this.lastRaw) {
            this.failure = { reason: 'backward', observedRaw: raw, lastGoodRaw: this.lastRaw };
            throw new RuntimeClockError('backward');
        }
        this.lastRaw = raw;
        return raw;
    }
    private calibrationSample(): ClockSample {
        if (!this.readDate) throw new RuntimeClockError('missing-api');
        const dateBeforeMs = this.readDate(), raw = this.checkedRaw(), dateAfterMs = this.readDate();
        if (!Number.isFinite(dateBeforeMs) || !Number.isFinite(dateAfterMs)) throw new RuntimeClockError('nonfinite');
        if (dateAfterMs < dateBeforeMs) throw new RuntimeClockError('backward');
        if (dateAfterMs - dateBeforeMs > CLOCK_CALIBRATION.maxBracketMs) throw new RuntimeClockError('calibration-too-long');
        return { raw, dateBeforeMs, dateAfterMs };
    }
    private midpoint(sample: ClockSample): number { return sample.dateBeforeMs + (sample.dateAfterMs - sample.dateBeforeMs) / 2; }
}

export function createRuntimeClock(host: RuntimeClockHost): RuntimeClock { return new RuntimeClock(host); }

/** Additive schema1 evidence. Explicit primitive/array whitelist, even for hostile unknown fields. */
export function clockDiagnostic(value: unknown) {
    const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
    const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? v : null;
    const choice = (v: unknown, options: readonly string[], fallback: string | null): string | null => typeof v === 'string' && options.includes(v) ? v : fallback;
    const reasons = ['missing-api', 'thrown', 'nonfinite', 'backward', 'unit-ambiguous', 'calibration-too-long',
        'calibration-stalled', 'calibration-interrupted', 'not-ready', 'wall-clock-provider'];
    const s = object(value), f = object(s.failure);
    return { schemaVersion: 1, provider: choice(s.provider, ['wx-performance', 'browser-performance', 'unavailable'], 'unavailable'),
        status: choice(s.status, ['calibrating', 'ready', 'invalid', 'unavailable', 'suspended'], 'unavailable'),
        reason: choice(s.reason, reasons, null), platformClass: choice(s.platformClass, ['devtools', 'device', 'unknown'], 'unknown'),
        rawUnit: choice(s.rawUnit, ['ms', 'us', 'unknown'], 'unknown'), scaleToMs: s.scaleToMs === 1 || s.scaleToMs === .001 ? s.scaleToMs : null,
        lastRaw: finite(s.lastRaw), normalizedMs: finite(s.normalizedMs),
        calibration: (Array.isArray(s.calibration) ? s.calibration.slice(0, 3) : []).map(v => {
            const p = object(v); return { raw: finite(p.raw), dateBeforeMs: finite(p.dateBeforeMs), dateAfterMs: finite(p.dateAfterMs) };
        }),
        calibrationRatios: (Array.isArray(s.calibrationRatios) ? s.calibrationRatios.slice(0, 2) : []).map(finite),
        failure: s.failure ? { reason: choice(f.reason, reasons, null), observedRaw: finite(f.observedRaw), lastGoodRaw: finite(f.lastGoodRaw) } : null,
        legacyObservationTimeMeaning: 'wallTimeMs uses global performance (wx shim: Date.now); unavailable diagnostic times repeat the last observation or zero' };
}
