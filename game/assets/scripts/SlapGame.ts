import {
    _decorator, Component, Node, Camera, Canvas, UITransform, Layers, Color, Vec3,
    MeshRenderer, Material, Mesh, primitives, utils, Label, Graphics, Quat,
    input, Input, EventTouch, game, Game, view, screen, ResolutionPolicy, sys, DirectionalLight, profiler,
} from 'cc';
import { ActionKind, AttackMode, BattleState, BattleEvent, DEFAULT_RULES } from './core/Battle';
import { LocalSession } from './session/LocalSession';
import { InputBridge } from './InputBridge';
import { latestContact, contactText } from './Feedback';
import { BUILD_ID } from './BuildInfo';
import { ParryMotion, FighterPose, ArmPose, Point } from './ParryMotion';

const { ccclass } = _decorator;
type Page = 'menu' | 'practice' | 'loading' | 'battle' | 'paused' | 'confirm' | 'result' | 'error';
type Practice = 'normal' | 'hit' | 'block' | 'parry';
type Button = { transform: UITransform; label: Label; action: () => void };
type Arm = { shoulder: Node; elbow: Node; wrist: Node; upper: Node; forearm: Node; palm: Node };
type Figure = { root: Node; body: Node; head: Node; arms: { lead: Arm; rear: Arm } };
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
    private figures: Figure[] = [];
    private materials: Material[] = [];
    private meshes: Mesh[] = [];
    private seenEvents = new Set<string>();
    private motion = new ParryMotion();
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
    private framePublishedWallMs = -Infinity;
    private diagnosticStart: 'slow' | 'fail-once' | null = null;
    private diagnosticStartFailed = false;

    onLoad(): void {
        profiler.hideStats();
        if (sys.isBrowser && typeof document !== 'undefined') {
            const query = new URLSearchParams(window.location.search);
            const fps = query.get('diagnosticFps');
            if (fps !== null && ['15', '30', '60'].includes(fps)) {
                this.frameDiagnosticCanvas = document.getElementById('GameCanvas');
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
        // Read-only diagnostics help tie runtime evidence to this exact build.
        (globalThis as unknown as Record<string, unknown>).__SLAP_DEBUG__ = {
            build: BUILD_ID,
            inspect: () => ({ page: this.page, mode: this.mode, practice: this.practice,
                state: this.session?.snapshot() ?? null, events: this.trace.map(e => ({ ...e })),
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

    private publishFrameDiagnostics(wallMs: number): void {
        if (!this.frameDiagnosticCanvas || wallMs - this.framePublishedWallMs < 1000) return;
        this.framePublishedWallMs = wallMs;
        const state = this.session?.snapshot();
        // A DOM-readable observation for isolated browser inspection contexts.
        // Never read this attribute back into gameplay; no command API is added.
        this.frameDiagnosticCanvas.setAttribute('data-slap-diagnostics', JSON.stringify({
            build: BUILD_ID, page: this.page, mode: this.mode, practice: this.practice,
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
        cameraNode.setPosition(0, 2.5, 9.8);
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
        this.figures = [this.figure(-1.25, 1, C.blue), this.figure(1.25, -1, C.orange)];
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

    private figure(x: number, direction: number, color: string): Figure {
        const root = new Node(direction === 1 ? 'Player' : 'Bot');
        this.world.addChild(root);
        root.setPosition(x, 0, 0);
        const body = new Node('TorsoPivot'); root.addChild(body);
        this.shape(body, 'Torso', 'box', [0.7, 0.85, 0.48], [0, 0.95, 0], color);
        this.shape(root, 'LeftLeg', 'box', [0.25, 0.55, 0.3], [-0.2, 0.27, 0], '#20313D');
        this.shape(root, 'RightLeg', 'box', [0.25, 0.55, 0.3], [0.2, 0.27, 0], '#20313D');
        const headPivot = new Node('HeadPivot'); body.addChild(headPivot); headPivot.setPosition(0, 1.8, 0);
        const head = this.shape(headPivot, 'Head', 'sphere', [0.85, 0.9, 0.8], [0, 0, 0], '#F0CEAE');
        this.shape(head, 'EyeLeft', 'sphere', [0.08, 0.08, 0.04], [-0.15, 0.05, 0.47], C.bg);
        this.shape(head, 'EyeRight', 'sphere', [0.08, 0.08, 0.04], [0.15, 0.05, 0.47], C.bg);
        this.shape(head, 'Mouth', 'box', [0.2, 0.035, 0.025], [0, -0.15, 0.48], C.bg);
        const makeArm = (name: string): Arm => {
            const shoulder = new Node(`${name}Shoulder`); body.addChild(shoulder);
            const elbow = new Node(`${name}Elbow`); shoulder.addChild(elbow);
            const wrist = new Node(`${name}Wrist`); elbow.addChild(wrist);
            const upper = this.shape(shoulder, `${name}UpperArm`, 'box', [0.14, 0.4, 0.14], [0, 0, 0], color);
            const forearm = this.shape(elbow, `${name}Forearm`, 'box', [0.12, 0.4, 0.12], [0, 0, 0], '#F0CEAE');
            const palm = this.shape(wrist, `${name}Palm`, 'sphere', [0.33, 0.42, 0.16], [0, 0, 0], '#F0CEAE');
            return { shoulder, elbow, wrist, upper, forearm, palm };
        };
        return { root, body, head: headPivot, arms: { lead: makeArm('Lead'), rear: makeArm('Rear') } };
    }

    private poseArm(arm: Arm, pose: ArmPose): void {
        arm.shoulder.setWorldPosition(...pose.shoulder);
        arm.elbow.setWorldPosition(...pose.elbow);
        arm.wrist.setWorldPosition(...pose.wrist);
        const segment = (node: Node, a: Point, b: Point, width: number) => {
            const delta = new Vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            const length = delta.length();
            node.setWorldPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
            node.setScale(width, Math.max(0.001, length), width);
            node.setWorldRotation(Quat.rotationTo(new Quat(), Vec3.UP, delta.normalize()));
        };
        segment(arm.upper, pose.shoulder, pose.elbow, 0.14);
        segment(arm.forearm, pose.elbow, pose.wrist, 0.12);
        arm.palm.setWorldPosition(...pose.palm);
        arm.palm.setWorldRotationFromEuler(0, pose.palmYaw, 0);
    }

    private poseFigure(figure: Figure, pose: FighterPose): void {
        figure.body.setWorldPosition(...pose.body);
        figure.body.setRotationFromEuler(0, pose.bodyYaw, pose.bodyRoll);
        figure.head.setWorldPosition(...pose.head);
        figure.head.setRotationFromEuler(0, 0, pose.headRoll);
        this.poseArm(figure.arms.lead, pose.arms.lead);
        this.poseArm(figure.arms.rear, pose.arms.rear);
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

    private renderPage(): void {
        for (const child of [...this.ui.children]) child.destroy();
        this.buttons = [];
        this.attack = this.guard = null;
        this.attackPanel = this.guardPanel = null;
        this.attackAvailable = this.guardAvailable = null;
        this.attackLabel = this.guardLabel = this.statusLabel = this.resultLabel = this.timerLabel = null;
        this.hpLabels = []; this.hpBars = []; this.chargeBar = null;
        if (this.page === 'battle') { this.battleUI(); return; }
        this.panel(0, 0, this.width, this.height, C.bg);
        const top = this.landscape ? 260 : 500;
        if (this.page === 'menu') {
            this.text('掌上对决', 0, top, 660, 56);
            this.text('选择你的出掌方式', 0, top - (this.landscape ? 80 : 90), 640, 40, C.ink, 56);
            this.text(`轻击伤害${DEFAULT_RULES.baseDamage}；按住${DEFAULT_RULES.fullChargeMs / 1000}秒蓄满伤害${DEFAULT_RULES.chargedDamage}。\n满蓄力后松手出掌。`, 0, top - (this.landscape ? 150 : 180), 640, 24, C.ink, 72);
            const y = this.landscape ? 0 : 80;
            this.button(`蓄力出掌${this.mode === 'charge' ? ' · 已选' : ''}`, -168, y, 312, () => { this.mode = 'charge'; this.renderPage(); }, false, 96, this.mode === 'charge' ? 'selected' : 'normal');
            this.button(`点击出掌${this.mode === 'tap' ? ' · 已选' : ''}`, 168, y, 312, () => { this.mode = 'tap'; this.renderPage(); }, false, 96, this.mode === 'tap' ? 'selected' : 'normal');
            this.button('开始对战', 0, y - 128, 520, () => this.begin('normal'), true);
            this.button('练习攻防', 0, y - 248, 520, () => this.changePage('practice'));
        } else if (this.page === 'practice') {
            this.text('练习攻防', 0, top, 640, 56);
            this.text('固定节奏，同一套规则。\n读懂前摇，再抓住时机。', 0, top - 100, 640, 24, C.ink, 96);
            const y = this.landscape ? 35 : 150;
            this.button('命中练习', 0, y, 520, () => this.begin('hit'), true);
            this.button('格挡练习', 0, y - 112, 520, () => this.begin('block'));
            this.button('精准反击练习', 0, y - 224, 520, () => this.begin('parry'));
            this.button('返回选择', this.landscape ? -480 : 0, this.landscape ? -260 : y - 352, this.landscape ? 240 : 520, () => this.changePage('menu'));
        } else if (this.page === 'loading') {
            this.text('正在准备对战…', 0, 0, 640, 40);
        } else if (this.page === 'error') {
            this.text('对战未能启动', 0, 100, 640, 40);
            this.text('请返回选择后重试。', 0, 20, 640, 32);
            this.button('返回选择', 0, -110, 520, () => this.changePage('menu'), true);
        } else if (this.page === 'paused' || this.page === 'confirm') {
            this.text(this.page === 'paused' ? '已暂停' : '放弃这局？', 0, 150, 640, 56);
            this.text(this.page === 'paused' ? '准备好再继续。' : '本局进度不会保留。', 0, 50, 640, 32);
            this.button('继续对战', 0, -60, 520, () => this.resume(), true);
            this.button(this.page === 'paused' ? '返回选择' : '放弃并返回', 0, -180, 520,
                () => this.page === 'paused' ? this.changePage('confirm') : this.backToMenu(), false, 96,
                this.page === 'confirm' ? 'danger' : 'normal');
        } else if (this.page === 'result') {
            const result = this.session?.snapshot().result;
            this.text(result === 'player' ? '你赢了' : result === 'bot' ? '这局输了' : '平局', 0, 200, 640, 56, C.gold);
            const state = this.session!.snapshot();
            this.text(`剩余生命  ${state.fighters[0].hp} : ${state.fighters[1].hp}`, 0, 100, 640, 32);
            this.text(this.mode === 'charge' ? '本局：蓄力出掌' : '本局：点击出掌', 0, 20, 640, 24);
            this.button(this.practice === 'normal' ? '再来一局' : '重试练习', 0, -100, 520, () => this.begin(this.practice), true);
            this.button('换种操作', 0, -220, 520, () => this.backToMenu());
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
            this.hpLabels.push(this.text(i === 0 ? '你  5/5' : '机器人  5/5', x, top, 260, 32, i === 0 ? C.blue : C.orange));
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
            this.text(hints[this.practice], 0, top - 160, this.landscape ? 580 : 640, 24, C.ink, 48);
            this.button('重试练习', this.landscape ? 470 : 0, top - (this.landscape ? 116 : 256), 260, () => this.begin(this.practice));
        } else this.text('提前按可格挡，贴近命中时按可反击', 0, this.landscape ? -190 : -312, this.landscape ? 580 : 640, 24, C.ink, 48);
        if (this.session) this.drawState(this.session.snapshot());
    }

    private begin(practice: Practice): void {
        if (this.page === 'loading') return;
        this.bridge.cancelAll();
        this.session?.pause();
        this.practice = practice;
        this.changePage('loading');
        this.scheduleOnce(() => {
            try {
                // Explicit Web-only fault injection exercises the real catch and
                // retry path without manufacturing a battle or its result.
                if (this.diagnosticStart === 'fail-once' && !this.diagnosticStartFailed) {
                    this.diagnosticStartFailed = true;
                    throw new Error('Diagnostic one-time session initialization failure');
                }
                this.session = new LocalSession({ sessionId: `local-${++this.round}`, mode: this.mode, practice, seed: 104729 });
                this.clockMs = 0; this.sequence = 0;
                this.motion.reset(this.session.snapshot().sessionId);
                this.seenEvents.clear(); this.trace = []; this.feedback = ''; this.feedbackUntil = 0;
                if (this.hidden) { this.session.pause(); this.changePage('paused'); }
                else this.changePage('battle');
            } catch (error) { console.error('Slap game session initialization failed', error); this.changePage('error'); }
        }, this.diagnosticStart === 'slow' ? 2 : 0.05);
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
        this.bridge.cancelAll(); this.session?.pause(); this.session = null;
        this.seenEvents.clear(); this.trace = []; this.changePage('menu');
        this.motion.reset();
    }
    private hide(): void { this.hidden = true; this.pause(); }
    private show(): void { this.hidden = false; /* Only Continue resumes an active match. */ }

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
        if (!this.ready || !this.session || this.page !== 'battle' || this.session.paused) {
            this.publishFrameDiagnostics(wallMs);
            return;
        }
        this.clockMs += Math.max(0, dt) * 1000;
        this.session.advanceTo(Math.floor(this.clockMs));
        this.consume(this.session.drainEvents());
        const state = this.session.snapshot();
        this.drawState(state);
        if (state.result !== null) { this.bridge.cancelAll(); this.changePage('result'); }
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
        const poses = this.motion.sample(state);
        for (let i = 0; i < 2; i++) {
            const fighter = state.fighters[i];
            this.hpLabels[i].string = `${i === 0 ? '你' : '机器人'}  ${fighter.hp}/${DEFAULT_RULES.maxHp}`;
            const bar = this.hpBars[i]; bar.clear();
            bar.fillColor = new Color(C.panel); bar.rect(-120, -8, 240, 16); bar.fill();
            bar.fillColor = new Color(i === 0 ? C.blue : C.orange); bar.rect(-120, -8, 240 * fighter.hp / DEFAULT_RULES.maxHp, 16); bar.fill();
            this.poseFigure(this.figures[i], poses[i]);
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
    }

    private paintControl(panel: Graphics, color: string): void {
        panel.clear();
        panel.fillColor = new Color(color);
        panel.roundRect(-150, -80, 300, 160, 16);
        panel.fill();
    }

    onDestroy(): void {
        this.frameDiagnosticCanvas?.removeAttribute('data-slap-diagnostics');
        input.off(Input.EventType.TOUCH_START, this.touchStart, this);
        input.off(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        game.off(Game.EVENT_HIDE, this.hide, this); game.off(Game.EVENT_SHOW, this.show, this);
        view.off('canvas-resize', this.resize, this);
        this.bridge.cancelAll(); this.session?.pause();
        this.motion.reset();
        for (const mesh of this.meshes) mesh.destroy();
        for (const material of this.materials) material.destroy();
        delete (globalThis as unknown as Record<string, unknown>).__SLAP_DEBUG__;
    }
}
