import {
    _decorator, Component, Node, Camera, Canvas, UITransform, Layers, Color, Vec3,
    Label, Graphics,
    input, Input, EventTouch, game, Game, view, screen, ResolutionPolicy, sys, DirectionalLight, profiler, director, Director,
    resources, JsonAsset, Prefab, assetManager, Asset, Sprite, SpriteFrame, Texture2D,
} from 'cc';
import { ActionKind, AttackMode, BattleState, BattleEvent, DEFAULT_RULES } from './core/Battle';
import { LocalSession } from './session/LocalSession';
import { InputBridge } from './InputBridge';
import { ActiveSessionClock } from './ActiveSessionClock';
import { latestContact, contactText } from './Feedback';
import { BUILD_ID } from './BuildInfo';
import { FighterPose, Point } from './ParryMotion';
import { CharacterTimeline, presentationSide } from './CharacterTimeline';
import { CharacterView, CastManifest, RoleId } from './CharacterView';
import { CastCatalog, RoundSetup, RoundTicket, RoundGate, ROLE_IDS, createCastCatalog, makeRoundSetup, projectIntro, castResource } from './Cast';
import { ArenaView } from './ArenaView';
import { LayoutRect, layoutFromUiSafeRect } from './GameLayout';
import { InputObservation, InputObservationContext, InputObservationKind, InputObservationSource, inputObservationRequested } from './InputObservation';

const { ccclass } = _decorator;
type Page = 'menu' | 'practice' | 'loading' | 'intro' | 'battle' | 'paused' | 'confirm' | 'result' | 'error' | 'clip-qa';
type Practice = 'normal' | 'hit' | 'block' | 'parry';
type Button = { transform: UITransform; label: Label; name: string; action: () => void };
type ContactFrame = {
    stage: 'guard-raise' | 'parry-catch' | 'counter-dip' | 'counter-rise' | 'counter-hit'; actorId: number;
    nowMs: number; hp: number[]; phases: string[]; events: BattleEvent[];
    width: number; height: number; image?: string; error?: string;
};
type WechatCancelEvent = { changedTouches?: { identifier?: number }[]; timeStamp?: number };
type WechatInputObservationApi = {
    getLaunchOptionsSync?: () => { query?: unknown };
    onTouchCancel?: (listener: (event: WechatCancelEvent) => void) => void;
    offTouchCancel?: (listener: (event: WechatCancelEvent) => void) => void;
};
type DiagnosticClipboardApi = {
    setClipboardData?: (options: { data: string; success: () => void; fail: () => void }) => void;
};
const C = { bg: '#16232C', panel: '#293C48', ink: '#F5F4EF', gold: '#FFD166', blue: '#73C5D5', orange: '#E6A17A', danger: '#F47C7C' };
const POSITIVE_PREVIEW: Record<RoleId, string> = {
    manager: '表达有条理，善于组织信息、清晰汇报。',
    veteran: '经验丰富，评估全面，考虑周到。',
    rookie: '有干劲，积极迎接新任务。',
};
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const QA_CLIPS=['idle','intro-positive','intro-negative','charge','attack-light','attack-heavy','recovery','guard','hit','counter','counter-recovery','victory','defeat'] as const;

/** Presentation only: snapshots drive poses; semantic events drive feedback. */
@ccclass('SlapGame')
export class SlapGame extends Component {
    private page: Page = 'menu';
    private mode: AttackMode = 'charge';
    private practice: Practice = 'normal';
    private session: LocalSession | null = null;
    private activeClock = new ActiveSessionClock(() => performance.now());
    private resultVisualMs = 0;
    private skipVisualFrame = false;
    private sequence = 0;
    private round = 0;
    private ui!: Node;
    private world!: Node;
    private worldCamera!: Camera;
    private width = 720;
    private height = 1280;
    private landscape = false;
    private layout = layoutFromUiSafeRect({ width: 720, height: 1280 }, { x: 0, y: 0, width: 720, height: 1280 }, { x: .5, y: .5 });
    private buttons: Button[] = [];
    private bridge = new InputBridge(action => this.submit(action));
    private attack: UITransform | null = null;
    private guard: UITransform | null = null;
    private attackPanel: Graphics | null = null;
    private guardPanel: Graphics | null = null;
    private attackAvailable: boolean | null = null;
    private guardAvailable: boolean | null = null;
    private attackLabel: Label | null = null;
    private guardLabel: Label | null = null;
    private statusLabel: Label | null = null;
    private hpLabels: Label[] = [];
    private hpBars: Graphics[] = [];
    private chargeBar: Graphics | null = null;
    private resultLabel: Label | null = null;
    private timerLabel: Label | null = null;
    private characterView = new CharacterView();
    private cast: CastManifest[] = [];
    private catalog: CastCatalog | null = null;
    private roundSetup: RoundSetup | null = null;
    private roundGate = new RoundGate();
    private introViewer: 0 | 1 = 0;
    private diagnosticIntro = false;
    private playerStation: 0|1 = 0;
    private clipQaReady=false;
    private clipQaIndex=0;
    private clipQaTime=0;
    private clipQaPlaying=false;
    private clipQaClose=false;
    private clipQaLabel: Label|null=null;
    private startupError = '';
    private selectedRole: RoleId = 'manager';
    private opponentRole: RoleId = 'manager';
    private roleTextures = new Map<RoleId, Texture2D>();
    private loadingAssets = new Map<string, Promise<Asset>>();
    private ownedAssets = new Set<Asset>();
    private portraitFrames: SpriteFrame[] = [];
    private loadGeneration = 0;
    private castError = '';
    private catalogGeneration = 0;
    private pendingSkinState: BattleState | null = null;
    private pendingPoses: [FighterPose, FighterPose] | null = null;
    private arena: ArenaView | null = null;
    private seenEvents = new Set<string>();
    private motion = new CharacterTimeline();
    private feedback = '';
    private feedbackUntil = 0;
    private feedbackColor = C.ink;
    private trace: BattleEvent[] = [];
    private ready = false;
    private hidden = false;
    private frameUpdates = 0;
    private frameFirstWallMs: number | null = null;
    private frameLastWallMs: number | null = null;
    private frameTotalDtMs = 0;
    private frameMinDtMs: number | null = null;
    private frameMaxDtMs: number | null = null;
    private frameRecentDtMs: number[] = [];
    private frameDiagnosticCanvas: HTMLElement | null = null;
    private motionDiagnosticCanvas: HTMLElement | null = null;
    private motionSamples: { nowMs: number; visualElapsedMs: number; poses: [FighterPose, FighterPose]; actual: { leadPalm: Point; rearPalm: Point; cheek: Point; head: Point }[] }[] = [];
    private motionFrameState: BattleState | null = null;
    private contactFrames: ContactFrame[] = [];
    private resultFrames: { stage: string; state: BattleState; visualElapsedMs: number; cast: ReturnType<CharacterView['evidence']>; width: number; height: number; image?: string; error?: string }[] = [];
    private framePublishedWallMs = -Infinity;
    private diagnosticStart: 'slow' | 'fail-once' | null = null;
    private diagnosticStartFailed = false;
    private diagnosticRole: string | null = null;
    private inputObservation = new InputObservation(false, BUILD_ID);
    private inputDiagnosticHud: Label | null = null;
    private inputDiagnosticCanvas: HTMLElement | null = null;
    private inputDiagnosticPublishedMs = -Infinity;
    private inputAfterDrawSubscribed = false;
    private inputDiagnosticDisposed = false;
    private inputDiagnosticCopyBusy = false;
    private inputDiagnosticCopyStatus = '';
    private inputDiagnosticCopyLabel: Label | null = null;
    private inputDiagnosticPanelActive = false;
    private inputDiagnosticCopyGeneration = 0;
    private wechatInputObservationApi: WechatInputObservationApi | null = null;
    private readonly observeWechatCancel = (event: WechatCancelEvent): void => {
        try {
            this.observeInput('wechat-platform', 'touch-cancel', 'callback', 'wx.onTouchCancel',
                (event.changedTouches ?? []).flatMap(t => typeof t.identifier === 'number' ? [t.identifier] : []), event.timeStamp ?? null);
        } catch { /* Malformed diagnostic payload must not affect other platform listeners. */ }
    };

    onLoad(): void {
        profiler.hideStats();
        let browserInputDiagnostic: unknown;
        if (sys.isBrowser && typeof document !== 'undefined') {
            const query = new URLSearchParams(window.location.search);
            browserInputDiagnostic = query.get('diagnosticInput');
            const fps = query.get('diagnosticFps');
            if (fps !== null && ['15', '30', '60'].includes(fps)) {
                this.frameDiagnosticCanvas = document.getElementById('GameCanvas');
            }
            if (query.get('diagnosticMotion') === '1') this.motionDiagnosticCanvas = document.getElementById('GameCanvas');
            // Presentation-only QA: logical commands and Bot ownership stay 0/1.
            if(query.get('diagnosticMotion')==='1'&&query.get('diagnosticStation')==='1') this.playerStation=1;
            if(query.get('diagnosticMotion')==='1'&&query.get('diagnosticClips')==='1') this.page='clip-qa';
            this.diagnosticIntro = query.get('diagnosticIntro') === '1';
            if (this.diagnosticIntro) {
                this.motionDiagnosticCanvas = document.getElementById('GameCanvas');
                this.introViewer = query.get('viewer') === '1' ? 1 : 0;
                this.diagnosticRole = query.get('diagnosticRole');
            }
            const startup = query.get('diagnosticStart');
            if (startup === 'slow' || startup === 'fail-once') this.diagnosticStart = startup;
        }
        this.prepareInputObservation(browserInputDiagnostic);
        this.buildWorld();
        this.buildCanvas();
        this.resize();
        input.on(Input.EventType.TOUCH_START, this.touchStart, this);
        input.on(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        game.on(Game.EVENT_HIDE, this.hide, this);
        game.on(Game.EVENT_SHOW, this.show, this);
        view.on('canvas-resize', this.resize, this);
        this.ready = true;
        this.loadCast();
        if (this.motionDiagnosticCanvas) director.on(Director.EVENT_AFTER_DRAW, this.captureContactFrame, this);
        // Read-only diagnostics help tie runtime evidence to this exact build.
        (globalThis as unknown as Record<string, unknown>).__SLAP_DEBUG__ = {
            build: BUILD_ID,
            inspect: () => ({ page: this.page, mode: this.mode, practice: this.practice, playerStation:this.playerStation,
                setup: this.roundSetup, viewerActorId: this.introViewer,
                state: this.session?.snapshot() ?? null, visualElapsedMs: this.resultVisualMs, events: this.trace.map(e => ({ ...e })), cast: this.skinEvidence(),
                frames: this.frameDiagnostics(), input: this.inputObservation.snapshot() }),
        };
    }

    private prepareInputObservation(browserValue: unknown): void {
        const api = (globalThis as unknown as { wx?: WechatInputObservationApi }).wx;
        let launchQuery: unknown;
        // Read only this named launch flag; never retain scene/query/account data.
        try { launchQuery = api?.getLaunchOptionsSync?.().query; } catch { /* No launch evidence available. */ }
        this.inputObservation = new InputObservation(inputObservationRequested(browserValue, launchQuery), BUILD_ID);
        if (!this.inputObservation.enabled) return;
        director.on(Director.EVENT_AFTER_DRAW, this.observeInputAfterDraw, this);
        this.inputAfterDrawSubscribed = true;
        if (sys.isBrowser && typeof document !== 'undefined') this.inputDiagnosticCanvas = document.getElementById('GameCanvas');
        if (!api) return;
        // Only subscribe where the identical observer can be removed. The engine's listener is untouched.
        if (typeof api.onTouchCancel !== 'function' || typeof api.offTouchCancel !== 'function') {
            this.inputObservation.setNativeCancelObservation('unavailable-off-api'); return;
        }
        try {
            api.onTouchCancel(this.observeWechatCancel);
            this.wechatInputObservationApi = api;
            this.inputObservation.setNativeCancelObservation('observing');
        } catch { this.inputObservation.setNativeCancelObservation('registration-failed'); }
    }

    private inputObservationContext(): InputObservationContext {
        const state = this.session?.snapshot();
        return { page: this.page, mode: this.mode, practice: this.practice, hidden: this.hidden,
            sessionId: state?.sessionId ?? null, nowMs: state?.nowMs ?? null, paused: this.session?.paused ?? null,
            commandSequence: this.sequence,
            fighters: state?.fighters.map(f => ({ hp: f.hp, phase: f.phase, chargeStartMs: f.chargeStartMs,
                contactAtMs: f.contactAtMs, guardCharges: f.guardCharges })) ?? [],
            recentEvents: this.trace.slice(-8).map(e => ({ id: e.id, kind: e.kind, atMs: e.atMs,
                actorId: e.actorId, targetId: e.targetId, damage: e.damage })) };
    }

    private observeInputAfterDraw(): void {
        if (!this.inputObservation.enabled || this.inputDiagnosticDisposed) return;
        try {
            this.inputObservation.observeAfterDraw(performance.now(), Date.now(), this.inputObservationContext());
        } catch { /* Optional render-submission observation must never affect the game. */ }
    }

    private copyInputDiagnostic(): void {
        if (!this.inputObservation.enabled || this.inputDiagnosticDisposed || this.page !== 'paused' || this.inputDiagnosticCopyBusy) return;
        const feedback = (message: string): void => {
            if (!this.inputObservation.enabled || this.inputDiagnosticDisposed) return;
            this.inputDiagnosticCopyStatus = message;
            if (this.inputDiagnosticCopyLabel?.isValid) this.inputDiagnosticCopyLabel.string = message;
        };
        const generation = this.inputDiagnosticCopyGeneration;
        let settled = false;
        const finish = (message: string): void => {
            if (settled || this.inputDiagnosticDisposed || !this.inputObservation.enabled || generation !== this.inputDiagnosticCopyGeneration) return;
            settled = true; this.inputDiagnosticCopyBusy = false; feedback(message);
        };
        try {
            const data = this.inputObservation.serialize(this.inputObservationContext(), performance.now(), Date.now());
            if (data === null) return;
            this.inputDiagnosticCopyBusy = true; feedback('正在复制诊断…');
            const api = (globalThis as unknown as { wx?: DiagnosticClipboardApi }).wx;
            if (typeof api?.setClipboardData === 'function') {
                api.setClipboardData({ data, success: () => finish('诊断已复制，可粘贴发回。'), fail: () => finish('复制失败，请重试。') });
            } else if (sys.isBrowser && typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
                void navigator.clipboard.writeText(data).then(() => finish('诊断已复制，可粘贴发回。'), () => finish('复制失败，请重试。'));
            } else finish('当前环境无法复制诊断。');
        } catch { finish('复制失败，请重试。'); }
    }

    private observeInput(source: InputObservationSource, kind: InputObservationKind, phase: 'before' | 'after' | 'callback',
        reportedType: string, pointerIds: number[] = [], sourceTimeStamp: number | null = null, cocosSimulate: boolean | null = null): void {
        if (!this.inputObservation.enabled || this.inputDiagnosticDisposed) return;
        try {
            this.inputObservation.record({ source, kind, phase, reportedType, pointerIds, sourceTimeStamp, cocosSimulate,
                wallTimeMs: performance.now(), unixTimeMs: Date.now(), context: this.inputObservationContext() });
            this.publishInputObservation(true);
        } catch { /* Observation must never change input handling or match state. */ }
    }

    private publishInputObservation(force = false): void {
        if (!this.inputObservation.enabled || this.inputDiagnosticDisposed) return;
        try {
            const wallMs = performance.now();
            if (!force && wallMs - this.inputDiagnosticPublishedMs < 100) return;
            this.inputDiagnosticPublishedMs = wallMs;
            const observed = this.inputObservation.snapshot();
            if (this.inputDiagnosticHud && this.inputDiagnosticHud.isValid) {
                const last = observed.records[observed.records.length - 1];
                this.inputDiagnosticHud.string = `取消 C:${observed.counts.cocosTouchCancel} /鼠${observed.counts.cocosMouseCancel} /触${observed.counts.cocosUnsimulatedCancel} /未知${observed.counts.cocosUnknownCancel} /wx${observed.counts.wechatTouchCancel}\n`
                    + `隐/显 ${observed.counts.gameHide}/${observed.counts.gameShow} · ${last ? `${last.kind}/${last.phase} · ${last.delivery}` : '尚无输入事件'}\n`
                    + `${BUILD_ID} · 微信观测 ${observed.nativeCancelObservation}`;
                this.inputDiagnosticHud.node.setPosition(this.layout.safe.centerX, this.layout.safe.centerY, 0);
                this.inputDiagnosticHud.node.getComponent(UITransform)!.setContentSize(Math.max(1, this.layout.safe.width - 24), 116);
                // Passive Label only: no button, BlockInputEvents, hit rectangle or command callback.
                this.inputDiagnosticHud.node.setSiblingIndex(this.ui.children.length - 1);
            }
            this.inputDiagnosticCanvas?.setAttribute('data-slap-input', JSON.stringify(observed));
        } catch { /* HUD/DOM observations are optional and cannot interrupt a match. */ }
    }

    private frameDiagnostics() {
        return { targetFps: game.frameRate, updates: this.frameUpdates,
            firstWallMs: this.frameFirstWallMs, lastWallMs: this.frameLastWallMs,
            wallNowMs: performance.now(), totalDtMs: this.frameTotalDtMs,
            minDtMs: this.frameMinDtMs, maxDtMs: this.frameMaxDtMs,
            recentDtMs: this.frameRecentDtMs.slice(), hidden: this.hidden };
    }

    /** Capture the engine's actual canvas after drawing, only with the explicit diagnostic query. */
    private captureContactFrame(): void {
        if (this.page === 'result') { this.captureResultFrame(); return; }
        if (!this.motionDiagnosticCanvas || this.page !== 'battle' || this.contactFrames.length >= 5 || !this.motionFrameState) return;
        const state = this.motionFrameState;
        let stage: ContactFrame['stage'] | null = null, actorId = -1;
        for (let i = 0; i < 2; i++) {
            const f = state.fighters[i], age = state.nowMs - f.phaseStartMs;
            if (f.phase === 'counter-recovery') { stage = 'counter-hit'; actorId = i; break; }
            if (f.phase === 'counter') {
                stage = age >= DEFAULT_RULES.counterWindupMs * 0.65 ? 'counter-rise'
                    : age >= DEFAULT_RULES.counterWindupMs * .25 ? 'counter-dip' : 'parry-catch'; actorId = i; break;
            }
            if (f.phase === 'guard' && age > 0 && stage === null) { stage = 'guard-raise'; actorId = i; }
        }
        if (stage === null || this.contactFrames.some(frame => frame.stage === stage)) return;
        const canvas = this.motionDiagnosticCanvas as HTMLCanvasElement;
        const frame: ContactFrame = { stage, actorId, nowMs: state.nowMs,
            hp: state.fighters.map(f => f.hp), phases: state.fighters.map(f => f.phase),
            events: this.trace.filter(e => e.kind === 'parry' || e.kind === 'counter-hit' || e.kind === 'attack-start').map(e => ({ ...e })),
            width: canvas.width, height: canvas.height };
        try {
            const data = canvas.toDataURL('image/jpeg', 0.88);
            if (!data.startsWith('data:image/jpeg;base64,') || data.length < 64) throw new Error('Canvas readback returned no JPEG');
            frame.image = data;
        } catch (error) { frame.error = error instanceof Error ? error.message : 'Canvas readback failed'; }
        this.contactFrames.push(frame);
        // Encode at most five times per session. The images never feed back into gameplay.
        canvas.setAttribute('data-slap-contact-frames', JSON.stringify({ build: BUILD_ID, sessionId: state.sessionId,
            mode: this.mode, practice: this.practice, source: 'Cocos Director.EVENT_AFTER_DRAW canvas.toDataURL', frames: this.contactFrames }));
    }

    private clearContactFrames(): void {
        this.motionFrameState = null; this.contactFrames = [];
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-contact-frames');
        this.resultFrames = [];
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-result-frames');
    }

    private captureResultFrame(): void {
        if (!this.motionDiagnosticCanvas || !this.session || this.hidden || this.resultFrames.length >= 3) return;
        const stage = this.resultVisualMs >= 900 ? 'settled' : this.resultVisualMs >= 450 ? 'settling' : 'start';
        if (this.resultFrames.some(frame => frame.stage === stage)) return;
        const canvas = this.motionDiagnosticCanvas as HTMLCanvasElement;
        const frame: typeof this.resultFrames[number] = { stage, state: this.session.snapshot(), visualElapsedMs: this.resultVisualMs,
            cast: this.skinEvidence(), width: canvas.width, height: canvas.height };
        try { frame.image = canvas.toDataURL('image/jpeg', .88); }
        catch (error) { frame.error = error instanceof Error ? error.message : 'Canvas result readback failed'; }
        this.resultFrames.push(frame);
        canvas.setAttribute('data-slap-result-frames', JSON.stringify({ build: BUILD_ID, mode: this.mode, practice: this.practice,
            source: 'Cocos Director.EVENT_AFTER_DRAW canvas.toDataURL', frames: this.resultFrames }));
    }

    private publishFrameDiagnostics(wallMs: number): void {
        if (!this.frameDiagnosticCanvas || wallMs - this.framePublishedWallMs < 1000) return;
        this.framePublishedWallMs = wallMs;
        const state = this.session?.snapshot();
        // A DOM-readable observation for isolated browser inspection contexts.
        // Never read this attribute back into gameplay; no command API is added.
        this.frameDiagnosticCanvas.setAttribute('data-slap-diagnostics', JSON.stringify({
            build: BUILD_ID, page: this.page, mode: this.mode, practice: this.practice,
            setup: this.roundSetup, viewerActorId: this.introViewer,
            frames: this.frameDiagnostics(),
            state: state ? { sessionId: state.sessionId, nowMs: state.nowMs, result: state.result,
                fighters: state.fighters.map(f => ({ hp: f.hp, phase: f.phase, guardCharges: f.guardCharges })) } : null,
        }));
    }

    private buildWorld(): void {
        this.world = new Node('SlapWorld');
        this.node.addChild(this.world);
        const cameraNode = new Node('WorldCamera');
        this.world.addChild(cameraNode);
        // Human proportions keep smaller heads than the technical v1 figures.
        // Frame the face/palm exchange more closely while retaining both sides.
        cameraNode.setPosition(0, 2.55, 5.5);
        cameraNode.lookAt(new Vec3(0, 1.4, 0));
        const camera = cameraNode.addComponent(Camera);
        this.worldCamera = camera;
        camera.projection = Camera.ProjectionType.PERSPECTIVE;
        camera.fovAxis = Camera.FOVAxis.VERTICAL;
        camera.fov = 39;
        camera.near = 0.1;
        camera.far = 100;
        camera.priority = 0;
        camera.visibility = Layers.Enum.DEFAULT;
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(C.bg);
        const lightNode = new Node('KeyLight');
        this.world.addChild(lightNode);
        lightNode.setRotationFromEuler(-45, -30, 0);
        lightNode.addComponent(DirectionalLight);
        this.arena = new ArenaView(this.world);
        // Characters are imported skinned assets. Missing resources use the error path.
    }

    private loadAsset<T extends Asset>(uuid: string): Promise<T> {
        if (!uuid || !/^[a-zA-Z0-9@-]+$/.test(uuid)) return Promise.reject(new Error('Missing imported character reference'));
        let promise = this.loadingAssets.get(uuid);
        if (!promise) {
            promise = new Promise<Asset>((resolve, reject) => assetManager.loadAny<Asset>(uuid, (error, value) => {
                if (error) { reject(error); return; }
                value.addRef();
                if (!this.isValid) { value.decRef(); reject(new Error('Character owner disposed')); return; }
                this.ownedAssets.add(value); resolve(value);
            }));
            this.loadingAssets.set(uuid, promise);
            promise.catch(() => this.loadingAssets.delete(uuid));
        }
        return promise as Promise<T>;
    }

    private loadCast(): void {
        const token = ++this.catalogGeneration;
        void (async () => {
            try {
                const catalog = await Promise.all(ROLE_IDS.map(role => new Promise<CastManifest>((resolve, reject) => {
                    resources.load(castResource(role).manifestPath, JsonAsset, (error, asset) => {
                        if (error) { reject(error); return; }
                        if (!this.isValid || token !== this.catalogGeneration) { reject(new Error('Catalog owner disposed')); return; }
                        if (!this.ownedAssets.has(asset)) { asset.addRef(); this.ownedAssets.add(asset); }
                        resolve(asset.json as CastManifest);
                    });
                })));
                if (!this.isValid || token !== this.catalogGeneration) return;
                const validated = createCastCatalog(catalog);
                const textures = new Map<RoleId, Texture2D>();
                for (const manifest of catalog) {
                    const refs = manifest.generated?.imports;
                    if (!refs?.prefabUuid || !refs.skeletonUuid || !refs.portraitTextureUuid || Object.keys(refs.bonePaths).length !== 29) throw new Error('Character import references incomplete');
                    const texture = await this.loadAsset<Texture2D>(refs.portraitTextureUuid);
                    if (!this.isValid || token !== this.catalogGeneration) return;
                    textures.set(manifest.source.roleId, texture);
                }
                this.cast = catalog; this.catalog = validated; this.roleTextures = textures; this.castError = '';
            } catch (failure) {
                if (!this.isValid || token !== this.catalogGeneration) return;
                this.cast = []; this.catalog = null; this.castError = failure instanceof Error ? failure.message : 'Character loading failed'; console.error(this.castError);
            }
            if(this.page==='clip-qa'&&this.cast.length) await this.prepareClipQa();
            if (this.page === 'menu'||this.page==='clip-qa') this.renderPage();
        })();
    }

    private clearActors(): void {
        this.pendingSkinState = null; this.pendingPoses = null; this.characterView.clear();
    }

    private async prepareActors(ticket: RoundTicket): Promise<void> {
        const setup = ticket.setup;
        const manifests = setup.actors.map(actor => this.cast.find(m => m.source.roleId === actor.roleId && m.generated.sourceHash === actor.sourceHash));
        if (manifests.some(m => !m)) throw new Error(this.castError || 'Character assets are still loading');
        const templates = await Promise.all(manifests.map(m => this.loadAsset<Prefab>(m!.generated.imports.prefabUuid)));
        if (!this.isValid || !this.roundGate.isCurrent(ticket) || setup !== this.roundSetup) return;
        this.clearActors();
        this.characterView.prepare(this.world, manifests as CastManifest[], templates, this.playerStation);
    }

    private sampleActors(state: BattleState): void {
        const samples = this.motion.sample(state, state.nowMs, this.resultVisualMs, this.playerStation);
        this.pendingPoses = samples.map(sample => sample.pose) as [FighterPose, FighterPose];
        this.characterView.sample(samples);
    }

    private skinEvidence() { return this.characterView.evidence(); }

    private async prepareClipQa(): Promise<void> {
        const token=++this.loadGeneration, manifest=this.cast.find(m=>m.source.roleId==='manager');
        if(!manifest) return;
        try {
            const template=await this.loadAsset<Prefab>(manifest.generated.imports.prefabUuid);
            if(!this.isValid||token!==this.loadGeneration||this.page!=='clip-qa') return;
            this.clearActors();this.characterView.prepare(this.world,[manifest,manifest],[template,template],this.playerStation);this.clipQaReady=true;
        } catch(error) {this.startupError=error instanceof Error?error.message:'动作资源加载失败';}
    }

    private clipQaUI(): void {
        const l=this.layout, top=this.height/2;
        this.panelAt(l.box(0,top-65,this.width+32,130),C.bg);
        this.panelAt(l.box(0,-top+(this.landscape?54:100),this.width+32,this.landscape?108:200),C.bg);
        this.labelAt('动作资源检查 · 非对局',l.box(0,top-32,this.width-32,48),32,C.gold);
        this.clipQaLabel=this.labelAt('',l.box(0,top-91,this.width-32,62),22);
        const operations:[string,()=>void][]=[
            ['上一动作',()=>{this.clipQaIndex=(this.clipQaIndex+QA_CLIPS.length-1)%QA_CLIPS.length;this.clipQaTime=0;this.clipQaPlaying=false;this.renderPage();}],
            ['下一动作',()=>{this.clipQaIndex=(this.clipQaIndex+1)%QA_CLIPS.length;this.clipQaTime=0;this.clipQaPlaying=false;this.renderPage();}],
            [this.clipQaPlaying?'暂停播放':'播放',()=>{this.clipQaPlaying=!this.clipQaPlaying;this.renderPage();}],
            ['起始姿势',()=>{this.clipQaTime=0;this.clipQaPlaying=false;this.renderPage();}],
            ['末尾姿势',()=>{this.clipQaTime=1;this.clipQaPlaying=false;this.renderPage();}],
            [this.clipQaClose?'全身视角':'脸手近景',()=>{this.clipQaClose=!this.clipQaClose;this.setClipQaCamera(this.clipQaClose);this.renderPage();}],
            ['返回选择',()=>{this.clipQaReady=false;this.backToMenu();}],
        ];
        const columns=this.landscape?7:3, cell=(this.width-32)/columns;
        operations.forEach(([name,action],index)=>this.buttonAt(name,l.target(-this.width/2+16+cell*(index%columns+.5),-top+54+Math.floor(index/columns)*88,cell-8,80),action));
    }

    private setClipQaCamera(close: boolean): void {
        if(!this.worldCamera) return;
        this.worldCamera.node.setPosition(0,close?2.05:2.55,close?2.25:5.5);
        this.worldCamera.node.lookAt(new Vec3(0,close?1.85:1.4,0));
    }

    lateUpdate(): void {
        if(this.page==='clip-qa'&&this.clipQaReady) {
            this.characterView.observePreview();
            this.motionDiagnosticCanvas?.setAttribute('data-slap-clip-qa',JSON.stringify({build:BUILD_ID,page:this.page,roleId:'manager',playerStation:this.playerStation,
                clip:QA_CLIPS[this.clipQaIndex],normalizedTime:this.clipQaTime,duration:this.characterView.clipDuration(QA_CLIPS[this.clipQaIndex]),playing:this.clipQaPlaying,camera:this.clipQaClose?'upper':'full',
                session:null,events:[],cast:this.skinEvidence()}));
            return;
        }
        const state = this.pendingSkinState, poses = this.pendingPoses;
        if (!state || !poses || this.characterView.count !== 2) return;
        this.characterView.correct(state);
        if (this.motionDiagnosticCanvas && (this.page === 'battle' || this.page === 'result')) {
            this.motionSamples.push({ nowMs: state.nowMs, visualElapsedMs: this.resultVisualMs, poses, actual: this.characterView.measurements() });
            if (this.motionSamples.length > 120) this.motionSamples.shift();
            this.motionDiagnosticCanvas.setAttribute('data-slap-motion', JSON.stringify({ build: BUILD_ID, page: this.page, mode: this.mode, practice: this.practice,playerStation:this.playerStation,
                state, visualElapsedMs: this.resultVisualMs, events: this.trace, samples: this.motionSamples, cast: this.skinEvidence() }));
        }
    }

    private buildCanvas(): void {
        this.ui = new Node('SlapUI');
        this.node.addChild(this.ui);
        this.ui.layer = Layers.Enum.UI_2D;
        this.ui.addComponent(UITransform).setContentSize(720, 1280);
        const canvas = this.ui.addComponent(Canvas);
        const cameraNode = new Node('UICamera');
        this.node.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.projection = Camera.ProjectionType.ORTHO;
        camera.near = 1;
        camera.far = 2000;
        camera.priority = 100;
        camera.visibility = Layers.Enum.UI_2D;
        camera.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
        canvas.cameraComponent = camera;
        canvas.alignCanvasWithScreen = true;
        if (this.inputObservation.enabled) {
            this.inputDiagnosticHud = this.text('', 0, 0, 680, 20, C.gold, 116);
            this.inputDiagnosticHud.node.name = 'InputObservationHud';
            this.inputDiagnosticHud.lineHeight = 31;
        }
    }

    private resize(): void {
        if (!this.ui) return;
        // Reflow has no input meaning. Real TOUCH_CANCEL and lifecycle paths
        // retain pointer cancellation; resizing alone must not submit a command.
        // Only the aspect ratio is used, so screen's physical pixels are DPR-independent here.
        const frame = screen.windowSize;
        this.landscape = frame.width > frame.height;
        this.width = this.landscape ? 1280 : 720;
        this.height = this.landscape ? 720 : 1280;
        // The 3D camera covers the whole screen, unlike the letterboxed UI.
        // Preserve the 9:16 composition's horizontal field of view on taller
        // phones so heads and hands cannot disappear beyond the side edges.
        const aspect = frame.width / Math.max(1, frame.height);
        const horizontalFit = Math.max(1, (720 / 1280) / Math.max(0.01, aspect));
        this.worldCamera.fov = Math.atan(Math.tan(39 * Math.PI / 360) * horizontalFit) * 360 / Math.PI;
        view.setDesignResolutionSize(this.width, this.height, ResolutionPolicy.SHOW_ALL);
        // In Creator3.8.8 sys already calls view._convertToUISpace. Its rect
        // must be clipped in design space, never divided by scale a second time.
        this.layout = layoutFromUiSafeRect({ width: this.width, height: this.height }, sys.getSafeAreaRect(false), {
            x: view.getScaleX() / screen.devicePixelRatio, y: view.getScaleY() / screen.devicePixelRatio,
        });
        this.ui.getComponent(UITransform)!.setContentSize(this.width, this.height);
        this.renderPage();
        this.publishInputObservation(true);
    }

    private uiNode(name: string, x: number, y: number, w: number, h: number): Node {
        const node = new Node(name);
        this.ui.addChild(node);
        node.layer = Layers.Enum.UI_2D;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(w, h);
        return node;
    }

    private text(value: string, x: number, y: number, width = 640, size = 32, color = C.ink, height = 64): Label {
        const node = this.uiNode('Text', x, y, width, height);
        const label = node.addComponent(Label);
        label.useSystemFont = true;
        label.fontFamily = 'Microsoft YaHei';
        label.fontSize = size;
        label.lineHeight = size * (size >= 40 ? 1.2 : 1.5);
        label.isBold = size >= 40;
        label.color = new Color(color);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.CLAMP;
        label.enableWrapText = true;
        label.string = value;
        return label;
    }

    private panel(x: number, y: number, width: number, height: number, color = C.panel): Graphics {
        const node = this.uiNode('Panel', x, y, width, height);
        const g = node.addComponent(Graphics);
        g.fillColor = new Color(color);
        g.roundRect(-width / 2, -height / 2, width, height, 16);
        g.fill();
        return g;
    }

    private button(value: string, x: number, y: number, width: number, action: () => void, primary = false, height = 96,
        style: 'normal' | 'selected' | 'danger' = 'normal'): Button {
        const fill = style === 'danger' ? C.danger : style === 'selected' ? C.panel : primary ? C.gold : C.panel;
        const panel = this.panel(x, y, width, height, fill);
        if (style === 'selected') {
            // Inset the stroke so the unchanged touch rectangle still contains it.
            const outline = this.uiNode('SelectionOutline', x, y, width, height).addComponent(Graphics);
            outline.lineWidth = 4;
            outline.strokeColor = new Color(C.gold);
            outline.roundRect(-width / 2 + 2, -height / 2 + 2, width - 4, height - 4, 14);
            outline.stroke();
        }
        const darkText = style === 'danger' || (primary && style !== 'selected');
        const label = this.text(value, x, y, width - 16, 32, darkText ? C.bg : C.ink, height - 8);
        label.enableWrapText = false;
        const button = { transform: panel.node.getComponent(UITransform)!, label, name: value, action };
        this.buttons.push(button);
        return button;
    }

    private labelAt(value: string, rect: LayoutRect, size = 32, color = C.ink): Label {
        return this.text(value, rect.x, rect.y, rect.width, size, color, rect.height);
    }
    private panelAt(rect: LayoutRect, color = C.panel): Graphics {
        return this.panel(rect.x, rect.y, rect.width, rect.height, color);
    }
    private buttonAt(value: string, rect: LayoutRect, action: () => void, primary = false,
        style: 'normal' | 'selected' | 'danger' = 'normal'): Button {
        return this.button(value, rect.x, rect.y, rect.width, action, primary, rect.height, style);
    }

    private changePage(page: Page): void { this.page = page; this.renderPage(); }

    private portrait(role: RoleId, x: number, y: number, size: number): void {
        const texture = this.roleTextures.get(role);
        if (!texture) return;
        const node = this.uiNode('CharacterPortrait', x, y, size, size);
        const sprite = node.addComponent(Sprite), frame = new SpriteFrame();
        frame.texture = texture; sprite.spriteFrame = frame; sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        // Attaching Sprite first resets the transform to the source texture's512px size.
        node.getComponent(UITransform)!.setContentSize(size, size);
        this.portraitFrames.push(frame);
    }

    private selectionUI(): void {
        const l = this.layout.menu;
        this.labelAt('掌上对决', l.title, 56);
        this.labelAt('选择你的人设', l.subtitle, 40);
        for (let i = 0; i < this.cast.length; i++) {
            const role = this.cast[i], id = role.source.roleId, selected = id === this.selectedRole;
            const card = this.buttonAt('', l.cards[i], () => { this.selectedRole = id; this.renderPage(); }, false, selected ? 'selected' : 'normal');
            card.name = `选择${role.source.displayName}${selected ? ' · 已选' : ''}`;
            const portrait = l.portraits[i]; this.portrait(id, portrait.x, portrait.y, Math.min(portrait.width, portrait.height));
            this.labelAt(`${role.source.displayName}${selected ? ' · 已选' : ''}`, l.names[i], 24, selected ? C.gold : C.ink);
            this.labelAt(POSITIVE_PREVIEW[id], l.summaries[i], 24);
        }
        if (!this.catalog) {
            this.text(this.castError ? '人设载入失败，请重试。' : '正在载入三个人设…', 0, 100, 640, 32);
            if (this.castError) this.button('重试载入', 0, -20, 440, () => this.loadCast(), true);
        }
        this.buttonAt(`蓄力出掌${this.mode === 'charge' ? ' · 已选' : ''}`, l.modes[0], () => { this.mode = 'charge'; this.renderPage(); }, false, this.mode === 'charge' ? 'selected' : 'normal');
        this.buttonAt(`点击出掌${this.mode === 'tap' ? ' · 已选' : ''}`, l.modes[1], () => { this.mode = 'tap'; this.renderPage(); }, false, this.mode === 'tap' ? 'selected' : 'normal');
        if (!this.landscape) this.labelAt('轻掌伤害1 · 按住1.2秒蓄满伤害2\n人物长处不改变攻防数值。', l.hint, 24);
        const opponent = this.cast.find(m => m.source.roleId === this.opponentRole);
        this.buttonAt(`对手：${opponent?.source.displayName ?? '准备中'} · 换人`, l.opponent, () => {
            const index = ROLE_IDS.indexOf(this.opponentRole); this.opponentRole = ROLE_IDS[(index + 1) % ROLE_IDS.length]; this.renderPage();
        });
        if (this.catalog) {
            this.buttonAt('开始对战', l.start, () => this.begin('normal'), true);
            this.buttonAt('练习攻防', l.practice, () => this.changePage('practice'));
        } else {
            this.panelAt(l.start, '#1D2C35'); this.labelAt('等待人设准备', l.start);
        }
    }

    /** Both diagnostic viewers render these exact cards; input ownership stays actor0. */
    private introUI(): void {
        if (!this.roundSetup) { this.startupError = '本局人设尚未锁定'; this.page = 'error'; this.renderPage(); return; }
        const cards = projectIntro(this.roundSetup, this.introViewer);
        const l = this.layout.intro;
        this.labelAt('对局前 · 职场往事', l.title, this.landscape ? 40 : 56);
        for (const card of cards) {
            const mine = card.actorId === this.introViewer;
            const position = mine ? 0 : 1;
            this.panelAt(l.cards[position]);
            this.labelAt(mine ? '你眼中的自己' : '这位对手的职场往事', l.facets[position], 32, mine ? C.blue : C.orange);
            const portrait = l.portraits[position]; this.portrait(card.roleId, portrait.x, portrait.y, Math.min(portrait.width, portrait.height));
            this.labelAt(`${card.displayName} · ${mine ? '你' : '对手'}`, l.names[position], 32, mine ? C.blue : C.orange);
            this.labelAt(card.text, l.stories[position]);
        }
        this.buttonAt('进入对局', l.enter, () => this.enterBattle(), true);
        this.buttonAt('返回选择', l.back, () => this.backToMenu());
    }

    private publishCastDiagnostics(): void {
        if (!this.motionDiagnosticCanvas) return;
        this.motionDiagnosticCanvas.setAttribute('data-slap-cast', JSON.stringify({ build: BUILD_ID, page: this.page,
            mode: this.mode, practice: this.practice, setup: this.roundSetup, selectedRole: this.selectedRole,
            opponentRole: this.opponentRole, viewerActorId: this.introViewer, controlledActorId: 0,
            intro: this.roundSetup ? projectIntro(this.roundSetup, this.introViewer) : null,
            state: this.session?.snapshot() ?? null, cast: this.skinEvidence(), generation: this.loadGeneration }));
        const dpr = screen.devicePixelRatio, viewport = view.getViewportRect(), frame = screen.windowSize;
        const cssRect = (rect: LayoutRect) => ({
            x: (viewport.x + (rect.x + this.width / 2 - rect.width / 2) * view.getScaleX()) / dpr,
            y: (frame.height - viewport.y - (rect.y + this.height / 2 + rect.height / 2) * view.getScaleY()) / dpr,
            width: rect.width * view.getScaleX() / dpr, height: rect.height * view.getScaleY() / dpr,
        });
        const rectFor = (transform: UITransform): LayoutRect => ({ x: transform.node.position.x, y: transform.node.position.y,
            width: transform.width, height: transform.height });
        const controls = this.buttons.map(button => ({ name: button.name, text: button.label.string,
            ui: rectFor(button.transform), css: cssRect(rectFor(button.transform)) }));
        if (this.attack) controls.push({ name: 'attack', text: this.attackLabel?.string ?? '', ui: rectFor(this.attack), css: cssRect(rectFor(this.attack)) });
        if (this.guard) controls.push({ name: 'guard', text: this.guardLabel?.string ?? '', ui: rectFor(this.guard), css: cssRect(rectFor(this.guard)) });
        this.motionDiagnosticCanvas.setAttribute('data-slap-layout', JSON.stringify({ build: BUILD_ID, page: this.page,
            design: { width: this.width, height: this.height }, window: { width: frame.width / dpr, height: frame.height / dpr },
            safe: this.layout.safe, cssScale: { x: view.getScaleX() / dpr, y: view.getScaleY() / dpr }, controls }));
    }

    private renderPage(): void {
        for (const child of [...this.ui.children]) if (child !== this.inputDiagnosticHud?.node) child.destroy();
        for (const frame of this.portraitFrames) frame.destroy();
        this.portraitFrames = [];
        this.inputDiagnosticCopyLabel = null;
        this.buttons = [];
        this.attack = this.guard = null;
        this.attackPanel = this.guardPanel = null;
        this.attackAvailable = this.guardAvailable = null;
        this.attackLabel = this.guardLabel = this.statusLabel = this.resultLabel = this.timerLabel = null;
        this.hpLabels = []; this.hpBars = []; this.chargeBar = null;
        if (this.inputObservation.enabled) {
            const active = this.page === 'paused' && !this.inputDiagnosticDisposed;
            if (active !== this.inputDiagnosticPanelActive) {
                this.inputDiagnosticCopyGeneration++;
                this.inputDiagnosticCopyBusy = false; this.inputDiagnosticCopyStatus = '';
            }
            this.inputDiagnosticPanelActive = active;
        }
        if(this.page==='clip-qa') {this.clipQaUI();return;}
        if (this.page === 'battle') { this.battleUI(); return; }
        if (this.page !== 'result') {
            // SHOW_ALL's design rectangle can be narrower than the full window.
            // Cover those margins too, with padding beyond rounded corners.
            const frame = screen.windowSize;
            this.panel(0, 0, frame.width / view.getScaleX() + 32, frame.height / view.getScaleY() + 32, C.bg);
        }
        const l = this.layout, common = l.common;
        if (this.page === 'menu') {
            this.selectionUI();
        } else if (this.page === 'practice') {
            this.labelAt('练习攻防', common.title, 56);
            this.labelAt('固定节奏，同一套规则。\n读懂前摇，再抓住时机。', common.description, 24);
            const selected = this.cast.find(m => m.source.roleId === this.selectedRole);
            this.labelAt(`你的人设：${selected?.source.displayName ?? ''}`, common.role, 32, C.blue);
            this.buttonAt('命中练习', common.primary, () => this.begin('hit'), true);
            this.buttonAt('格挡练习', common.secondary, () => this.begin('block'));
            this.buttonAt('精准反击练习', common.tertiary, () => this.begin('parry'));
            this.buttonAt('返回选择', common.back, () => this.changePage('menu'));
        } else if (this.page === 'loading') {
            this.labelAt('正在准备对战…', l.box(0, 0, 640, 80), 40);
            this.buttonAt('返回选择', l.target(0, -120, 520, 96), () => this.backToMenu());
        } else if (this.page === 'intro') {
            this.introUI();
        } else if (this.page === 'error') {
            this.labelAt('对战未能启动', l.box(0, 120, 640, 80), 40);
            this.labelAt(this.startupError || '角色资源未能准备，请返回选择后重试。', l.box(0, 20, 640, 110));
            this.buttonAt('返回选择', l.target(0, -130, 520, 96), () => this.backToMenu(), true);
        } else if (this.page === 'paused' || this.page === 'confirm') {
            this.labelAt(this.page === 'paused' ? '已暂停' : '放弃这局？', l.box(0, 150, 640, 80), 56);
            this.labelAt(this.page === 'paused' ? '准备好再继续。' : '本局进度不会保留。', l.box(0, 50, 640, 64));
            this.buttonAt('继续对战', l.target(0, -60, 520, 96), () => this.resume(), true);
            this.buttonAt(this.page === 'paused' ? '返回选择' : '放弃并返回', l.target(0, -180, 520, 96),
                () => this.page === 'paused' ? this.changePage('confirm') : this.backToMenu(), false,
                this.page === 'confirm' ? 'danger' : 'normal');
            if (this.page === 'paused' && this.inputObservation.enabled && !this.inputDiagnosticDisposed) {
                this.buttonAt('复制诊断', l.target(this.landscape ? 440 : 0, this.landscape ? -180 : -300, this.landscape ? 300 : 520, 96),
                    () => this.copyInputDiagnostic());
                this.inputDiagnosticCopyLabel = this.labelAt(this.inputDiagnosticCopyStatus || '复制后可粘贴发回。',
                    l.box(0, this.landscape ? -286 : -390, this.width - 40, 64), 24);
            }
        } else if (this.page === 'result') {
            const result = this.session?.snapshot().result;
            // Only header/footer panels cover the world; the real result actors
            // keep their central window throughout the independent visual clock.
            const bandWidth = screen.windowSize.width / view.getScaleX() + 32;
            const headerBand = l.box(0, this.height / 2 - 94, this.width, 188);
            const footerBand = l.box(0, -this.height / 2 + (this.landscape ? 100 : 178), this.width, this.landscape ? 200 : 356);
            this.panelAt({ ...headerBand, x: 0, width: bandWidth }, C.bg);
            this.panelAt({ ...footerBand, x: 0, width: bandWidth }, C.bg);
            this.labelAt(result === 'player' ? '你赢了' : result === 'bot' ? '这局输了' : '平局', l.result.title, this.landscape ? 40 : 56, C.gold);
            const state = this.session!.snapshot();
            this.labelAt(this.playerStation===0?`剩余生命  ${state.fighters[0].hp} : ${state.fighters[1].hp}`:`你的生命 ${state.fighters[0].hp} · 对手 ${state.fighters[1].hp}`, l.result.hp);
            if (!this.landscape) this.labelAt(this.mode === 'charge' ? '本局：蓄力出掌' : '本局：点击出掌', l.result.mode, 24);
            this.buttonAt(this.practice === 'normal' ? '再来一局' : '重试练习', l.result.retry, () => this.begin(this.practice, true), true);
            this.buttonAt('换个人设', l.result.change, () => this.backToMenu());
        }
        if (this.page === 'menu' || this.page === 'paused' || this.page === 'result') {
            const buildLabel = BUILD_ID.split('-').slice(0, 3).join('-');
            this.labelAt(`构建 ${buildLabel}`, common.build, 24);
        }
    }

    private battleUI(): void {
        const l = this.layout.battle;
        for (let i = 0; i < 2; i++) {
            const side=presentationSide(i as 0|1,this.playerStation);
            this.hpLabels.push(this.labelAt(`${i === 0 ? '你' : '机器人'}  5/5`, l.hp[side], 32, i === 0 ? C.blue : C.orange));
            this.labelAt(this.roundSetup?.actors[i].displayName ?? '', l.roles[side], 24, i === 0 ? C.blue : C.orange);
            this.hpBars.push(this.panelAt(l.hpBars[side]));
        }
        this.buttonAt('暂停', l.pause, () => this.pause());
        this.timerLabel = this.labelAt('', l.timer, 24);
        this.guardPanel = this.panelAt(l.guard);
        this.attackPanel = this.panelAt(l.attack, C.gold);
        this.guard = this.guardPanel.node.getComponent(UITransform)!;
        this.attack = this.attackPanel.node.getComponent(UITransform)!;
        this.guardLabel = this.text('防御', l.guard.x, l.guard.y + 16, l.guard.width - 20, 32);
        this.attackLabel = this.text(this.mode === 'charge' ? '按住蓄力' : '点击出掌', l.attack.x, l.attack.y + 16, l.attack.width - 20, 32, C.bg);
        // Keep the footer's status, instruction and result in separate rows.
        // A practice retry action belongs above the fighters, not in these rows.
        this.statusLabel = this.labelAt('', l.status, 24);
        this.chargeBar = this.panel(l.attack.x, l.attack.y - 48, l.attack.width - 60, 14, C.panel);
        this.resultLabel = this.labelAt('', l.feedback, 40);
        if (this.practice !== 'normal') {
            const hints = { hit: `命中练习：轻击伤害${DEFAULT_RULES.baseDamage}，蓄满伤害${DEFAULT_RULES.chargedDamage}`, block: '格挡练习：来掌前提前按防御', parry: '精准反击练习：贴近命中再按防御' };
            this.labelAt(hints[this.practice], l.hint, 24);
            this.buttonAt('重试练习', l.retry, () => this.begin(this.practice, true));
        } else this.labelAt('提前按可格挡，贴近命中时按可反击', l.hint, 24);
        if (this.session) this.drawState(this.session.snapshot());
    }

    private begin(practice: Practice, retry = false): void {
        if (this.page === 'loading' || this.page === 'intro') return;
        let ticket: RoundTicket | null;
        try {
            if (!this.catalog) throw new Error('人设资源尚未准备，请返回后重试。');
            const playerRoleId = (this.diagnosticRole ?? this.selectedRole) as RoleId;
            this.diagnosticRole = null;
            ticket = retry ? this.roundGate.retry() : this.roundGate.start(makeRoundSetup(this.catalog, {
                playerRoleId, opponentRoleId: this.opponentRole, mode: this.mode,
            }));
            if (!ticket) return;
        } catch (error) {
            this.startupError = '所选人设暂不可用，请返回重新选择。'; this.changePage('error'); return;
        }
        this.roundSetup = ticket.setup;
        this.mode = ticket.setup.mode;
        this.activeClock.freezeAt(this.session?.snapshot().nowMs ?? 0);
        this.bridge.cancelAll();
        this.session?.pause(); this.session = null;
        this.clearActors(); this.motion.reset(); this.seenEvents.clear(); this.trace = [];
        this.motionSamples = []; this.clearContactFrames();
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-motion');
        this.resultVisualMs = 0; this.skipVisualFrame = false;
        this.practice = practice;
        const token = ++this.loadGeneration;
        this.startupError = '';
        this.changePage('loading');
        this.scheduleOnce(async () => {
            try {
                if (!this.isValid || token !== this.loadGeneration || !this.roundGate.isCurrent(ticket!)) return;
                // Explicit Web-only fault injection exercises the real catch and
                // retry path without manufacturing a battle or its result.
                if (this.diagnosticStart === 'fail-once' && !this.diagnosticStartFailed) {
                    this.diagnosticStartFailed = true;
                    throw new Error('Diagnostic one-time session initialization failure');
                }
                await this.prepareActors(ticket!);
                if (!this.isValid || token !== this.loadGeneration || !this.roundGate.isCurrent(ticket!)) return;
                this.changePage('intro');
            } catch (error) { if (this.isValid && token === this.loadGeneration && this.roundGate.isCurrent(ticket!)) {
                this.clearActors(); this.startupError = '角色资源未能准备，请返回选择后重试。';
                console.error('Slap game session initialization failed', error); this.changePage('error');
            } }
        }, this.diagnosticStart === 'slow' ? 2 : 0.05);
    }

    private enterBattle(): void {
        if (this.page !== 'intro' || !this.roundSetup || this.characterView.count !== 2) return;
        this.activeClock.freezeAt(this.session?.snapshot().nowMs ?? 0);
        this.bridge.cancelAll();
        this.session = new LocalSession({ sessionId: `local-${++this.round}`, mode: this.roundSetup.mode, practice: this.practice, seed: 104729 });
        this.activeClock.start(this.session.snapshot().nowMs);
        this.sequence = 0; this.resultVisualMs = 0; this.skipVisualFrame = false;
        this.motion.reset(this.session.snapshot().sessionId); this.motionSamples = []; this.clearContactFrames();
        this.seenEvents.clear(); this.trace = []; this.feedback = ''; this.feedbackUntil = 0;
        if (this.hidden) { this.activeClock.freezeAt(this.session.snapshot().nowMs); this.session.pause(); this.changePage('paused'); }
        else this.changePage('battle');
    }

    private submit(action: ActionKind): void {
        if (!this.session || this.page !== 'battle' || this.session.paused) return;
        const state = this.session.snapshot();
        if (state.result) return;
        const atMs = this.activeClock.nowMs();
        // Queue first: a guard delivered exactly at contact must retain the
        // core's command-before-contact priority. Past the round limit, only
        // settle the result; do not emit invalid-time or ended commands.
        if (atMs <= DEFAULT_RULES.roundDurationMs) {
            this.session.submit({ sessionId: state.sessionId, actorId: 0, sequence: ++this.sequence, atMs, action });
        }
        this.session.advanceTo(atMs);
        this.presentSession();
    }

    private presentSession(): void {
        if (!this.session) return;
        this.consume(this.session.drainEvents());
        const state = this.session.snapshot();
        this.drawState(state);
        if (state.result !== null) {
            this.activeClock.freezeAt(state.nowMs);
            this.bridge.cancelAll(); this.resultVisualMs = 0; this.skipVisualFrame = true; this.changePage('result');
        }
    }

    private touchStart(event: EventTouch): void {
        const pointer = event.getID();
        const simulate = typeof event.simulate === 'boolean' ? event.simulate : null;
        this.observeInput('cocos-input', 'touch-start', 'before', event.type, pointer === null ? [] : [pointer], null, simulate);
        try {
            const point = event.getLocation();
            for (let i = this.buttons.length - 1; i >= 0; i--) {
                if (this.buttons[i].transform.hitTest(point, event.windowId)) { this.buttons[i].action(); return; }
            }
            if (this.page !== 'battle') return;
            if (pointer === null) return;
            if (this.attack?.hitTest(point, event.windowId)) this.bridge.downAttack(pointer, this.mode);
            else if (this.guard?.hitTest(point, event.windowId)) this.bridge.downGuard(pointer);
        } finally { this.observeInput('cocos-input', 'touch-start', 'after', event.type, pointer === null ? [] : [pointer], null, simulate); }
    }
    private touchEnd(event: EventTouch): void {
        const id = event.getID();
        const simulate = typeof event.simulate === 'boolean' ? event.simulate : null;
        this.observeInput('cocos-input', 'touch-end', 'before', event.type, id === null ? [] : [id], null, simulate);
        if (id !== null) this.bridge.up(id);
        this.observeInput('cocos-input', 'touch-end', 'after', event.type, id === null ? [] : [id], null, simulate);
    }
    private touchCancel(event: EventTouch): void {
        const id = event.getID();
        const simulate = typeof event.simulate === 'boolean' ? event.simulate : null;
        this.observeInput('cocos-input', 'touch-cancel', 'before', event.type, id === null ? [] : [id], null, simulate);
        // Loss of local touch control can precede EVENT_HIDE. Pause first so
        // cleanup freezes at the resolved snapshot rather than catching up a hit.
        // Every cancel clears all pointers, including an absent/already released ID.
        if (this.page === 'battle' && this.session) this.pause();
        else this.bridge.cancelAll();
        this.observeInput('cocos-input', 'touch-cancel', 'after', event.type, id === null ? [] : [id], null, simulate);
    }

    private pause(): void {
        if (this.page !== 'battle' || !this.session) return;
        // Cancellation can synchronously call submit. Freeze first so that it
        // runs at the resolved snapshot and cannot catch up a hit during hide.
        this.activeClock.freezeAt(this.session.snapshot().nowMs);
        this.bridge.cancelAll();
        this.session.pause();
        this.changePage('paused');
    }
    private resume(): void {
        if (!this.session || this.hidden || (this.page !== 'paused' && this.page !== 'confirm')) return;
        this.bridge.cancelAll();
        this.activeClock.resume(this.session.snapshot().nowMs);
        this.session.resume();
        this.changePage('battle');
    }
    private backToMenu(): void {
        if(this.page==='clip-qa') {this.clipQaClose=false;this.setClipQaCamera(false);}
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-clip-qa');
        ++this.loadGeneration;
        this.roundGate.clear(); this.roundSetup = null;
        this.activeClock.freezeAt(this.session?.snapshot().nowMs ?? 0);
        this.bridge.cancelAll(); this.session?.pause(); this.session = null;
        this.clearActors();
        this.resultVisualMs = 0; this.skipVisualFrame = false;
        this.seenEvents.clear(); this.trace = []; this.changePage('menu');
        this.motion.reset();
        this.motionSamples = []; this.motionDiagnosticCanvas?.removeAttribute('data-slap-motion');
        this.clearContactFrames();
    }
    private hide(): void {
        this.observeInput('cocos-game', 'game-hide', 'before', Game.EVENT_HIDE);
        this.hidden = true; this.skipVisualFrame = true; this.pause();
        this.observeInput('cocos-game', 'game-hide', 'after', Game.EVENT_HIDE);
    }
    private show(): void {
        this.observeInput('cocos-game', 'game-show', 'before', Game.EVENT_SHOW);
        this.hidden = false; this.skipVisualFrame = true; /* Only Continue resumes an active match. */
        this.observeInput('cocos-game', 'game-show', 'after', Game.EVENT_SHOW);
    }

    update(dt: number): void {
        this.publishInputObservation();
        // Observe actual Component updates even on menus/paused screens. These
        // counters never control simulation time or submit gameplay commands.
        const wallMs = performance.now();
        const dtMs = dt * 1000;
        this.frameUpdates++;
        if (this.frameFirstWallMs === null) this.frameFirstWallMs = wallMs;
        this.frameLastWallMs = wallMs;
        this.frameTotalDtMs += dtMs;
        this.frameMinDtMs = this.frameMinDtMs === null ? dtMs : Math.min(this.frameMinDtMs, dtMs);
        this.frameMaxDtMs = this.frameMaxDtMs === null ? dtMs : Math.max(this.frameMaxDtMs, dtMs);
        this.frameRecentDtMs.push(dtMs);
        if (this.frameRecentDtMs.length > 120) this.frameRecentDtMs.shift();
        this.publishCastDiagnostics();
        if(this.page==='clip-qa') {
            if(this.clipQaReady&&!this.hidden) {
                const name=QA_CLIPS[this.clipQaIndex],duration=this.characterView.clipDuration(name);
                if(this.clipQaPlaying) this.clipQaTime=(this.clipQaTime+Math.max(0,dt)/duration)%1;
                this.characterView.preview(name,this.clipQaTime);
                if(this.clipQaLabel) this.clipQaLabel.string=`职场中层 · ${name} · ${(this.clipQaTime*duration).toFixed(2)} / ${duration.toFixed(2)}秒\n${BUILD_ID}`;
            } else if(this.clipQaLabel) this.clipQaLabel.string=this.startupError||'正在加载实际模型…';
            this.publishFrameDiagnostics(wallMs);return;
        }
        if (this.ready && this.session && this.page === 'result') {
            if (!this.hidden) {
                if (this.skipVisualFrame) this.skipVisualFrame = false;
                else this.resultVisualMs = Math.min(900, this.resultVisualMs + Math.max(0, dtMs));
                const state = this.session.snapshot();
                this.pendingSkinState = state; this.sampleActors(state);
            }
            this.publishFrameDiagnostics(wallMs);
            return;
        }
        if (!this.ready || !this.session || this.page !== 'battle' || this.session.paused) {
            this.publishFrameDiagnostics(wallMs);
            return;
        }
        this.session.advanceTo(this.activeClock.nowMs());
        this.presentSession();
        this.publishFrameDiagnostics(wallMs);
    }

    private consume(events: BattleEvent[]): void {
        const fresh: BattleEvent[] = [];
        for (const event of events) {
            if (this.seenEvents.has(event.id)) continue;
            this.seenEvents.add(event.id);
            this.trace.push({ ...event });
            if (this.trace.length > 32) this.trace.shift();
            fresh.push(event);
        }
        if (this.session) this.motion.consume(this.session.snapshot(), fresh);
        const chosen = latestContact(fresh);
        if (!chosen) return;
        this.feedback = contactText(chosen);
        this.feedbackColor = chosen.actorId === 0 && (chosen.kind === 'counter-hit' || (chosen.kind === 'hit' && (chosen.damage ?? 0) > DEFAULT_RULES.baseDamage)) ? C.gold : C.ink;
        this.feedbackUntil = chosen.atMs + 800;
    }

    private drawState(state: BattleState): void {
        if (this.page !== 'battle') return;
        const me = state.fighters[0];
        // Mirror Battle.apply eligibility for presentation only. Input still goes
        // through the same bridge and rules, including rejection while busy.
        const attackAvailable = me.phase === 'idle' || (me.phase === 'charging' && this.mode === 'charge');
        const guardAvailable = me.phase === 'idle' && me.guardCharges > 0 && state.nowMs >= me.guardReadyAtMs;
        if (attackAvailable !== this.attackAvailable) {
            this.attackAvailable = attackAvailable;
            this.paintControl(this.attackPanel!, attackAvailable ? C.gold : '#6B603F');
            this.attackLabel!.color = new Color(attackAvailable ? C.bg : C.ink);
        }
        if (guardAvailable !== this.guardAvailable) {
            this.guardAvailable = guardAvailable;
            this.paintControl(this.guardPanel!, guardAvailable ? C.panel : '#1D2C35');
        }
        this.pendingSkinState = state;
        this.sampleActors(state);
        for (let i = 0; i < 2; i++) {
            const fighter = state.fighters[i];
            this.hpLabels[i].string = `${i === 0 ? '你' : '机器人'}  ${fighter.hp}/${DEFAULT_RULES.maxHp}`;
            const bar = this.hpBars[i]; bar.clear();
            const size = bar.node.getComponent(UITransform)!;
            bar.fillColor = new Color(C.panel); bar.rect(-size.width / 2, -size.height / 2, size.width, size.height); bar.fill();
            bar.fillColor = new Color(i === 0 ? C.blue : C.orange); bar.rect(-size.width / 2, -size.height / 2, size.width * fighter.hp / DEFAULT_RULES.maxHp, size.height); bar.fill();
        }
        const names: Record<string, string> = { idle: '', charging: '蓄力中', windup: '出掌中', recovery: '收招中', guard: '防御中', stunned: '受击中', counter: '精准挡住 · 准备反击', parried: '被挡住 · 反击将至', 'counter-recovery': '反击收招中' };
        const charge = me.chargeStartMs === null ? 0 : clamp((state.nowMs - me.chargeStartMs) / DEFAULT_RULES.fullChargeMs);
        const fullCharge = me.phase === 'charging' && charge >= 1;
        this.attackLabel!.string = me.phase === 'charging' ? fullCharge ? '满蓄力 · 松手' : '松手轻击' : this.mode === 'charge' ? '按住蓄力' : '点击出掌';
        this.guardLabel!.string = `防御  ${me.guardCharges}/${DEFAULT_RULES.maxGuardCharges}`;
        this.statusLabel!.string = me.phase === 'charging'
            ? fullCharge ? `满蓄力：松手命中伤害 ${DEFAULT_RULES.chargedDamage}` : `蓄力 ${Math.floor(charge * 100)}% · 松手伤害 ${DEFAULT_RULES.baseDamage}`
            : names[me.phase] || (me.guardCharges === 0 || state.nowMs < me.guardReadyAtMs ? '防御恢复中' : this.mode === 'charge'
                ? `按住${DEFAULT_RULES.fullChargeMs / 1000}秒：伤害${DEFAULT_RULES.baseDamage}→${DEFAULT_RULES.chargedDamage}` : `点击出掌 · 命中伤害 ${DEFAULT_RULES.baseDamage}`);
        this.statusLabel!.color = new Color(fullCharge ? C.gold : C.ink);
        this.chargeBar!.clear();
        const chargeWidth = this.chargeBar!.node.getComponent(UITransform)!.width;
        this.chargeBar!.fillColor = new Color(C.panel); this.chargeBar!.rect(-chargeWidth / 2, -7, chargeWidth, 14); this.chargeBar!.fill();
        this.chargeBar!.fillColor = new Color(fullCharge ? C.ink : C.blue); this.chargeBar!.rect(-chargeWidth / 2, -7, chargeWidth * charge, 14); this.chargeBar!.fill();
        this.resultLabel!.string = state.nowMs < this.feedbackUntil ? this.feedback : '';
        this.resultLabel!.color = new Color(this.feedbackColor);
        this.timerLabel!.string = `${Math.ceil((DEFAULT_RULES.roundDurationMs - state.nowMs) / 1000)} 秒`;
        if (this.motionDiagnosticCanvas) this.motionFrameState = state;
    }

    private paintControl(panel: Graphics, color: string): void {
        const size = panel.node.getComponent(UITransform)!;
        panel.clear();
        panel.fillColor = new Color(color);
        panel.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, 16);
        panel.fill();
    }

    onDestroy(): void {
        this.inputDiagnosticDisposed = true;
        if (this.inputAfterDrawSubscribed) {
            director.off(Director.EVENT_AFTER_DRAW, this.observeInputAfterDraw, this);
            this.inputAfterDrawSubscribed = false;
        }
        if (this.wechatInputObservationApi) {
            try {
                this.wechatInputObservationApi.offTouchCancel!(this.observeWechatCancel);
                this.inputObservation.setNativeCancelObservation('removed');
            } catch { this.inputObservation.setNativeCancelObservation('removal-failed'); }
            this.wechatInputObservationApi = null;
        }
        this.inputDiagnosticCanvas?.removeAttribute('data-slap-input');
        ++this.loadGeneration; ++this.catalogGeneration; this.roundGate.clear(); this.roundSetup = null; this.clearActors();
        for (const frame of this.portraitFrames) frame.destroy();
        this.frameDiagnosticCanvas?.removeAttribute('data-slap-diagnostics');
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-motion');
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-cast');
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-layout');
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-clip-qa');
        if (this.motionDiagnosticCanvas) director.off(Director.EVENT_AFTER_DRAW, this.captureContactFrame, this);
        this.clearContactFrames();
        input.off(Input.EventType.TOUCH_START, this.touchStart, this);
        input.off(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        game.off(Game.EVENT_HIDE, this.hide, this); game.off(Game.EVENT_SHOW, this.show, this);
        view.off('canvas-resize', this.resize, this);
        this.activeClock.freezeAt(this.session?.snapshot().nowMs ?? 0);
        this.bridge.cancelAll(); this.session?.pause();
        this.motion.reset();
        this.arena?.dispose(); this.arena = null;
        for (const asset of this.ownedAssets) asset.decRef();
        this.ownedAssets.clear(); this.loadingAssets.clear(); this.roleTextures.clear();
        delete (globalThis as unknown as Record<string, unknown>).__SLAP_DEBUG__;
    }
}
