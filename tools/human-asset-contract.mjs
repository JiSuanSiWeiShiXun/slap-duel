import assert from 'node:assert/strict';

// This is the one explicitly admitted derivative lineage. It is not a generic
// third-party-model or arbitrary texture allow-list.
export const HUMAN_GENERATOR = 'tools/create-office-human.py';
export const HUMAN_BASE = Object.freeze({
  version: '1.4.1',
  url: 'https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip',
  archiveSha256: '811f43accbb31a88266d932f8f5563b2d13586fca0ba2693aad1f5fe582b3515',
  blendSha256: '3c121505651140ceb4d69fd1d8923f7788ffadd81672f5be14845a5f2c75c137',
  object: 'GEO-body_male_realistic', license: 'CC0',
});
export const HUMAN_CLOTHING = Object.freeze({
  version: 'suits01-cc0',
  url: 'https://files2.makehumancommunity.org/asset_packs/suits01/suits01_cc0.zip',
  archiveSha256: '2b1d8676f3863b188e9eea98c1d8f234543d54c440e791d92b819f8ee1861f19',
  object: 'clothes/toigo_male_suit_3/suit3.obj',
  objSha256: '1412a998988f19696e00637afd69e64499d727a0c6ab7527f8713129990f0e43',
  textureSha256: '7a3fa6cf10d3fcc2946469efcf066e2f5898d1a9dfa10a3df4a1ff2495dc17dc',
  authors: Object.freeze(['MRT']), license: 'CC0',
});
export const HUMAN_OUTPUTS = Object.freeze(['character.fbx', 'portrait.png', 'fabric.png']);
export const HUMAN_MATERIALS = Object.freeze(['skin', 'coat', 'shirt', 'trousers', 'hair', 'iris', 'sclera', 'leather', 'identity']);
export const HUMAN_TIMELINE_FPS = 60;
export const HUMAN_TIMELINE_DURATION = 15.1;
export const HUMAN_BONES = Object.freeze(['Root', 'Pelvis', 'Spine', 'Chest', 'Neck', 'Head', 'Jaw', 'Brow.L', 'Brow.R',
  ...['L', 'R'].flatMap(side => ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Thumb', 'Fingers', 'Thigh', 'Shin', 'Foot', 'Toe'].map(name => `${name}.${side}`))]);

function object(value, label) { assert(value && typeof value === 'object' && !Array.isArray(value), `${label} object missing`); return value; }
function vector(value, label, limit = 4, nonzero = false) {
  assert(Array.isArray(value) && value.length === 3 && value.every(v => Number.isFinite(v) && Math.abs(v) <= limit), `${label} finite/bounded vector required`);
  assert(!nonzero || Math.hypot(...value) > 0.000001, `${label} cannot be zero`);
}
export function isHumanSource(source) { return source?.generatorVersion === 'office-human-2' || source?.provenance?.kind === 'cc0-derived'; }

/** Source fields are hashed alongside the selected generator by both callers. */
export function validateHumanSource(source, roleId) {
  const s = object(source, 'Human source'), p = object(s.provenance, 'Human provenance'), base = object(s.baseMesh, 'Human base');
  assert(roleId === 'manager' && s.roleId === roleId, 'Human v2 role is not admitted');
  assert(Number.isSafeInteger(s.assetRevision) && s.assetRevision >= 3, 'Human asset revision mismatch');
  assert(s.rigSpecVersion === 'office-humanoid-29-v2' && s.generatorVersion === 'office-human-2' && s.blenderVersion === '4.5.14 LTS', 'Human production version mismatch');
  assert(p.kind === 'cc0-derived' && p.source === HUMAN_GENERATOR && p.author === 'Slap Duel project' && typeof p.license === 'string' && p.license.includes('CC0'), 'Human derivative provenance mismatch');
  for (const [key, value] of Object.entries(HUMAN_BASE)) assert.equal(base[key], value, `Human base ${key} mismatch`);
  assert.deepEqual(base.authors, ['Dan Ulrich'], 'Human base author mismatch');
  const clothing = object(s.clothing, 'Human clothing');
  for (const [key, value] of Object.entries(HUMAN_CLOTHING)) assert.deepEqual(clothing[key], value, `Human clothing ${key} mismatch`);
  const runtime = object(s.runtime, 'Human runtime'), anchors = object(runtime.anchors, 'Human anchors');
  assert(runtime.boneCount === 29 && runtime.identityMaterial === 8, 'Human runtime joint/material contract mismatch');
  assert(runtime.restPose === 'human-a-rest-v2' && runtime.uvStrategy === 'single-tile-atlas', 'Human rest/atlas strategy mismatch');
  assert.deepEqual(runtime.materials?.map(name => name.toLowerCase()), HUMAN_MATERIALS, 'Human runtime material slot contract mismatch');
  assert.deepEqual(Object.keys(anchors).sort(), ['cheekLeft', 'cheekRight', 'palm'], 'Human anchor names mismatch');
  for (const name of ['palm', 'cheekLeft', 'cheekRight']) vector(anchors[name], `Human ${name} anchor`, 0.02, true);
  assert(anchors.palm[1] > 0, 'Human palm anchor must follow the hand bone');
  assert(anchors.cheekLeft[0] > 0 && anchors.cheekRight[0] < 0, 'Human cheek sides mismatch');
  const mirror = [-anchors.cheekRight[0], anchors.cheekRight[1], anchors.cheekRight[2]];
  assert(anchors.cheekLeft.every((v, i) => Math.abs(v - mirror[i]) <= 0.00001), 'Human cheek anchors are not mirrored');
  return s;
}

export function validateHumanOutputs(generated) {
  const outputs = object(generated?.outputs, 'Human outputs');
  assert.deepEqual(Object.keys(outputs).sort(), [...HUMAN_OUTPUTS].sort(), 'Human output inventory mismatch');
  return HUMAN_OUTPUTS;
}

/** These are source-production facts, independently rechecked against FBX and
 * Creator by the production command. They do not certify appearance or adoption. */
export function validateHumanMeshContract(mesh) {
  object(mesh, 'Human mesh');
  assert.deepEqual(mesh.timelineFps, { fps: HUMAN_TIMELINE_FPS, fpsBase: 1 }, 'Human source scene timebase must be 60 FPS / base 1');
  assert(mesh.restPose === 'human-a-rest-v2' && mesh.uvStrategy === 'single-tile-atlas' && mesh.materialCount === 9 && mesh.baseObject === HUMAN_BASE.object, 'Human production mesh declaration mismatch');
  const audit = object(mesh.semanticWeightAudit, 'Human semantic weight audit');
  assert(Number.isSafeInteger(mesh.vertices) && mesh.vertices > 0 && Number.isSafeInteger(audit.lowerBodyVertices) &&
    audit.lowerBodyVertices > 0 && audit.lowerBodyVertices <= mesh.vertices, 'Human lower-body weight audit sample invalid');
  assert(audit.misassignedLowerBody === 0, 'Human lower-body vertices assigned to arm or hand bones');
  assert.deepEqual([...mesh.boneNames].sort(), [...HUMAN_BONES].sort(), 'Human semantic bones mismatch');
  const rest = object(mesh.restJoints, 'Human rest joints');
  assert.deepEqual(Object.keys(rest).sort(), [...HUMAN_BONES].sort(), 'Human rest joint inventory mismatch');
  for (const name of HUMAN_BONES) {
    const joint = object(rest[name], `Human rest joint ${name}`);
    vector(joint.head, `Human rest ${name} head`); vector(joint.tail, `Human rest ${name} tail`);
    assert(Math.hypot(...joint.head.map((v, i) => v - joint.tail[i])) > 0.0001, 'Human rest bone has zero length');
    assert(name === 'Root' ? joint.parent === null : HUMAN_BONES.includes(joint.parent) && joint.parent !== name, 'Human rest parent mismatch');
    const visited = new Set([name]);
    for (let parent = joint.parent; parent !== null; parent = rest[parent]?.parent) {
      assert(typeof parent === 'string' && rest[parent] && !visited.has(parent), 'Human rest parent chain invalid'); visited.add(parent);
    }
  }
  assert.deepEqual(mesh.materialNames?.map(name => name.toLowerCase()), HUMAN_MATERIALS, 'Human material slot contract mismatch');
  const uv = object(mesh.uvAtlas, 'Human UV atlas');
  assert(uv.layers === 1 && uv.tileCount === 1, 'Human single atlas contract mismatch');
  for (const key of ['min', 'max']) assert(Array.isArray(uv[key]) && uv[key].length === 2 && uv[key].every(v => Number.isFinite(v) && v >= -0.00001 && v <= 1.00001), 'Human UV atlas bounds invalid');
  assert(uv.max.every((v, i) => v - uv.min[i] > 0.001), 'Human UV atlas is empty');
}

/** Bind declared clip frames to independently read FBX/glTF sampler times and
 * Creator's raw import duration. A 60 FPS bake step cannot repair a 24 FPS scene. */
export function validateHumanTimelineContract(mesh, skin, rawDuration) {
  object(mesh, 'Human mesh'); object(skin, 'Human converted skin');
  assert.deepEqual(mesh.timelineFps, { fps: HUMAN_TIMELINE_FPS, fpsBase: 1 }, 'Human source scene timebase must be 60 FPS / base 1');
  assert(Array.isArray(mesh.sourceClips) && mesh.sourceClips.length === 13 && mesh.sourceClips.every(clip => clip.fps === HUMAN_TIMELINE_FPS) &&
    Number.isFinite(mesh.sourceClips.at(-1).to) && Math.abs(mesh.sourceClips.at(-1).to - HUMAN_TIMELINE_DURATION) < .00001,
  'Human source clip timeline must end at 15.1 seconds');
  const expected = mesh.sourceClips.at(-1).to, tolerance = 1 / HUMAN_TIMELINE_FPS + .0001;
  assert(skin.animationFps === HUMAN_TIMELINE_FPS && Number.isFinite(skin.animationDuration) &&
    Math.abs(skin.animationDuration - expected) <= tolerance, 'Human converted animation duration/FPS mismatch (expected 15.1s at 60 FPS)');
  assert(Number.isFinite(rawDuration) && Math.abs(rawDuration - expected) <= tolerance,
    'Human Creator raw animation duration mismatch (expected final clip end within one frame)');
}
