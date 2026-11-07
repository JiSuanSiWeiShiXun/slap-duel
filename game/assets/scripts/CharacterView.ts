import { Node, Prefab, instantiate, SkeletalAnimation, SkinnedMeshRenderer, AnimationState, Vec3, Quat, Layers, Color } from 'cc';
import { BattleState } from './core/Battle';
import { Point, HandId } from './ParryMotion';
import { CharacterSample, characterContacts, solveTwoBone, ArmSolution, ContactAnchors } from './CharacterTimeline';

export type RoleId = 'manager' | 'veteran' | 'rookie';
export interface CastManifest {
  schemaVersion: number;
  source: { roleId: RoleId; displayName: string; facets: {positive: string; negative: string};
    appearance: {cloth: string; outfit: string}; proportions: {height: number; arm: number};
    motionProfile: {energy: number; slouch: number; chin: number; lean: number; smirk: number} };
  generated: {sourceHash: string; imports: {prefabUuid: string; skeletonUuid: string; portraitTextureUuid: string;
    bonePaths: Record<string,string>; clipUuids: Record<string,string>}};
}
interface Actor {
  root: Node; animation: SkeletalAnimation; bones: Record<string,Node>; renderers: SkinnedMeshRenderer[];
  manifest: CastManifest; side: 0|1; states: Map<string,AnimationState>; clip: string;
  palm: Record<HandId,Vec3>; cheek: Vec3; contacts: Partial<Record<HandId,ArmSolution & {actualError: number}>>;
}
const point = (v: Readonly<Vec3>): Point => [v.x,v.y,v.z];

/** Sole owner of instantiated skins. Shared Prefab/Texture templates belong to the loader. */
export class CharacterView {
  private actors: Actor[]=[];
  private newSample=false;
  get count(): number { return this.actors.length; }

  clear(): void {
    this.newSample=false;
    for (const a of this.actors) { a.root.active=false; a.animation.stop(); a.root.destroy(); }
    this.actors=[];
  }
  prepare(parent: Node, manifests: readonly CastManifest[], templates: readonly Prefab[]): void {
    this.clear();
    try {
      for (const side of [0,1] as const) {
        const manifest=manifests[side], root=instantiate(templates[side]);
        root.active=false; parent.addChild(root);
        root.setPosition(side===0?-.55:.55,0,0); root.setRotationFromEuler(0,side===0?25:-25,0);
        const animation=root.getComponent(SkeletalAnimation)||root.getComponentInChildren(SkeletalAnimation);
        const renderers=root.getComponentsInChildren(SkinnedMeshRenderer);
        if (!animation || !renderers.length || renderers.some(r=>!r.mesh||!r.skeleton||r.skeleton.joints.length!==29)) { root.destroy(); throw new Error('Character has no valid29-joint skin'); }
        // Configure BEFORE first activation/onLoad creates animation states.
        animation.useBakedAnimation=false; root.active=true;
        const actor: Actor={root,animation,renderers,manifest,side,bones:{},states:new Map(),clip:'',palm:{lead:new Vec3(),rear:new Vec3()},cheek:new Vec3(),contacts:{}};
        this.actors.push(actor);
        for (const [name,path] of Object.entries(manifest.generated.imports.bonePaths)) {
          const bone=root.getChildByPath(path); if(!bone) throw new Error(`Character bone missing: ${name}`); actor.bones[name]=bone;
        }
        for (const name of Object.keys(manifest.generated.imports.clipUuids)) {
          const state=animation.getState(name); if(!state) throw new Error(`Character clip missing: ${name}`); actor.states.set(name,state);
        }
        if (!actor.states.has('counter')||!actor.states.has('idle')) throw new Error('Combat animation import incomplete');
        for (const renderer of renderers) {
          renderer.node.layer=Layers.Enum.DEFAULT;
          // Rookie material1 is the badge stripe; material2 also owns eye whites/highlights.
          renderer.getMaterialInstance(1)?.setProperty('mainColor',new Color(side===0?'#73C5D5':'#E6A17A'));
        }
      }
    } catch(error) { this.clear(); throw error; }
  }

  /** Called in Component.update, before the engine applies its animation blend buffer. */
  sample(samples: readonly CharacterSample[]): void {
    for (const a of this.actors) {
      const sample=samples[a.side], state=a.states.get(sample.semanticClip);
      if(!state) throw new Error(`Required combat clip not loaded: ${sample.semanticClip}`);
      if(a.clip!==sample.semanticClip) { a.animation.stop(); a.animation.play(sample.semanticClip); state.pause(); a.clip=sample.semanticClip; }
      state.setTime(sample.normalizedTime*state.duration); state.sample();
      a.root.setPosition((a.side===0?-.55:.55)+(a.side===0?1:-1)*sample.lunge,0,0);
    }
    this.newSample=true;
  }
  private handBone(a: Actor, hand: HandId): Node {
    const side=hand==='lead'?(a.side===0?'L':'R'):(a.side===0?'R':'L'); return a.bones[`Hand.${side}`];
  }
  private readPalm(a: Actor,hand: HandId): void { Vec3.transformMat4(a.palm[hand],new Vec3(0,.00095,0),this.handBone(a,hand).worldMatrix); }

  private solveArm(a: Actor, hand: HandId, palm: Point): void {
    const side=hand==='lead'?(a.side===0?'L':'R'):(a.side===0?'R':'L');
    const upper=a.bones[`UpperArm.${side}`], fore=a.bones[`Forearm.${side}`], wrist=this.handBone(a,hand);
    const shoulder=upper.worldPosition.clone(), elbow=fore.worldPosition.clone(), end=wrist.worldPosition.clone();
    // Height is already baked into translations; measure the actual matrix-scaled palm offset.
    this.readPalm(a,hand); const offset=Vec3.distance(a.palm[hand],end);
    const solved=solveTwoBone(point(shoulder),Vec3.distance(shoulder,elbow),Vec3.distance(elbow,end),palm,offset);
    const orient=(bone: Node,target: Point)=>{
      const up=Vec3.subtract(new Vec3(),new Vec3(...target),bone.worldPosition).normalize();
      const normal=new Vec3(0,0,side==='L'?1:-1);
      const right=Vec3.subtract(new Vec3(),normal,Vec3.multiplyScalar(new Vec3(),up,Vec3.dot(normal,up))).normalize();
      bone.setWorldRotation(Quat.fromAxes(new Quat(),right,up,Vec3.cross(new Vec3(),right,up).normalize()));
    };
    orient(upper,solved.elbow); orient(fore,solved.wrist);
    wrist.setWorldRotation(Quat.fromAxes(new Quat(),new Vec3(0,0,side==='L'?1:-1),Vec3.UP,new Vec3(side==='L'?-1:1,0,0)));
    this.readPalm(a,hand);
    a.contacts[hand]={...solved,actualError:Vec3.distance(a.palm[hand],new Vec3(...palm))};
  }

  /** Called only in lateUpdate, after engine animation apply. Never samples again here. */
  correct(state: Readonly<BattleState>): void {
    // Re-solving an already corrected guard on a paused frame would creep toward its target.
    if(this.actors.length!==2 || !this.newSample) return;
    if(this.newSample) {
      const chest=this.actors[1].bones.Chest,q=chest.rotation; chest.setRotation(new Quat(q.x,-q.y,-q.z,q.w));
      this.newSample=false;
    }
    for(const a of this.actors) {
      Vec3.transformMat4(a.cheek,new Vec3((a.side===0?1:-1)*.0018,.0022,.0016),a.bones.Head.worldMatrix);
      this.readPalm(a,'lead'); this.readPalm(a,'rear'); a.contacts={};
    }
    const anchors=this.actors.map(a=>({root:point(a.root.worldPosition),cheek:point(a.cheek),leadPalm:point(a.palm.lead),rearPalm:point(a.palm.rear)})) as [ContactAnchors,ContactAnchors];
    const targets=characterContacts(state,anchors);
    for(const a of this.actors) for(const hand of ['lead','rear'] as const) {
      const target=targets[a.side][hand]; if(target) this.solveArm(a,hand,target);
    }
  }
  measurements() { return this.actors.map(a=>({leadPalm:point(a.palm.lead),rearPalm:point(a.palm.rear),cheek:point(a.cheek),head:point(a.bones.Head.worldPosition)})); }
  evidence() {
    return this.actors.map(a=>({roleId:a.manifest.source.roleId,sourceHash:a.manifest.generated.sourceHash,
      prefabUuid:a.manifest.generated.imports.prefabUuid,skeletonUuid:a.manifest.generated.imports.skeletonUuid,
      skinnedRenderers:a.renderers.length,joints:Object.keys(a.bones).length,clip:a.clip,useBakedAnimation:a.animation.useBakedAnimation,
      sampledTime:a.states.get(a.clip)?.time??null,motionProfile:a.manifest.source.motionProfile,identityMaterial:1,contacts:a.contacts,
      actual:{...this.measurements()[a.side],pelvis:point(a.bones.Pelvis.worldPosition),root:point(a.root.worldPosition)}}));
  }
}
