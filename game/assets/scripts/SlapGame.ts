import {
    _decorator, Component, Node, Camera, Canvas, UITransform, Layers, Color, Vec3,
    MeshRenderer, Material, Mesh, primitives, utils, Label, Graphics, Quat,
    input, Input, EventTouch, game, Game, view, screen, ResolutionPolicy, sys, DirectionalLight, profiler, director, Director,
    resources, JsonAsset, Prefab, instantiate, assetManager, Asset, SkeletalAnimation, SkinnedMeshRenderer,
    AnimationState, Sprite, SpriteFrame, Texture2D,
} from 'cc';
import { ActionKind, AttackMode, BattleState, BattleEvent, DEFAULT_RULES } from './core/Battle';
import { LocalSession } from './session/LocalSession';
import { InputBridge } from './InputBridge';
import { latestContact, contactText } from './Feedback';
import { BUILD_ID } from './BuildInfo';
import { ParryMotion, FighterPose, ArmPose, Point, DEFAULT_ANCHORS } from './ParryMotion';

const { ccclass } = _decorator;
type Page = 'menu' | 'practice' | 'loading' | 'battle' | 'paused' | 'confirm' | 'result' | 'error';
type Practice = 'normal' | 'hit' | 'block' | 'parry';
type Button = { transform: UITransform; label: Label; action: () => void };
type RoleId = 'manager' | 'veteran' | 'rookie';
type CastManifest = { schemaVersion: number; source: { roleId: RoleId; displayName: string;
    facets: { positive: string; negative: string }; appearance: { cloth: string; outfit: string }; proportions: { height: number; arm: number } };
    generated: { sourceHash: string; imports: { prefabUuid: string; skeletonUuid: string; portraitTextureUuid: string;
        bonePaths: Record<string, string>; clipUuids: Record<string, string> } } };
type SkinnedActor = { root: Node; animation: SkeletalAnimation; bones: Record<string, Node>;
    renderers: SkinnedMeshRenderer[]; manifest: CastManifest; side: 0 | 1;
    states: Map<string, AnimationState>; clip: string; palm: { lead: Vec3; rear: Vec3 }; cheek: Vec3 };
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
    private actors: SkinnedActor[] = [];
    private cast: CastManifest[] = [];
    private selectedRole: RoleId = 'manager';
    private opponentRole: RoleId = 'manager';
    private roleTextures = new Map<RoleId, Texture2D>();
    private loadingAssets = new Map<string, Promise<Asset>>();
    private portraitFrames: SpriteFrame[] = [];
    private loadGeneration = 0;
    private castError = '';
    private pendingSkinState: BattleState | null = null;
    private pendingPoses: [FighterPose, FighterPose] | null = null;
    private newSkinSample = false;
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
    private motionDiagnosticCanvas: HTMLElement | null = null;
    private motionSamples: { nowMs: number; poses: [FighterPose, FighterPose]; actual: { leadPalm: Point; rearPalm: Point; cheek: Point; head: Point }[] }[] = [];
    private motionFrameState: BattleState | null = null;
    private contactFrames: ContactFrame[] = [];
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
            if (query.get('diagnosticMotion') === '1') this.motionDiagnosticCanvas = document.getElementById('GameCanvas');
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
                state: this.session?.snapshot() ?? null, events: this.trace.map(e => ({ ...e })), cast: this.skinEvidence(),
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
            promise = new Promise<Asset>((resolve, reject) => assetManager.loadAny<Asset>(uuid, (error, value) => error ? reject(error) : resolve(value)));
            this.loadingAssets.set(uuid, promise);
            promise.catch(() => this.loadingAssets.delete(uuid));
        }
        return promise as Promise<T>;
    }

    private loadCast(): void {
        resources.loadDir('office-cast', JsonAsset, async (error, assets) => {
            if (!this.isValid) return;
            try {
                if (error) throw error;
                const roles = ['manager', 'veteran', 'rookie'];
                this.cast = assets.map(asset => asset.json as CastManifest).filter(m => m.schemaVersion === 1 && roles.includes(m.source?.roleId));
                if (!this.cast.length) throw new Error('No usable office character manifest');
                for (const manifest of this.cast) {
                    const refs = manifest.generated?.imports;
                    if (!refs?.prefabUuid || !refs.skeletonUuid || !refs.portraitTextureUuid || Object.keys(refs.bonePaths).length !== 29) throw new Error('Character import references incomplete');
                    const texture = await this.loadAsset<Texture2D>(refs.portraitTextureUuid);
                    if (!this.isValid) return;
                    this.roleTextures.set(manifest.source.roleId, texture);
                }
                this.cast.sort((a, b) => roles.indexOf(a.source.roleId) - roles.indexOf(b.source.roleId));
                this.castError = '';
            } catch (failure) { this.cast = []; this.castError = failure instanceof Error ? failure.message : 'Character loading failed'; console.error(this.castError); }
            if (this.page === 'menu') this.renderPage();
        });
    }

    private clearActors(): void {
        this.pendingSkinState = null; this.pendingPoses = null;
        for (const actor of this.actors) { actor.animation.stop(); actor.root.destroy(); }
        this.actors = [];
    }

    private async prepareActors(token: number): Promise<void> {
        const selected = [this.selectedRole, this.opponentRole];
        const manifests = selected.map(role => this.cast.find(m => m.source.roleId === role));
        if (manifests.some(m => !m)) throw new Error(this.castError || 'Character assets are still loading');
        const templates = await Promise.all(manifests.map(m => this.loadAsset<Prefab>(m!.generated.imports.prefabUuid)));
        if (!this.isValid || token !== this.loadGeneration) return;
        this.clearActors();
        try {
            for (const side of [0, 1] as const) {
                const manifest = manifests[side]!, root = instantiate(templates[side]);
                // Configure real-time skinning before onLoad creates any baked states.
                root.active = false;
                this.world.addChild(root); root.setPosition(side === 0 ? -.55 : .55, 0, 0);
                root.setRotationFromEuler(0, side === 0 ? 25 : -25, 0);
                const animation = root.getComponent(SkeletalAnimation) || root.getComponentInChildren(SkeletalAnimation);
                const renderers = root.getComponentsInChildren(SkinnedMeshRenderer);
                if (!animation || !renderers.length || renderers.some(r => !r.mesh || !r.skeleton || r.skeleton.joints.length !== 29)) { root.destroy(); throw new Error('Character has no valid 29-joint skin'); }
                animation.useBakedAnimation = false;
                root.active = true;
                const bones: Record<string, Node> = {};
                for (const [name, path] of Object.entries(manifest.generated.imports.bonePaths)) {
                    const bone = root.getChildByPath(path); if (!bone) { root.destroy(); throw new Error(`Character bone missing: ${name}`); } bones[name] = bone;
                }
                const states = new Map<string, AnimationState>();
                for (const name of Object.keys(manifest.generated.imports.clipUuids)) {
                    const state = animation.getState(name);
                    if (!state) { root.destroy(); throw new Error(`Character clip missing: ${name}`); }
                    states.set(name, state);
                }
                if (!states.has('counter') || !states.has('idle')) { root.destroy(); throw new Error('Combat animation import incomplete'); }
                for (const renderer of renderers) {
                    renderer.node.layer = Layers.Enum.DEFAULT;
                    const material = renderer.getMaterialInstance(manifest.source.appearance.outfit === 'shirt' ? 2 : 1);
                    material?.setProperty('mainColor', new Color(side === 0 ? C.blue : C.orange));
                }
                this.actors.push({ root, animation, bones, renderers, manifest, side, states, clip: '',
                    palm: { lead: new Vec3(), rear: new Vec3() }, cheek: new Vec3() });
            }
        } catch (error) { this.clearActors(); throw error; }
    }

    private sampleActors(state: BattleState): void {
        this.newSkinSample = true;
        for (const actor of this.actors) {
            const f = state.fighters[actor.side], age = state.nowMs - f.phaseStartMs;
            let name = 'idle', progress = (state.nowMs % 2000) / 2000;
            if (f.phase === 'charging') { name = 'charge'; progress = (age % 1200) / 1200; }
            else if (f.phase === 'windup') { name = this.trace.some(e => e.kind === 'attack-start' && e.actorId === actor.side && e.atMs === f.phaseStartMs && (e.damage ?? 1) > 1) ? 'attack-heavy' : 'attack-light'; progress = age / DEFAULT_RULES.windupMs; }
            else if (f.phase === 'guard' || f.phase === 'parried') { name = 'guard'; progress = Math.min(1, age / 60); }
            else if (f.phase === 'counter') { name = 'counter'; progress = age / DEFAULT_RULES.counterWindupMs; }
            else if (f.phase === 'counter-recovery') { name = 'counter-recovery'; progress = age / DEFAULT_RULES.counterRecoveryMs; }
            else if (f.phase === 'recovery') { name = 'recovery'; progress = age / DEFAULT_RULES.recoveryMs; }
            else if (f.phase === 'stunned') { name = 'hit'; progress = age / DEFAULT_RULES.stunMs; }
            if (state.result !== null) { name = f.hp > 0 ? 'victory' : 'defeat'; progress = 1; }
            const animationState = actor.states.get(name);
            if (!animationState) throw new Error(`Required combat clip not loaded: ${name}`);
            if (actor.clip !== name) { actor.animation.stop(); actor.animation.play(name); animationState.pause(); actor.clip = name; }
            animationState.setTime(clamp(progress) * animationState.duration); animationState.sample();
            const facing = actor.side === 0 ? 1 : -1;
            const lunge = f.phase === 'counter' ? .34 * clamp(age / DEFAULT_RULES.counterWindupMs)
                : f.phase === 'counter-recovery' ? .34 * (1 - clamp(age / DEFAULT_RULES.counterRecoveryMs)) : 0;
            actor.root.setPosition((actor.side === 0 ? -.55 : .55) + facing * lunge, 0, 0);
        }
    }

    private skinEvidence() {
        const point = (v: Readonly<Vec3>) => [v.x, v.y, v.z];
        return this.actors.map(actor => ({ roleId: actor.manifest.source.roleId, sourceHash: actor.manifest.generated.sourceHash,
            prefabUuid: actor.manifest.generated.imports.prefabUuid, skeletonUuid: actor.manifest.generated.imports.skeletonUuid,
            skinnedRenderers: actor.renderers.length, joints: Object.keys(actor.bones).length, clip: actor.clip,
            useBakedAnimation: actor.animation.useBakedAnimation, sampledTime: actor.states.get(actor.clip)?.time ?? null,
            actual: { leadPalm: point(actor.palm.lead), rearPalm: point(actor.palm.rear), cheek: point(actor.cheek),
                head: point(actor.bones.Head.worldPosition), pelvis: point(actor.bones.Pelvis.worldPosition), root: point(actor.root.worldPosition) } }));
    }

    /** Solve on deform bones after animation blending; never changes rule state. */
    private solveArm(actor: SkinnedActor, hand: 'lead' | 'rear', palmTarget: Vec3): void {
        const side = hand === 'lead' ? actor.side === 0 ? 'L' : 'R' : actor.side === 0 ? 'R' : 'L';
        const upper = actor.bones[`UpperArm.${side}`], fore = actor.bones[`Forearm.${side}`], wrist = actor.bones[`Hand.${side}`];
        const shoulder = upper.worldPosition.clone(), forePoint = fore.worldPosition.clone(), wristPoint = wrist.worldPosition.clone();
        const a = Vec3.distance(shoulder, forePoint), b = Vec3.distance(forePoint, wristPoint);
        // Palm centre lies .095m beyond the wrist; open fingers point upwards.
        const target = new Vec3(palmTarget.x, palmTarget.y - .095 * actor.manifest.source.proportions.height, palmTarget.z);
        const direction = Vec3.subtract(new Vec3(), target, shoulder);
        const distance = Math.max(.025, Math.min(direction.length(), a + b - .001)); direction.normalize();
        const along = (a * a - b * b + distance * distance) / (2 * distance);
        const bend = new Vec3(0, -1, -.15);
        Vec3.subtract(bend, bend, Vec3.multiplyScalar(new Vec3(), direction, Vec3.dot(bend, direction))); bend.normalize();
        const elbow = Vec3.add(new Vec3(), shoulder, Vec3.multiplyScalar(new Vec3(), direction, along));
        Vec3.add(elbow, elbow, Vec3.multiplyScalar(new Vec3(), bend, Math.sqrt(Math.max(0, a * a - along * along))));
        const endpoint = Vec3.add(new Vec3(), shoulder, Vec3.multiplyScalar(new Vec3(), direction, distance));
        const orient = (bone: Node, end: Vec3) => {
            const up = Vec3.subtract(new Vec3(), end, bone.worldPosition).normalize();
            // Imported bind axes: local Y runs down the arm; local +/-X is the palm normal.
            const normal = new Vec3(0, 0, side === 'L' ? 1 : -1);
            const right = Vec3.subtract(new Vec3(), normal, Vec3.multiplyScalar(new Vec3(), up, Vec3.dot(normal, up))).normalize();
            const front = Vec3.cross(new Vec3(), right, up).normalize();
            bone.setWorldRotation(Quat.fromAxes(new Quat(), right, up, front));
        };
        orient(upper, elbow); orient(fore, endpoint);
        // Keep a visible palm face towards the camera instead of flipping/negative scale.
        wrist.setWorldRotation(Quat.fromAxes(new Quat(), new Vec3(0, 0, side === 'L' ? 1 : -1), Vec3.UP, new Vec3(side === 'L' ? -1 : 1, 0, 0)));
        Vec3.transformMat4(actor.palm[hand], new Vec3(0, .00095, 0), wrist.worldMatrix);
    }

    lateUpdate(): void {
        const state = this.pendingSkinState, poses = this.pendingPoses;
        if (!state || !poses || this.actors.length !== 2) return;
        if (this.newSkinSample) {
            // Reflect the source body's turn for the opposite station without negative scale.
            const chest = this.actors[1].bones.Chest, q = chest.rotation;
            chest.setRotation(new Quat(q.x, -q.y, -q.z, q.w));
            this.newSkinSample = false;
        }
        for (const actor of this.actors) {
            const facing = actor.side === 0 ? 1 : -1;
            Vec3.transformMat4(actor.cheek, new Vec3(facing * .0018, .0022, .0016), actor.bones.Head.worldMatrix);
        }
        const guarded = this.actors.map(actor => new Vec3(actor.cheek.x + (actor.side === 0 ? .10 : -.10), actor.cheek.y - .025, actor.cheek.z + .07));
        for (const actor of this.actors) {
            const f = state.fighters[actor.side], other = this.actors[1 - actor.side], age = state.nowMs - f.phaseStartMs;
            const lead = new Vec3(...poses[actor.side].arms.lead.palm), rear = new Vec3(...poses[actor.side].arms.rear.palm);
            if (f.phase === 'guard' || f.phase === 'counter' || f.phase === 'counter-recovery') lead.set(guarded[actor.side]);
            if (f.phase === 'parried') lead.set(guarded[1 - actor.side]);
            if (f.phase === 'windup') {
                const target = state.fighters[other.side].phase === 'guard' ? guarded[other.side] : other.cheek;
                const u = clamp((age / DEFAULT_RULES.windupMs - .65) / .35);
                Vec3.lerp(lead, new Vec3((actor.side === 0 ? -.55 : .55) + (actor.side === 0 ? .25 : -.25), 1.55, .15), target, u);
            }
            if (f.phase === 'counter') Vec3.lerp(rear, new Vec3(actor.root.worldPosition.x + (actor.side === 0 ? -.35 : .35), 1.65, .18), other.cheek, clamp((age / DEFAULT_RULES.counterWindupMs - .32) / .68));
            if (f.phase === 'counter-recovery') Vec3.lerp(rear, other.cheek, new Vec3((actor.side === 0 ? -.55 : .55) + (actor.side === 0 ? -.35 : .35), 1.1, .25), clamp(age / DEFAULT_RULES.counterRecoveryMs));
            if (f.phase === 'idle' || f.phase === 'charging' || f.phase === 'stunned' || state.result !== null) {
                const handNames = actor.side === 0 ? ['L', 'R'] : ['R', 'L'];
                for (const [index, hand] of (['lead', 'rear'] as const).entries()) Vec3.transformMat4(actor.palm[hand], new Vec3(0, .00095, 0), actor.bones[`Hand.${handNames[index]}`].worldMatrix);
            } else { this.solveArm(actor, 'lead', lead); this.solveArm(actor, 'rear', rear); }
        }
        if (this.motionDiagnosticCanvas && this.page === 'battle') {
            const point = (v: Vec3): Point => [v.x, v.y, v.z];
            this.motionSamples.push({ nowMs: state.nowMs, poses, actual: this.actors.map(a => ({ leadPalm: point(a.palm.lead), rearPalm: point(a.palm.rear), cheek: point(a.cheek), head: point(a.bones.Head.worldPosition) })) });
            if (this.motionSamples.length > 120) this.motionSamples.shift();
            this.motionDiagnosticCanvas.setAttribute('data-slap-motion', JSON.stringify({ build: BUILD_ID, page: this.page, mode: this.mode, practice: this.practice,
                state, events: this.trace, samples: this.motionSamples, cast: this.skinEvidence() }));
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
        this.panel(0, 0, this.width, this.height, C.bg);
        const top = this.landscape ? 260 : 500;
        if (this.page === 'menu') {
            this.text('掌上对决', 0, top, 660, 56);
            this.text('选择你的出掌方式', 0, top - (this.landscape ? 80 : 90), 640, 40, C.ink, 56);
            this.text(`轻击伤害${DEFAULT_RULES.baseDamage}；按住${DEFAULT_RULES.fullChargeMs / 1000}秒蓄满伤害${DEFAULT_RULES.chargedDamage}。\n满蓄力后松手出掌。`, 0, top - (this.landscape ? 150 : 180), 640, 24, C.ink, 72);
            const roleX = this.landscape ? -470 : 80, roleY = this.landscape ? 50 : 222;
            const role = this.cast.find(m => m.source.roleId === this.selectedRole);
            const texture = this.roleTextures.get(this.selectedRole);
            if (texture) {
                const portrait = this.uiNode('CharacterPortrait', this.landscape ? -470 : -230, this.landscape ? 135 : 208, 144, 144);
                const sprite = portrait.addComponent(Sprite), frame = new SpriteFrame(); frame.texture = texture;
                sprite.spriteFrame = frame; sprite.sizeMode = Sprite.SizeMode.CUSTOM; this.portraitFrames.push(frame);
            }
            const cycle = (opponent: boolean) => {
                if (!this.cast.length) return;
                const id = opponent ? this.opponentRole : this.selectedRole;
                const next = this.cast[(this.cast.findIndex(m => m.source.roleId === id) + 1) % this.cast.length].source.roleId;
                if (opponent) this.opponentRole = next; else this.selectedRole = next;
                this.renderPage();
            };
            this.button(role ? `你：${role.source.displayName} · 换人` : this.castError ? '人设载入失败 · 重试' : '正在载入人设…', roleX, roleY, this.landscape ? 240 : 390,
                () => this.castError ? this.loadCast() : cycle(false), false, 64);
            const opponent = this.cast.find(m => m.source.roleId === this.opponentRole);
            this.button(`对手：${opponent?.source.displayName ?? '准备中'} · 换人`, roleX, roleY - 80, this.landscape ? 240 : 390, () => cycle(true), false, 64);
            const y = this.landscape ? 0 : 40;
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
            this.button('返回选择', 0, -120, 520, () => this.backToMenu());
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
            this.text(hints[this.practice], 0, this.landscape ? top - 116 : top - 160, this.landscape ? 580 : 640, 24, C.ink, 48);
            this.button('重试练习', this.landscape ? 470 : 0, top - (this.landscape ? 116 : 256), 260, () => this.begin(this.practice));
        } else this.text('提前按可格挡，贴近命中时按可反击', 0, this.landscape ? -190 : -312, this.landscape ? 580 : 640, 24, C.ink, 48);
        if (this.session) this.drawState(this.session.snapshot());
    }

    private begin(practice: Practice): void {
        if (this.page === 'loading') return;
        this.bridge.cancelAll();
        this.session?.pause();
        this.practice = practice;
        const token = ++this.loadGeneration;
        this.changePage('loading');
        this.scheduleOnce(async () => {
            try {
                if (!this.isValid || token !== this.loadGeneration) return;
                // Explicit Web-only fault injection exercises the real catch and
                // retry path without manufacturing a battle or its result.
                if (this.diagnosticStart === 'fail-once' && !this.diagnosticStartFailed) {
                    this.diagnosticStartFailed = true;
                    throw new Error('Diagnostic one-time session initialization failure');
                }
                await this.prepareActors(token);
                if (!this.isValid || token !== this.loadGeneration) return;
                this.session = new LocalSession({ sessionId: `local-${++this.round}`, mode: this.mode, practice, seed: 104729 });
                this.clockMs = 0; this.sequence = 0;
                this.motion.reset(this.session.snapshot().sessionId);
                this.motionSamples = [];
                this.clearContactFrames();
                this.seenEvents.clear(); this.trace = []; this.feedback = ''; this.feedbackUntil = 0;
                if (this.hidden) { this.session.pause(); this.changePage('paused'); }
                else this.changePage('battle');
            } catch (error) { if (this.isValid && token === this.loadGeneration) { this.clearActors(); console.error('Slap game session initialization failed', error); this.changePage('error'); } }
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
        ++this.loadGeneration;
        this.bridge.cancelAll(); this.session?.pause(); this.session = null;
        this.clearActors();
        this.seenEvents.clear(); this.trace = []; this.changePage('menu');
        this.motion.reset();
        this.motionSamples = []; this.motionDiagnosticCanvas?.removeAttribute('data-slap-motion');
        this.clearContactFrames();
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
        const poses = this.motion.sample(state, state.nowMs, [
            { root: [-.55, 0, 0], facing: 1, cheek: [.18, 1.9, .16] },
            { root: [.55, 0, 0], facing: -1, cheek: [-.18, 1.9, .16] },
        ]);
        this.pendingSkinState = state; this.pendingPoses = poses;
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
        ++this.loadGeneration; this.clearActors();
        for (const frame of this.portraitFrames) frame.destroy();
        this.frameDiagnosticCanvas?.removeAttribute('data-slap-diagnostics');
        this.motionDiagnosticCanvas?.removeAttribute('data-slap-motion');
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
        delete (globalThis as unknown as Record<string, unknown>).__SLAP_DEBUG__;
    }
}
