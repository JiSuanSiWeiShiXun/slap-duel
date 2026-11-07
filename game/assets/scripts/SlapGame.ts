import {
    _decorator, Component, Node, Camera, Canvas, UITransform, Layers, Color, Vec3,
    MeshRenderer, Material, Mesh, primitives, utils, Label, Graphics,
    input, Input, EventTouch, game, Game, view, screen, ResolutionPolicy, sys, DirectionalLight, profiler, director, Director,
    resources, JsonAsset, Prefab, assetManager, Asset, Sprite, SpriteFrame, Texture2D,
} from 'cc';
import { ActionKind, AttackMode, BattleState, BattleEvent, DEFAULT_RULES } from './core/Battle';
import { LocalSession } from './session/LocalSession';
import { InputBridge } from './InputBridge';
import { latestContact, contactText } from './Feedback';
import { BUILD_ID } from './BuildInfo';
import { FighterPose, Point } from './ParryMotion';
import { CharacterTimeline } from './CharacterTimeline';
import { CharacterView, CastManifest, RoleId } from './CharacterView';
import { CastCatalog, RoundSetup, RoundTicket, RoundGate, ROLE_IDS, createCastCatalog, makeRoundSetup, projectIntro, castResource } from './Cast';

const { ccclass } = _decorator;
type Page = 'menu' | 'practice' | 'loading' | 'intro' | 'battle' | 'paused' | 'confirm' | 'result' | 'error';
type Practice = 'normal' | 'hit' | 'block' | 'parry';
type Button = { transform: UITransform; label: Label; action: () => void };
type ContactFrame = {
    stage: 'guard-raise' | 'parry-catch' | 'counter-dip' | 'counter-rise' | 'counter-hit'; actorId: number;
    nowMs: number; hp: number[]; phases: string[]; events: BattleEvent[];
    width: number; height: number; image?: string; error?: string;
};
const C = { bg: '#16232C', panel: '#293C48', ink: '#F5F4EF', gold: '#FFD166', blue: '#73C5D5', orange: '#E6A17A', danger: '#F47C7C' };
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Presentation only: snapshots drive poses; semantic events drive feedback. */
@ccclass('SlapGame')
export class SlapGame extends Component {
    private page: Page = 'menu';
    private mode: AttackMode = 'charge';
    private practice: Practice = 'normal';
    private session: LocalSession | null = null;
    private clockMs = 0;
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
    private materials: Material[] = [];
    private meshes: Mesh[] = [];
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

    onLoad(): void {
        profiler.hideStats();
        if (sys.isBrowser && typeof document !== 'undefined') {
            const query = new URLSearchParams(window.location.search);
            const fps = query.get('diagnosticFps');
            if (fps !== null && ['15', '30', '60'].includes(fps)) {
                this.frameDiagnosticCanvas = document.getElementById('GameCanvas');
            }
            if (query.get('diagnosticMotion') === '1') this.motionDiagnosticCanvas = document.getElementById('GameCanvas');
            this.diagnosticIntro = query.get('diagnosticIntro') === '1';
            if (this.diagnosticIntro) {
                this.motionDiagnosticCanvas = document.getElementById('GameCanvas');
                this.introViewer = query.get('viewer') === '1' ? 1 : 0;
                this.diagnosticRole = query.get('diagnosticRole');
            }
            const startup = query.get('diagnosticStart');
            if (startup === 'slow' || startup === 'fail-once') this.diagnosticStart = startup;
        }
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
            inspect: () => ({ page: this.page, mode: this.mode, practice: this.practice,
                setup: this.roundSetup, viewerActorId: this.introViewer,
                state: this.session?.snapshot() ?? null, visualElapsedMs: this.resultVisualMs, events: this.trace.map(e => ({ ...e })), cast: this.skinEvidence(),
                frames: this.frameDiagnostics() }),
        };
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
        cameraNode.setPosition(0, 2.55, 7.2);
        cameraNode.lookAt(new Vec3(0, 1.1, 0));
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
        this.shape(this.world, 'Stage', 'box', [6, 0.2, 3], [0, -0.15, 0], '#344D5B');
        this.shape(this.world, 'CenterStripe', 'box', [0.045, 0.012, 2.6], [0, -0.038, 0], C.gold);
        // Characters are imported skinned assets. Missing resources use the error path.
    }

    private shape(parent: Node, name: string, kind: 'box' | 'sphere', scale: number[], pos: number[], color: string): Node {
        const node = new Node(name);
        parent.addChild(node);
        node.layer = Layers.Enum.DEFAULT;
        node.setPosition(pos[0], pos[1], pos[2]);
        node.setScale(scale[0], scale[1], scale[2]);
        const renderer = node.addComponent(MeshRenderer);
        const mesh = utils.createMesh(kind === 'sphere' ? primitives.sphere(0.5) : primitives.box());
        renderer.mesh = mesh;
        this.meshes.push(mesh);
        const material = new Material();
        material.initialize({ effectName: 'builtin-unlit' });
        material.setProperty('mainColor', new Color(color));
        renderer.setMaterial(material, 0);
        this.materials.push(material);
        return node;
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
            if (this.page === 'menu') this.renderPage();
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
        this.characterView.prepare(this.world, manifests as CastManifest[], templates);
    }

    private sampleActors(state: BattleState): void {
        const samples = this.motion.sample(state, state.nowMs, this.resultVisualMs);
        this.pendingPoses = samples.map(sample => sample.pose) as [FighterPose, FighterPose];
        this.characterView.sample(samples);
    }

    private skinEvidence() { return this.characterView.evidence(); }

    lateUpdate(): void {
        const state = this.pendingSkinState, poses = this.pendingPoses;
        if (!state || !poses || this.characterView.count !== 2) return;
        this.characterView.correct(state);
        if (this.motionDiagnosticCanvas && (this.page === 'battle' || this.page === 'result')) {
            this.motionSamples.push({ nowMs: state.nowMs, visualElapsedMs: this.resultVisualMs, poses, actual: this.characterView.measurements() });
            if (this.motionSamples.length > 120) this.motionSamples.shift();
            this.motionDiagnosticCanvas.setAttribute('data-slap-motion', JSON.stringify({ build: BUILD_ID, page: this.page, mode: this.mode, practice: this.practice,
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
    }

    private resize(): void {
        if (!this.ui) return;
        this.bridge.cancelAll();
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
        this.ui.getComponent(UITransform)!.setContentSize(this.width, this.height);
        this.renderPage();
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
        const button = { transform: panel.node.getComponent(UITransform)!, label, action };
        this.buttons.push(button);
        return button;
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
        this.text('掌上对决', 0, this.landscape ? 300 : 540, 660, 56);
        this.text('选择你的人设', 0, this.landscape ? 240 : 455, 640, 40);
        const cardY = this.landscape ? 70 : 190;
        for (let i = 0; i < this.cast.length; i++) {
            const role = this.cast[i], id = role.source.roleId, selected = id === this.selectedRole;
            const x = (i - 1) * (this.landscape ? 390 : 228), width = this.landscape ? 350 : 212;
            this.button('', x, cardY, width, () => { this.selectedRole = id; this.renderPage(); }, false,
                this.landscape ? 280 : 400, selected ? 'selected' : 'normal');
            this.portrait(id, x, cardY + (this.landscape ? 52 : 68), this.landscape ? 144 : 176);
            this.text(`${role.source.displayName}${selected ? ' · 已选' : ''}`, x, cardY - (this.landscape ? 34 : 48), width - 12, 24, selected ? C.gold : C.ink, 42);
            this.text(role.source.facets.positive, x, cardY - (this.landscape ? 90 : 125), width - 24, 24, C.ink, this.landscape ? 100 : 124);
        }
        if (!this.catalog) {
            this.text(this.castError ? '人设载入失败，请重试。' : '正在载入三个人设…', 0, 100, 640, 32);
            if (this.castError) this.button('重试载入', 0, -20, 440, () => this.loadCast(), true);
        }
        const y = this.landscape ? -140 : -100;
        this.button(`蓄力出掌${this.mode === 'charge' ? ' · 已选' : ''}`, -168, y, 312, () => { this.mode = 'charge'; this.renderPage(); }, false, 80, this.mode === 'charge' ? 'selected' : 'normal');
        this.button(`点击出掌${this.mode === 'tap' ? ' · 已选' : ''}`, 168, y, 312, () => { this.mode = 'tap'; this.renderPage(); }, false, 80, this.mode === 'tap' ? 'selected' : 'normal');
        if (!this.landscape) this.text('轻掌伤害1 · 按住1.2秒蓄满伤害2\n人物长处不改变攻防数值。', 0, -185, 640, 24, C.ink, 64);
        const opponent = this.cast.find(m => m.source.roleId === this.opponentRole);
        this.button(`对手：${opponent?.source.displayName ?? '准备中'} · 换人`, this.landscape ? -420 : 0, this.landscape ? -240 : -260, this.landscape ? 350 : 520, () => {
            const index = ROLE_IDS.indexOf(this.opponentRole); this.opponentRole = ROLE_IDS[(index + 1) % ROLE_IDS.length]; this.renderPage();
        }, false, 64);
        const startY = this.landscape ? -240 : -355;
        if (this.catalog) {
            this.button('开始对战', 0, startY, this.landscape ? 400 : 520, () => this.begin('normal'), true);
            this.button('练习攻防', this.landscape ? 420 : 0, this.landscape ? startY : -465, this.landscape ? 350 : 520, () => this.changePage('practice'));
        } else {
            this.panel(0, startY, this.landscape ? 400 : 520, 96, '#1D2C35');
            this.text('等待人设准备', 0, startY, this.landscape ? 380 : 500, 32, C.ink, 88);
        }
    }

    /** Both diagnostic viewers render these exact cards; input ownership stays actor0. */
    private introUI(): void {
        if (!this.roundSetup) { this.startupError = '本局人设尚未锁定'; this.page = 'error'; this.renderPage(); return; }
        const cards = projectIntro(this.roundSetup, this.introViewer);
        this.text('对局前 · 职场往事', 0, this.landscape ? 300 : 520, 680, this.landscape ? 40 : 56);
        for (const card of cards) {
            const mine = card.actorId === this.introViewer;
            const position = mine ? 0 : 1;
            const x = this.landscape ? (position === 0 ? -306 : 306) : 0;
            const y = this.landscape ? 45 : position === 0 ? 240 : -100;
            this.panel(x, y, this.landscape ? 568 : 664, this.landscape ? 380 : 300);
            this.text(mine ? '你眼中的自己' : '这位对手的职场往事', x, y + (this.landscape ? 145 : 112), 540, 32, mine ? C.blue : C.orange, 50);
            this.portrait(card.roleId, x - (this.landscape ? 170 : 222), y - 12, this.landscape ? 180 : 176);
            this.text(`${card.displayName} · ${mine ? '你' : '对手'}`, x + (this.landscape ? 88 : 84), y + (this.landscape ? 65 : 45), this.landscape ? 326 : 430, 32, mine ? C.blue : C.orange, 56);
            this.text(card.text, x + (this.landscape ? 88 : 84), y - (this.landscape ? 75 : 55), this.landscape ? 308 : 420, 32, C.ink, this.landscape ? 200 : 150);
        }
        this.button('进入对局', this.landscape ? 170 : 0, this.landscape ? -245 : -400, 520, () => this.enterBattle(), true);
        this.button('返回选择', this.landscape ? -430 : 0, this.landscape ? -245 : -510, this.landscape ? 300 : 520, () => this.backToMenu());
    }

    private publishCastDiagnostics(): void {
        if (!this.motionDiagnosticCanvas) return;
        this.motionDiagnosticCanvas.setAttribute('data-slap-cast', JSON.stringify({ build: BUILD_ID, page: this.page,
            mode: this.mode, practice: this.practice, setup: this.roundSetup, selectedRole: this.selectedRole,
            opponentRole: this.opponentRole, viewerActorId: this.introViewer, controlledActorId: 0,
            intro: this.roundSetup ? projectIntro(this.roundSetup, this.introViewer) : null,
            state: this.session?.snapshot() ?? null, cast: this.skinEvidence(), generation: this.loadGeneration }));
    }

    private renderPage(): void {
        for (const child of [...this.ui.children]) child.destroy();
        for (const frame of this.portraitFrames) frame.destroy();
        this.portraitFrames = [];
        this.buttons = [];
        this.attack = this.guard = null;
        this.attackPanel = this.guardPanel = null;
        this.attackAvailable = this.guardAvailable = null;
        this.attackLabel = this.guardLabel = this.statusLabel = this.resultLabel = this.timerLabel = null;
        this.hpLabels = []; this.hpBars = []; this.chargeBar = null;
        if (this.page === 'battle') { this.battleUI(); return; }
        if (this.page !== 'result') this.panel(0, 0, this.width, this.height, C.bg);
        const top = this.landscape ? 260 : 500;
        if (this.page === 'menu') {
            this.selectionUI();
        } else if (this.page === 'practice') {
            this.text('练习攻防', 0, top, 640, 56);
            this.text('固定节奏，同一套规则。\n读懂前摇，再抓住时机。', 0, top - 100, 640, 24, C.ink, 96);
            const selected = this.cast.find(m => m.source.roleId === this.selectedRole);
            this.text(`你的人设：${selected?.source.displayName ?? ''}`, 0, top - (this.landscape ? 150 : 190), 640, 32, C.blue, 40);
            const y = this.landscape ? 35 : 150;
            this.button('命中练习', 0, y, 520, () => this.begin('hit'), true);
            this.button('格挡练习', 0, y - 112, 520, () => this.begin('block'));
            this.button('精准反击练习', 0, y - 224, 520, () => this.begin('parry'));
            this.button('返回选择', this.landscape ? -480 : 0, this.landscape ? -260 : y - 352, this.landscape ? 240 : 520, () => this.changePage('menu'));
        } else if (this.page === 'loading') {
            this.text('正在准备对战…', 0, 0, 640, 40);
            this.button('返回选择', 0, -120, 520, () => this.backToMenu());
        } else if (this.page === 'intro') {
            this.introUI();
        } else if (this.page === 'error') {
            this.text('对战未能启动', 0, 100, 640, 40);
            this.text(this.startupError || '角色资源未能准备，请返回选择后重试。', 0, 20, 640, 32, C.ink, 100);
            this.button('返回选择', 0, -130, 520, () => this.backToMenu(), true);
        } else if (this.page === 'paused' || this.page === 'confirm') {
            this.text(this.page === 'paused' ? '已暂停' : '放弃这局？', 0, 150, 640, 56);
            this.text(this.page === 'paused' ? '准备好再继续。' : '本局进度不会保留。', 0, 50, 640, 32);
            this.button('继续对战', 0, -60, 520, () => this.resume(), true);
            this.button(this.page === 'paused' ? '返回选择' : '放弃并返回', 0, -180, 520,
                () => this.page === 'paused' ? this.changePage('confirm') : this.backToMenu(), false, 96,
                this.page === 'confirm' ? 'danger' : 'normal');
        } else if (this.page === 'result') {
            const result = this.session?.snapshot().result;
            const headingY = this.height / 2 - (this.landscape ? 64 : 100);
            const footerY = -this.height / 2 + (this.landscape ? 72 : 232);
            this.panel(0, headingY - 48, this.width, this.landscape ? 176 : 208, C.bg);
            this.panel(0, footerY - 48, this.width, this.landscape ? 176 : 304, C.bg);
            this.text(result === 'player' ? '你赢了' : result === 'bot' ? '这局输了' : '平局', 0, headingY, 640, this.landscape ? 40 : 56, C.gold);
            const state = this.session!.snapshot();
            this.text(`剩余生命  ${state.fighters[0].hp} : ${state.fighters[1].hp}`, 0, headingY - 64, 640, 32);
            if (!this.landscape) this.text(this.mode === 'charge' ? '本局：蓄力出掌' : '本局：点击出掌', 0, headingY - 116, 640, 24);
            this.button(this.practice === 'normal' ? '再来一局' : '重试练习', this.landscape ? -290 : 0, footerY, this.landscape ? 420 : 520, () => this.begin(this.practice, true), true);
            this.button('换个人设', this.landscape ? 290 : 0, this.landscape ? footerY : footerY - 120, this.landscape ? 420 : 520, () => this.backToMenu());
        }
        const buildLabel = BUILD_ID.split('-').slice(0, 3).join('-');
        const buildText = this.landscape ? `构建 ${buildLabel} · 规则 ${DEFAULT_RULES.version}` : `构建 ${buildLabel}\n规则 ${DEFAULT_RULES.version}`;
        this.text(buildText, 0, -this.height / 2 + (this.landscape ? 32 : 60), this.width - 32, 24, C.ink, this.landscape ? 40 : 88);
    }

    private battleUI(): void {
        const safe = sys.getSafeAreaRect(false);
        const safeInset = Math.max(0, this.height - safe.yMax);
        const top = this.height / 2 - 64 - Math.min(safeInset, 64);
        const hpX = this.landscape ? 420 : 190;
        for (let i = 0; i < 2; i++) {
            const x = i === 0 ? -hpX : hpX;
            this.hpLabels.push(this.text(`${i === 0 ? '你' : '机器人'}  5/5`, x, top, 260, 32, i === 0 ? C.blue : C.orange));
            this.text(this.roundSetup?.actors[i].displayName ?? '', x, top + 40, 300, 24, i === 0 ? C.blue : C.orange, 40);
            this.hpBars.push(this.panel(x, top - 48, 240, 16));
        }
        this.button('暂停', 0, top - 12, 112, () => this.pause(), false, 96);
        this.timerLabel = this.text('', 0, top - 100, 300, 24, C.ink, 48);
        const controlsY = this.landscape ? -220 : -this.height / 2 + 136;
        const controlsX = this.landscape ? 460 : 162;
        this.guardPanel = this.panel(-controlsX, controlsY, 300, 160);
        this.attackPanel = this.panel(controlsX, controlsY, 300, 160, C.gold);
        this.guard = this.guardPanel.node.getComponent(UITransform)!;
        this.attack = this.attackPanel.node.getComponent(UITransform)!;
        this.guardLabel = this.text('防御', -controlsX, controlsY + 16, 280, 32);
        this.attackLabel = this.text(this.mode === 'charge' ? '按住蓄力' : '点击出掌', controlsX, controlsY + 16, 280, 32, C.bg);
        // Keep the footer's status, instruction and result in separate rows.
        // A practice retry action belongs above the fighters, not in these rows.
        this.statusLabel = this.text('', 0, this.landscape ? -300 : controlsY + 128, this.landscape ? 580 : 640, 24, C.ink, 48);
        this.chargeBar = this.panel(controlsX, controlsY - 48, 240, 14, C.panel);
        this.resultLabel = this.text('', 0, this.landscape ? -110 : -240, this.landscape ? 580 : 640, 40);
        if (this.practice !== 'normal') {
            const hints = { hit: `命中练习：轻击伤害${DEFAULT_RULES.baseDamage}，蓄满伤害${DEFAULT_RULES.chargedDamage}`, block: '格挡练习：来掌前提前按防御', parry: '精准反击练习：贴近命中再按防御' };
            this.text(hints[this.practice], 0, this.landscape ? top - 116 : top - 160, this.landscape ? 580 : 640, 24, C.ink, 48);
            this.button('重试练习', this.landscape ? 470 : 0, top - (this.landscape ? 116 : 256), 260, () => this.begin(this.practice, true));
        } else this.text('提前按可格挡，贴近命中时按可反击', 0, this.landscape ? -190 : -312, this.landscape ? 580 : 640, 24, C.ink, 48);
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
        this.bridge.cancelAll();
        this.session = new LocalSession({ sessionId: `local-${++this.round}`, mode: this.roundSetup.mode, practice: this.practice, seed: 104729 });
        this.clockMs = 0; this.sequence = 0; this.resultVisualMs = 0; this.skipVisualFrame = false;
        this.motion.reset(this.session.snapshot().sessionId); this.motionSamples = []; this.clearContactFrames();
        this.seenEvents.clear(); this.trace = []; this.feedback = ''; this.feedbackUntil = 0;
        if (this.hidden) { this.session.pause(); this.changePage('paused'); } else this.changePage('battle');
    }

    private submit(action: ActionKind): void {
        if (!this.session || this.page !== 'battle' || this.session.paused) return;
        const state = this.session.snapshot();
        this.session.submit({ sessionId: state.sessionId, actorId: 0, sequence: ++this.sequence, atMs: state.nowMs, action });
        this.session.advanceTo(state.nowMs);
        this.consume(this.session.drainEvents());
        this.drawState(this.session.snapshot());
    }

    private touchStart(event: EventTouch): void {
        const point = event.getLocation();
        for (let i = this.buttons.length - 1; i >= 0; i--) {
            if (this.buttons[i].transform.hitTest(point, event.windowId)) { this.buttons[i].action(); return; }
        }
        if (this.page !== 'battle') return;
        const pointer = event.getID();
        if (pointer === null) return;
        if (this.attack?.hitTest(point, event.windowId)) this.bridge.downAttack(pointer, this.mode);
        else if (this.guard?.hitTest(point, event.windowId)) this.bridge.downGuard(pointer);
    }
    private touchEnd(event: EventTouch): void { const id = event.getID(); if (id !== null) this.bridge.up(id); }
    private touchCancel(event: EventTouch): void { const id = event.getID(); if (id !== null) this.bridge.cancel(id); }

    private pause(): void {
        if (this.page !== 'battle' || !this.session) return;
        this.bridge.cancelAll();
        this.session.pause();
        this.clockMs = this.session.snapshot().nowMs;
        this.changePage('paused');
    }
    private resume(): void {
        if (!this.session) return;
        this.bridge.cancelAll();
        this.clockMs = this.session.snapshot().nowMs;
        this.session.resume();
        this.changePage('battle');
    }
    private backToMenu(): void {
        ++this.loadGeneration;
        this.roundGate.clear(); this.roundSetup = null;
        this.bridge.cancelAll(); this.session?.pause(); this.session = null;
        this.clearActors();
        this.resultVisualMs = 0; this.skipVisualFrame = false;
        this.seenEvents.clear(); this.trace = []; this.changePage('menu');
        this.motion.reset();
        this.motionSamples = []; this.motionDiagnosticCanvas?.removeAttribute('data-slap-motion');
        this.clearContactFrames();
    }
    private hide(): void { this.hidden = true; this.skipVisualFrame = true; this.pause(); }
    private show(): void { this.hidden = false; this.skipVisualFrame = true; /* Only Continue resumes an active match. */ }

    update(dt: number): void {
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
        this.clockMs += Math.max(0, dt) * 1000;
        this.session.advanceTo(Math.floor(this.clockMs));
        this.consume(this.session.drainEvents());
        const state = this.session.snapshot();
        this.drawState(state);
        if (state.result !== null) { this.bridge.cancelAll(); this.resultVisualMs = 0; this.skipVisualFrame = true; this.changePage('result'); }
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
            bar.fillColor = new Color(C.panel); bar.rect(-120, -8, 240, 16); bar.fill();
            bar.fillColor = new Color(i === 0 ? C.blue : C.orange); bar.rect(-120, -8, 240 * fighter.hp / DEFAULT_RULES.maxHp, 16); bar.fill();
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
        this.chargeBar!.fillColor = new Color(C.panel); this.chargeBar!.rect(-120, -7, 240, 14); this.chargeBar!.fill();
        this.chargeBar!.fillColor = new Color(fullCharge ? C.ink : C.blue); this.chargeBar!.rect(-120, -7, 240 * charge, 14); this.chargeBar!.fill();
        this.resultLabel!.string = state.nowMs < this.feedbackUntil ? this.feedback : '';
        this.resultLabel!.color = new Color(this.feedbackColor);
        this.timerLabel!.string = `${Math.ceil((DEFAULT_RULES.roundDurationMs - state.nowMs) / 1000)} 秒`;
        if (this.motionDiagnosticCanvas) this.motionFrameState = state;
    }

    private paintControl(panel: Graphics, color: string): void {
        panel.clear();
        panel.fillColor = new Color(color);
        panel.roundRect(-150, -80, 300, 160, 16);
        panel.fill();
    }

    onDestroy(): void {
        ++this.loadGeneration; ++this.catalogGeneration; this.roundGate.clear(); this.roundSetup = null; this.clearActors();
        for (const frame of this.portraitFrames) frame.destroy();
        this.frameDiagnosticCanvas?.removeAttribute('data-slap-diagnostics');
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-motion');
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-cast');
        if (this.motionDiagnosticCanvas) director.off(Director.EVENT_AFTER_DRAW, this.captureContactFrame, this);
        this.clearContactFrames();
        input.off(Input.EventType.TOUCH_START, this.touchStart, this);
        input.off(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        game.off(Game.EVENT_HIDE, this.hide, this); game.off(Game.EVENT_SHOW, this.show, this);
        view.off('canvas-resize', this.resize, this);
        this.bridge.cancelAll(); this.session?.pause();
        this.motion.reset();
        for (const mesh of this.meshes) mesh.destroy();
        for (const material of this.materials) material.destroy();
        for (const asset of this.ownedAssets) asset.decRef();
        this.ownedAssets.clear(); this.loadingAssets.clear(); this.roleTextures.clear();
        delete (globalThis as unknown as Record<string, unknown>).__SLAP_DEBUG__;
    }
}
