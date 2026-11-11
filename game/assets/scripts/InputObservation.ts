/** Read-only evidence of delivered callbacks. This module never owns or emits gameplay input. */
export type InputObservationKind = 'touch-start' | 'touch-end' | 'touch-cancel' | 'game-hide' | 'game-show';
export type InputObservationSource = 'cocos-input' | 'cocos-game' | 'wechat-platform';
export type NativeCancelObservation = 'disabled' | 'not-wechat' | 'unavailable-off-api' | 'observing' | 'registration-failed' | 'removed' | 'removal-failed';
export interface InputObservationContext {
    page: string; mode: string; practice: string; hidden: boolean;
    sessionId: string | null; nowMs: number | null; paused: boolean | null; commandSequence: number;
    fighters: { hp: number; phase: string; chargeStartMs: number | null; contactAtMs: number | null; guardCharges: number }[];
    recentEvents: { id: string; kind: string; atMs: number; actorId?: number; targetId?: number; damage?: number }[];
}
export interface InputAfterDraw {
    source: 'Director.EVENT_AFTER_DRAW'; screenPresentationVerified: false;
    wallTimeMs: number; unixTimeMs: number; page: string; hidden: boolean;
    sessionId: string | null; nowMs: number | null; paused: boolean | null;
    fighters: { hp: number; phase: string }[];
}
export interface InputObservationRecord {
    sequence: number; source: InputObservationSource; kind: InputObservationKind;
    phase: 'before' | 'after' | 'callback'; reportedType: string;
    pointerIds: number[]; sourceTimeStamp: number | null; wallTimeMs: number; unixTimeMs: number;
    cocosSimulate: boolean | null;
    delivery: 'mouse-simulated' | 'cocos-touch-unsimulated' | 'wechat-platform-callback' | 'lifecycle' | 'unknown';
    context: InputObservationContext;
    lastAfterDraw: InputAfterDraw | null;
}
type Observation = Omit<InputObservationRecord, 'sequence' | 'delivery' | 'lastAfterDraw'>;
const text = (value: unknown, limit = 64): string => typeof value === 'string' ? value.slice(0, limit) : '';
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const nullableNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const actor = (value: unknown): number | undefined => value === 0 || value === 1 ? value : undefined;
const copyContext = (value: InputObservationContext): InputObservationContext => ({
    page: text(value.page, 32), mode: text(value.mode, 16), practice: text(value.practice, 16), hidden: value.hidden === true,
    sessionId: value.sessionId === null ? null : text(value.sessionId), nowMs: nullableNumber(value.nowMs),
    paused: typeof value.paused === 'boolean' ? value.paused : null, commandSequence: number(value.commandSequence),
    fighters: value.fighters.slice(0, 2).map(f => ({ hp: number(f.hp), phase: text(f.phase, 32), chargeStartMs: nullableNumber(f.chargeStartMs),
        contactAtMs: nullableNumber(f.contactAtMs), guardCharges: number(f.guardCharges) })),
    recentEvents: value.recentEvents.slice(-8).map(e => ({ id: text(e.id), kind: text(e.kind, 32), atMs: number(e.atMs),
        actorId: actor(e.actorId), targetId: actor(e.targetId), damage: nullableNumber(e.damage) ?? undefined })),
});
const copyDraw = (value: InputAfterDraw | null): InputAfterDraw | null => value ? ({
    source: 'Director.EVENT_AFTER_DRAW', screenPresentationVerified: false,
    wallTimeMs: number(value.wallTimeMs), unixTimeMs: number(value.unixTimeMs), page: text(value.page, 32), hidden: value.hidden === true,
    sessionId: value.sessionId === null ? null : text(value.sessionId), nowMs: nullableNumber(value.nowMs),
    paused: typeof value.paused === 'boolean' ? value.paused : null,
    fighters: value.fighters.slice(0, 2).map(f => ({ hp: number(f.hp), phase: text(f.phase, 32) })),
}) : null;
const copyRecord = (value: InputObservationRecord): InputObservationRecord => ({
    sequence: number(value.sequence), source: text(value.source, 32) as InputObservationSource,
    kind: text(value.kind, 32) as InputObservationKind, phase: text(value.phase, 16) as InputObservationRecord['phase'],
    reportedType: text(value.reportedType, 80), pointerIds: value.pointerIds.slice(0, 16).filter(Number.isSafeInteger),
    sourceTimeStamp: nullableNumber(value.sourceTimeStamp), wallTimeMs: number(value.wallTimeMs), unixTimeMs: number(value.unixTimeMs),
    cocosSimulate: typeof value.cocosSimulate === 'boolean' ? value.cocosSimulate : null, delivery: text(value.delivery, 40) as InputObservationRecord['delivery'],
    context: copyContext(value.context), lastAfterDraw: copyDraw(value.lastAfterDraw),
});

/** Only the explicit query value "1" enables observation; other launch data is never retained. */
export function inputObservationRequested(browserValue: unknown, launchQuery: unknown): boolean {
    if (browserValue === '1') return true;
    return !!launchQuery && typeof launchQuery === 'object'
        && (launchQuery as Record<string, unknown>).diagnosticInput === '1';
}

export class InputObservation {
    readonly capacity = 96;
    readonly maxExportChars = 196608;
    private nextSequence = 0;
    private readonly records: InputObservationRecord[] = [];
    private counts = { cocosTouchStart: 0, cocosTouchEnd: 0, cocosTouchCancel: 0,
        cocosMouseCancel: 0, cocosUnsimulatedCancel: 0, cocosUnknownCancel: 0,
        gameHide: 0, gameShow: 0, wechatTouchCancel: 0 };
    private nativeCancel: NativeCancelObservation;
    private lastAfterDraw: InputAfterDraw | null = null;

    constructor(readonly enabled: boolean, readonly build: string) {
        this.nativeCancel = enabled ? 'not-wechat' : 'disabled';
    }

    setNativeCancelObservation(status: NativeCancelObservation): void {
        if (this.enabled) this.nativeCancel = status;
    }

    record(value: Observation): void {
        if (!this.enabled) return;
        const entry = copyRecord({ ...value, sequence: ++this.nextSequence,
            // Native IDs are observed only; invalid/missing IDs are not invented.
            pointerIds: value.pointerIds.slice(0, 16).filter(Number.isSafeInteger),
            sourceTimeStamp: Number.isFinite(value.sourceTimeStamp) ? value.sourceTimeStamp : null,
            delivery: value.source === 'wechat-platform' ? 'wechat-platform-callback'
                : value.source === 'cocos-game' ? 'lifecycle'
                    : value.cocosSimulate === true ? 'mouse-simulated'
                        : value.cocosSimulate === false ? 'cocos-touch-unsimulated' : 'unknown',
            context: value.context, lastAfterDraw: this.lastAfterDraw });
        // before/after are two observations of one delivered Cocos callback.
        if (value.phase !== 'after') {
            if (value.source === 'cocos-input') {
                if (value.kind === 'touch-start') this.counts.cocosTouchStart++;
                if (value.kind === 'touch-end') this.counts.cocosTouchEnd++;
                if (value.kind === 'touch-cancel') {
                    this.counts.cocosTouchCancel++;
                    if (value.cocosSimulate === true) this.counts.cocosMouseCancel++;
                    else if (value.cocosSimulate === false) this.counts.cocosUnsimulatedCancel++;
                    else this.counts.cocosUnknownCancel++;
                }
            } else if (value.source === 'cocos-game') {
                if (value.kind === 'game-hide') this.counts.gameHide++;
                if (value.kind === 'game-show') this.counts.gameShow++;
            } else if (value.source === 'wechat-platform' && value.kind === 'touch-cancel') this.counts.wechatTouchCancel++;
        }
        this.records.push(entry);
        if (this.records.length > this.capacity) this.records.shift();
    }

    snapshot() {
        return { enabled: this.enabled, build: text(this.build, 128), capacity: this.capacity,
            totalRecords: this.nextSequence, droppedRecords: Math.max(0, this.nextSequence - this.records.length),
            nativeCancelObservation: text(this.nativeCancel, 32) as NativeCancelObservation, counts: { ...this.counts },
            records: this.records.map(copyRecord), lastAfterDraw: copyDraw(this.lastAfterDraw) };
    }

    /** One latest render-submission observation, not a frame log or proof of screen presentation. */
    observeAfterDraw(wallTimeMs: number, unixTimeMs: number, context: InputObservationContext): void {
        if (!this.enabled) return;
        this.lastAfterDraw = copyDraw({ source: 'Director.EVENT_AFTER_DRAW', screenPresentationVerified: false,
            wallTimeMs, unixTimeMs, page: context.page, hidden: context.hidden, sessionId: context.sessionId,
            nowMs: context.nowMs, paused: context.paused, fighters: context.fighters });
    }

    /** Explicit user export; unknown fields and launch/system/account data never enter this schema. */
    serialize(current: InputObservationContext, wallTimeMs: number, unixTimeMs: number): string | null {
        if (!this.enabled) return null;
        const payload = { schemaVersion: 1, build: text(this.build, 128),
            exportedWallTimeMs: number(wallTimeMs), exportedUnixTimeMs: number(unixTimeMs),
            afterDrawMeaning: 'Engine render submission observation; actual screen presentation is unverified.',
            current: copyContext(current), input: this.snapshot(), exportTrimmedRecords: 0 };
        let json = JSON.stringify(payload);
        while (json.length > this.maxExportChars && payload.input.records.length) {
            payload.input.records.shift(); payload.exportTrimmedRecords++;
            json = JSON.stringify(payload);
        }
        if (json.length > this.maxExportChars) throw new RangeError('Diagnostic export exceeds its character limit');
        return json;
    }
}
