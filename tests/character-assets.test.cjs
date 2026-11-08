const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const api = import(pathToFileURL(path.join(root, 'tools/check-character-assets.mjs')).href);
const humanApi = import(pathToFileURL(path.join(root, 'tools/human-asset-contract.mjs')).href);
const fixtures = path.join(root, 'game/local/asset-rebuild');
function removeFixture(dir) {
  const absolute = path.resolve(dir);
  assert(absolute.startsWith(path.resolve(fixtures) + path.sep));
  fs.rmSync(absolute, { recursive: true });
}
function fixture(t) {
  fs.mkdirSync(fixtures, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtures, 'test-'));
  t.after(() => removeFixture(dir));
  for (const role of ['manager', 'veteran', 'rookie']) {
    const relative = `game/assets/resources/office-cast/${role}`;
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relative, 'manifest.json')));
    const outputs = Object.keys(manifest.generated.outputs);
    const copied = ['manifest.json', 'character.fbx.meta', ...outputs, ...outputs.filter(name => name.endsWith('.png')).map(name => `${name}.meta`)];
    for (const name of copied)
      fs.copyFileSync(path.join(root, relative, name), path.join(dir, relative, name));
  }
  return dir;
}
function mutate(dir, role, fn, name = 'manifest.json') {
  const file = path.join(dir, `game/assets/resources/office-cast/${role}/${name}`);
  const value = JSON.parse(fs.readFileSync(file, 'utf8')); fn(value);
  fs.writeFileSync(file, JSON.stringify(value));
}
test('three actual admitted role lineages validate independently with stable imports', async t => {
  const { validateCast } = await api;
  const result = validateCast(fixture(t));
  assert.deepEqual(result.map(r => r.roleId), ['manager', 'veteran', 'rookie']);
  assert.equal(new Set(result.map(r => r.skeletonUuid)).size, 3);
});
for (const [name, role, fn, file] of [
  ['source hash mismatch', 'manager', m => m.generated.sourceHash = '0'.repeat(64)],
  ['missing skin', 'rookie', m => delete m.generated.convertedSkin],
  ['missing semantic clip', 'veteran', m => delete m.generated.imports.clipUuids.counter],
  ['role mismatch', 'manager', m => m.source.roleId = 'rookie'],
  ['bad inverse bindings', 'manager', m => m.generated.convertedSkin.inverseBindMatrices = 0],
  ['invalid normalized weights', 'manager', m => m.generated.convertedSkin.maxWeightError = 0.1],
  ['24 FPS scene timebase', 'manager', m => m.generated.mesh.timelineFps.fps = 24],
  ['37.75 second converted timeline', 'manager', m => m.generated.convertedSkin.animationDuration = 37.75],
  ['24 FPS converted timeline', 'manager', m => m.generated.convertedSkin.animationFps = 24],
  ['37.75 second Creator raw timeline', 'manager', m => m.userData.animationImportSettings[0].duration = 37.75, 'character.fbx.meta'],
  ['invalid clip interval', 'manager', m => m.generated.mesh.sourceClips[4].to += 0.01],
  ['import split mismatch', 'manager', m => m.userData.animationImportSettings[0].splits[0].to = 99, 'character.fbx.meta'],
]) test(`rejects ${name}`, async t => {
  const { validateCast } = await api; const dir = fixture(t); mutate(dir, role, fn, file);
  assert.throws(() => validateCast(dir));
});
test('rejects UUID reuse between otherwise valid roles', async t => {
  const { validateCast } = await api, dir = fixture(t);
  const manager = JSON.parse(fs.readFileSync(path.join(dir, 'game/assets/resources/office-cast/manager/portrait.png.meta')));
  mutate(dir, 'rookie', m => m.uuid = manager.uuid, 'portrait.png.meta');
  assert.throws(() => validateCast(dir), /UUID/);
});
test('rejects binary mismatch even when file exists', async t => {
  const { validateCast } = await api, dir = fixture(t);
  fs.appendFileSync(path.join(dir, 'game/assets/resources/office-cast/manager/character.fbx'), 'changed');
  assert.throws(() => validateCast(dir), /hash|size/i);
});
test('rejects forbidden PNG metadata even when its declared hash is updated', async t => {
  const { validateCast } = await api, dir = fixture(t), file = path.join(dir, 'game/assets/resources/office-cast/manager/portrait.png');
  const bytes = fs.readFileSync(file), chunk = Buffer.alloc(12); chunk.write('tEXt', 4);
  // The forbidden type is rejected before its CRC/content can be accepted.
  const altered = Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]); fs.writeFileSync(file, altered);
  mutate(dir, 'manager', m => { const record = m.generated.outputs['portrait.png']; record.bytes = altered.length; record.sha256 = crypto.createHash('sha256').update(altered).digest('hex'); });
  assert.throws(() => validateCast(dir), /metadata\/chunk rejected/);
});
test('import synchronization cannot absorb a changed stable UUID', async () => {
  const { assertStableImports } = await api;
  const baseline = { modelUuid: 'stable', clipUuids: { idle: 'stable@idle' } };
  assert.doesNotThrow(() => assertStableImports(baseline, structuredClone(baseline)));
  assert.throws(() => assertStableImports(baseline, { ...baseline, modelUuid: 'changed' }), /identity drifted/);
});
test('private output receipt lists new artifacts and excludes copied inputs', async t => {
  const { generatedInventory } = await api, dir = fixture(t);
  const copied = ['game/assets/resources/office-cast/manager/manifest.json'];
  const actual = generatedInventory(dir, copied);
  assert(!actual.some(v => copied.includes(v.path)));
  const fbx = actual.find(v => v.path === 'game/assets/resources/office-cast/manager/character.fbx');
  assert(fbx.bytes > 0 && /^[a-f0-9]{64}$/.test(fbx.sha256));
  assert.throws(() => generatedInventory(root), /isolated copies/);
});
test('copy whitelist excludes generated binaries, private identity, caches and portable', async () => {
  const { isCopyInput } = await api;
  for (const file of ['game/assets/scripts/SlapGame.ts', 'game/assets/resources/office-cast/manager/manifest.json', 'game/assets/resources/office-cast/manager/character.fbx.meta', 'tools/build-game.ps1']) assert.equal(isCopyInput(file), true, file);
  for (const file of ['game/library/old.json', 'game/temp/old.json', 'game/build/index.html', '.env', '.planning/STATE.md', 'game/settings/v2/packages/information.json', 'game/local/wechat-config.json', 'game/local/toolchain/blender.exe', 'game/assets/resources/office-cast/manager/character.fbx', 'game/assets/.secret']) assert.equal(isCopyInput(file), false, file);
});
test('fresh target refuses overwrite and escaping names', async t => {
  const { createRebuildTarget } = await api;
  const name = `test-target-${crypto.randomUUID()}`, dir = createRebuildTarget(name);
  t.after(() => removeFixture(dir));
  assert.throws(() => createRebuildTarget(name), /exist|overwrite/i);
  for (const bad of ['../escape', '/outside', 'nested/name', '.hidden']) assert.throws(() => createRebuildTarget(bad));
});
test('rejects a junction before traversal or write', async t => {
  const { safePath } = await api;
  fs.mkdirSync(fixtures, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtures, 'test-links-'));
  t.after(() => removeFixture(dir));
  fs.symlinkSync(path.join(root, 'docs'), path.join(dir, 'link'), 'junction');
  assert.throws(() => safePath(root, path.join(dir, 'link/public')), /link|junction/i);
  fs.symlinkSync(path.dirname(root), path.join(dir, 'escape'), 'junction');
  assert.throws(() => safePath(root, path.join(dir, 'escape/outside')), /link|junction/i);
});

async function humanSourceFixture() {
  const { HUMAN_BASE, HUMAN_CLOTHING, HUMAN_MATERIALS } = await humanApi;
  return { roleId: 'manager', assetRevision: 3, generatorVersion: 'office-human-2', rigSpecVersion: 'office-humanoid-29-v2', blenderVersion: '4.5.14 LTS',
    provenance: { kind: 'cc0-derived', source: 'tools/create-office-human.py', author: 'Slap Duel project', license: 'CC0 base with project derivative' },
    baseMesh: { ...HUMAN_BASE, authors: ['Dan Ulrich'] },
    clothing: structuredClone(HUMAN_CLOTHING),
    runtime: { boneCount: 29, identityMaterial: 8, materials: [...HUMAN_MATERIALS], restPose: 'human-a-rest-v2', uvStrategy: 'single-tile-atlas',
      anchors: { palm: [0, .0007, 0], cheekLeft: [.0012, .0004, .0015], cheekRight: [-.0012, .0004, .0015] } } };
}
test('v2 declaration admits only the fixed CC0 base and explicit runtime contract', async () => {
  const { validateHumanSource } = await humanApi;
  const source = await humanSourceFixture();
  assert.doesNotThrow(() => validateHumanSource(source, 'manager'));
  // The fixture tests declarations only, not the existence/appearance of a model.
});
for (const [name, change] of [
  ['foreign source URL', s => s.baseMesh.url = 'https://example.com/body.zip'],
  ['foreign source archive', s => s.baseMesh.archiveSha256 = '0'.repeat(64)],
  ['foreign blend', s => s.baseMesh.blendSha256 = '0'.repeat(64)],
  ['other selected object', s => s.baseMesh.object = 'GEO-body_male_stylized'],
  ['missing author', s => s.baseMesh.authors = []],
  ['missing CC0 license', s => s.baseMesh.license = 'unknown'],
  ['foreign clothing URL', s => s.clothing.url = 'https://example.com/suit.zip'],
  ['foreign clothing archive', s => s.clothing.archiveSha256 = '0'.repeat(64)],
  ['foreign clothing mesh', s => s.clothing.objSha256 = '0'.repeat(64)],
  ['foreign clothing texture', s => s.clothing.textureSha256 = '0'.repeat(64)],
  ['other clothing object', s => s.clothing.object = 'other.obj'],
  ['missing clothing CC0', s => s.clothing.license = 'unknown'],
  ['missing clothing author', s => s.clothing.authors = []],
  ['false original claim', s => s.provenance.kind = 'original-procedural'],
  ['unknown generator', s => s.provenance.source = 'tools/other.py'],
  ['other role', s => s.roleId = 'rookie'],
  ['old rig under new lineage', s => s.rigSpecVersion = 'office-humanoid-29-v1'],
  ['wrong joint contract', s => s.runtime.boneCount = 28],
  ['wrong identity slot', s => s.runtime.identityMaterial = 1],
  ['old rest strategy', s => s.runtime.restPose = 'legacy-t-pose'],
  ['multi-tile UV strategy', s => s.runtime.uvStrategy = 'source-udim'],
  ['wrong material meaning', s => s.runtime.materials[8] = 'skin'],
  ['missing palm', s => delete s.runtime.anchors.palm],
  ['zero palm', s => s.runtime.anchors.palm = [0, 0, 0]],
  ['nonfinite anchor', s => s.runtime.anchors.palm[1] = Infinity],
  ['oversized anchor', s => s.runtime.anchors.palm[1] = 5],
  ['wrong cheek side', s => s.runtime.anchors.cheekRight[0] *= -1],
  ['different cheek heights', s => s.runtime.anchors.cheekRight[1] += .001],
]) test(`v2 declaration rejects ${name}`, async () => {
  const { validateHumanSource } = await humanApi, source = await humanSourceFixture();
  change(source); assert.throws(() => validateHumanSource(source, 'manager'));
});
test('v2 output inventory rejects extra images, missing fabric and undeclared paths', async () => {
  const { validateHumanOutputs } = await humanApi;
  const generated = { outputs: { 'character.fbx': {}, 'portrait.png': {}, 'fabric.png': {} } };
  assert.doesNotThrow(() => validateHumanOutputs(generated));
  for (const changed of [
    { outputs: { ...generated.outputs, 'other.png': {} } },
    { outputs: { 'character.fbx': {}, 'portrait.png': {} } },
    { outputs: { ...generated.outputs, '../fabric.png': {} } },
  ]) assert.throws(() => validateHumanOutputs(changed));
});
async function humanMeshFixture() {
  const { HUMAN_BONES, HUMAN_MATERIALS } = await humanApi;
  return { vertices: 100, timelineFps: { fps: 60, fpsBase: 1 }, semanticWeightAudit: { lowerBodyVertices: 40, misassignedLowerBody: 0 }, boneNames: [...HUMAN_BONES], materialNames: [...HUMAN_MATERIALS], materialCount: 9, baseObject: 'GEO-body_male_realistic', restPose: 'human-a-rest-v2', uvStrategy: 'single-tile-atlas', uvAtlas: { layers: 1, tileCount: 1, min: [0, 0], max: [1, 1] },
    restJoints: Object.fromEntries(HUMAN_BONES.map((name, i) => [name, { head: [i * .01, 0, 0], tail: [i * .01, .1, 0], parent: name === 'Root' ? null : 'Root' }])) };
}
test('v2 mesh declarations require actual rest inventory, no cycles, material slots and one bounded atlas', async () => {
  const { validateHumanMeshContract } = await humanApi, mesh = await humanMeshFixture();
  assert.doesNotThrow(() => validateHumanMeshContract(mesh));
  for (const change of [
    m => delete m.restJoints.Head,
    m => m.restJoints.Head.parent = 'Head',
    m => { m.restJoints.Head.parent = 'Neck'; m.restJoints.Neck.parent = 'Head'; },
    m => m.restJoints.Head.tail = m.restJoints.Head.head,
    m => m.restJoints.Head.head[0] = NaN,
    m => m.boneNames[0] = 'Other',
    m => m.materialNames[8] = 'skin',
    m => m.uvAtlas.tileCount = 24,
    m => m.uvAtlas.max = [4, 6],
    m => m.uvAtlas.min = m.uvAtlas.max,
  ]) { const changed = structuredClone(mesh); change(changed); assert.throws(() => validateHumanMeshContract(changed)); }
});

test('v2 rejects the actual 24 FPS to 37.75 second export regression at every timeline boundary', async () => {
  const { validateHumanTimelineContract } = await humanApi;
  const mesh = { timelineFps: { fps: 60, fpsBase: 1 }, sourceClips: Array.from({ length: 13 }, () => ({ fps: 60, to: 15.1 })) };
  const skin = { animationDuration: 15.1, animationFps: 60 };
  assert.doesNotThrow(() => validateHumanTimelineContract(mesh, skin, 15.1));
  assert.doesNotThrow(() => validateHumanTimelineContract(mesh, { ...skin, animationDuration: 15.1 - 1 / 60 }, 15.1 + 1 / 60));
  for (const [changedMesh, changedSkin, raw] of [
    [{ ...mesh, timelineFps: { fps: 24, fpsBase: 1 } }, skin, 15.1],
    [{ ...mesh, timelineFps: { fps: 60, fpsBase: 1.001 } }, skin, 15.1],
    [{ ...mesh, timelineFps: undefined }, skin, 15.1],
    [mesh, { ...skin, animationDuration: 37.75 }, 15.1],
    [mesh, { ...skin, animationFps: 24 }, 15.1],
    [mesh, { ...skin, animationDuration: undefined }, 15.1],
    [mesh, { ...skin, animationDuration: NaN }, 15.1],
    [mesh, skin, 37.75], [mesh, skin, undefined], [mesh, skin, Infinity],
    [mesh, skin, 15.1 + 2 / 60], [mesh, { ...skin, animationDuration: 15.1 - 2 / 60 }, 15.1],
    [{ ...mesh, sourceClips: [{ fps: 60, to: 37.75 }] }, { animationDuration: 37.75, animationFps: 60 }, 37.75],
  ]) assert.throws(() => validateHumanTimelineContract(changedMesh, changedSkin, raw));
});
test('v2 lower-body semantic weights require a real sample and zero arm/hand assignments', async () => {
  const { validateHumanMeshContract } = await humanApi, mesh = await humanMeshFixture();
  assert.doesNotThrow(() => validateHumanMeshContract(mesh));
  for (const change of [
    m => delete m.semanticWeightAudit,
    m => m.semanticWeightAudit.lowerBodyVertices = 0,
    m => m.semanticWeightAudit.lowerBodyVertices = 101,
    m => m.semanticWeightAudit.lowerBodyVertices = 40.5,
    m => m.semanticWeightAudit.misassignedLowerBody = 1,
    m => m.semanticWeightAudit.misassignedLowerBody = -1,
  ]) { const changed = structuredClone(mesh); change(changed); assert.throws(() => validateHumanMeshContract(changed)); }
});
