import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, inside } from './bootstrap-game.mjs';

export const ROLES = Object.freeze(['manager', 'veteran', 'rookie']);
const FROZEN = 'abd8f3d38e0735c59e427cae2bca1c3436cb72aa1415e07f4b3a55407630711e';
const rebuildBase = path.join(ROOT, 'game/local/asset-rebuild');
const generator = path.join(ROOT, 'tools/create-office-cast.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');
const equal = (a, b, label) => assert.deepEqual(a, b, label);
const durations = [120, 60, 60, 72, 60, 60, 60, 60, 30, 60, 60, 90, 90];
const names = ['idle', 'intro-positive', 'intro-negative', 'charge', 'attack-light', 'attack-heavy', 'recovery', 'guard', 'hit', 'counter', 'counter-recovery', 'victory', 'defeat'];
let cursor = 0;
const clips = names.map((name, index) => { const clip = { name, from: cursor / 60, to: (cursor + durations[index]) / 60, fps: 60 }; cursor += durations[index] + 2; return clip; });

/** Every existing ancestor is checked, including links that resolve back inside the project. */
export function safePath(base, target) {
  assert(!target.split(/[\\/]/).includes('..'), 'Parent traversal rejected');
  const absolute = path.resolve(target), root = path.resolve(base);
  assert(inside(root, absolute), 'Outside controlled root');
  for (let current = absolute;; current = path.dirname(current)) {
    if (fs.existsSync(current) || fs.lstatSync(path.dirname(current), { throwIfNoEntry: false })) {
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      assert(!stat?.isSymbolicLink(), 'Symlink/junction rejected');
      if (stat) assert(inside(fs.realpathSync(root), fs.realpathSync(current)), 'Linked outside root');
    }
    if (current === root) break;
  }
  return absolute;
}
function controlledRoot(root) {
  root = safePath(ROOT, path.resolve(root));
  assert(root === ROOT || inside(rebuildBase, root) && root !== rebuildBase, 'Only project or isolated rebuild roots allowed');
  return root;
}
function readAt(root, name) { return json(safePath(ROOT, path.join(root, name))); }
function frozenBytes() { const bytes = fs.readFileSync(safePath(ROOT, generator)); assert.equal(sha(bytes), FROZEN, 'Frozen generator changed'); return bytes; }
function sameClip(actual, expected) {
  assert(actual && actual.name === expected.name && actual.fps === 60, 'Semantic clip name/FPS mismatch');
  for (const field of ['from', 'to']) assert(Math.abs(actual[field] - expected[field]) < 0.00001, 'Semantic clip interval mismatch');
}

/** Fast deterministic validation: production --check additionally re-converts real FBX and reads actual library. */
export function validateCast(sourceRoot = ROOT) {
  const root = controlledRoot(sourceRoot), bytes = frozenBytes(), seen = new Set();
  const unique = id => { assert(typeof id === 'string' && /^[0-9a-f-]{36}(?:@[0-9a-f]+)?$/i.test(id), 'Invalid UUID'); assert(!seen.has(id), 'Duplicate UUID'); seen.add(id); };
  return ROLES.map(roleId => {
    const base = `game/assets/resources/office-cast/${roleId}`, m = readAt(root, `${base}/manifest.json`), s = m.source, g = m.generated;
    assert(m.schemaVersion === 1 && s?.roleId === roleId && s.provenance?.kind === 'original-procedural' && s.provenance.source === 'tools/create-office-cast.py', 'Role/original provenance mismatch');
    assert(s.rigSpecVersion === 'office-humanoid-29-v1' && s.generatorVersion === 'office-cast-1' && s.blenderVersion === '4.5.14 LTS', 'Production version mismatch');
    assert(s.provenance.author && s.provenance.license && s.facets.positive && s.facets.negative, 'Source provenance/facets missing');
    equal(s.export, { fps: 60, forward: '-Z', up: 'Y', scale: 1, leafBones: false, allActions: false, nla: false, bakeSpaceTransform: false, animationBakeRate: 60 }, 'Export contract mismatch');
    assert(g?.generatorSha256 === FROZEN && g.sourceHash === sha(Buffer.concat([bytes, Buffer.from(JSON.stringify(canonical(s)))])), 'Source hash mismatch');
    for (const name of ['character.fbx', 'portrait.png']) {
      const data = fs.readFileSync(safePath(ROOT, path.join(root, base, name))), record = g.outputs?.[name];
      assert(record?.path === `${base}/${name}` && record.bytes === data.length && record.sha256 === sha(data), 'Output hash/size/path mismatch');
      if (name.endsWith('fbx')) assert(data.subarray(0, 23).equals(Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary')) && data.readUInt32LE(23) === 7400, 'FBX signature/version mismatch');
      else assert(data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.readUInt32BE(16) === s.portrait.size && data.readUInt32BE(20) === s.portrait.size, 'PNG signature/dimensions mismatch');
    }
    const mesh = g.mesh, skin = g.convertedSkin, imports = g.imports;
    assert(mesh?.boneCount === 29 && new Set(mesh.boneNames).size === 29 && mesh.vertices > 0 && mesh.triangles > 0 && mesh.maxEvaluatedDisplacement > .2, 'Missing deform mesh/bones');
    assert(skin && skin.inverseBindMatrices === 29 && skin.blendedVertices > 0 && skin.maxInfluences >= 1 && skin.maxInfluences <= 4 && skin.maxWeightError < .00001 && skin.animationChannels >= 29, 'Missing/invalid skin, inverse bindings or weights');
    equal([...skin.boneNames].sort(), [...mesh.boneNames].sort(), 'Skin bone mismatch');
    assert(mesh.sourceClips.length === clips.length, 'Missing source clips'); mesh.sourceClips.forEach((clip, i) => sameClip(clip, clips[i]));
    assert(imports && Object.keys(imports.bonePaths).length === 29, 'Missing imported bone paths');
    for (const bone of mesh.boneNames) assert(imports.bonePaths[bone]?.startsWith('OfficeRig/Root') && imports.bonePaths[bone].split('/').at(-1) === bone && !imports.bonePaths[bone].includes('..'), 'Imported bone path mismatch');
    const model = readAt(root, `${base}/character.fbx.meta`), image = readAt(root, `${base}/portrait.png.meta`);
    assert(model.importer === 'fbx' && model.imported === true && model.uuid === imports.modelUuid, 'Model import identity mismatch');
    for (const meta of [model, image]) { unique(meta.uuid); for (const sub of Object.values(meta.subMetas)) { unique(sub.uuid); assert(sub.uuid.startsWith(`${meta.uuid}@`), 'Subasset UUID owner mismatch'); } }
    const sub = Object.values(model.subMetas), actualClips = sub.filter(v => v.importer === 'gltf-animation');
    equal(actualClips.map(v => v.name.replace(/\.animation$/, '')).sort(), [...names].sort(), 'Missing imported clips');
    equal(Object.keys(imports.clipUuids).sort(), [...names].sort(), 'Missing semantic clip UUID');
    const raw = model.userData.animationImportSettings;
    assert(raw.length === 1 && raw[0].name === skin.animationName && raw[0].duration >= 15.1 - .0001, 'Raw timeline mismatch');
    assert(raw[0].splits.length === clips.length, 'Missing semantic splits');
    for (const clip of clips) {
      sameClip(raw[0].splits.find(v => v.name === clip.name), clip);
      const imported = actualClips.find(v => v.name === `${clip.name}.animation`);
      assert(imported.uuid === imports.clipUuids[clip.name] && imported.userData.sample === 60, 'Clip UUID/sample mismatch');
      for (const key of ['from', 'to']) assert(Math.abs(imported.userData.span[key] - clip[key]) < .00001, 'Imported clip span mismatch');
    }
    assert(sub.find(v => v.importer === 'gltf-scene')?.uuid === imports.prefabUuid && sub.find(v => v.importer === 'gltf-skeleton')?.uuid === imports.skeletonUuid, 'Prefab/Skeleton reference mismatch');
    assert(Object.values(image.subMetas).find(v => v.importer === 'texture')?.uuid === imports.portraitTextureUuid, 'Portrait UUID mismatch');
    return { roleId, sourceHash: g.sourceHash, modelUuid: imports.modelUuid, skeletonUuid: imports.skeletonUuid, prefabUuid: imports.prefabUuid, portraitTextureUuid: imports.portraitTextureUuid, clips: names, metaSha256: sha(fs.readFileSync(path.join(root, base, 'character.fbx.meta'))) };
  });
}

const toolNames = new Set(['bootstrap-game.mjs', 'build-config.mjs', 'build-game.ps1', 'check-game.mjs', 'configure-wechat.mjs', 'create-office-cast.py', 'serve.mjs', 'check.mjs', 'check-character-assets.mjs']);
const settingNames = new Set(['builder', 'cocos-service', 'device', 'engine', 'program', 'project']);
export function isCopyInput(file) {
  if (file.split('/').some(p => p.startsWith('.') || !/^[A-Za-z0-9_.-]+$/.test(p))) return false;
  if (['package.json', 'tsconfig.rules.json', 'README.md', 'game/package.json', 'game/tsconfig.json'].includes(file)) return true;
  if (/^tools\/[^/]+$/.test(file)) return toolNames.has(path.posix.basename(file));
  if (/^tests\/[A-Za-z0-9.-]+\.cjs$/.test(file) || /^docs\/public\/[A-Za-z0-9-]+\.md$/.test(file)) return true;
  if (/^game\/assets\/.+\.(?:ts|meta|scene)$/.test(file)) return true;
  if (/^game\/assets\/resources\/office-cast\/(?:manager|veteran|rookie)\/manifest\.json$/.test(file)) return true;
  if (/^game\/build-config\/(?:web-desktop|wechatgame)\.json$/.test(file)) return true;
  if (/^game\/build-templates\/web-desktop\/(?:application\.ejs|index\.ejs|style\.css)$/.test(file)) return true;
  const setting = /^game\/settings\/v2\/packages\/([a-z-]+)\.json$/.exec(file);
  return !!setting && settingNames.has(setting[1]);
}
export function createRebuildTarget(name = `rebuild-${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomUUID().slice(0, 8)}`) {
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(name), 'Invalid unique rebuild name');
  safePath(ROOT, rebuildBase); fs.mkdirSync(rebuildBase, { recursive: true });
  const target = safePath(ROOT, path.join(rebuildBase, name));
  assert(!fs.existsSync(target), 'Rebuild target exists; overwrite rejected');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, '.office-cast-rebuild'), 'office-cast controlled rebuild\n', { flag: 'wx' });
  return target;
}
function run(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (log) fs.writeFileSync(safePath(ROOT, log), (result.stdout || '') + (result.stderr || ''));
  if (result.error) throw result.error;
  return { exitCode: result.status, output: (result.stdout || '') + (result.stderr || '') };
}
function frozen(root, role, option) {
  frozenBytes();
  const args = [generator, '--role', role, '--source-root', root, '--output-root', root];
  if (option) args.push(option);
  const result = run('python', args, ROOT);
  assert.equal(result.exitCode, 0, `Frozen generator ${role} ${option || 'generate'} failed: ${result.output.slice(-2000)}`);
  return { roleId: role, operation: option || 'generate', exitCode: result.exitCode, output: result.output.trim() };
}
function actualLibrary(root, record) {
  const library = id => safePath(ROOT, path.join(root, 'game/library', record.modelUuid.slice(0, 2), `${id}.json`));
  const skeleton = json(library(record.skeletonUuid)), prefab = json(library(record.prefabUuid));
  assert(skeleton.__type__ === 'cc.Skeleton' && skeleton._joints.length === 29 && skeleton._bindposes.length === 29, 'Actual imported skin/bindings missing');
  for (const matrix of skeleton._bindposes) assert(Array.from({ length:16 }, (_, i) => matrix[`m${String(i).padStart(2,'0')}`]).every(Number.isFinite), 'Nonfinite bind pose');
  const manifest = readAt(root, `game/assets/resources/office-cast/${record.roleId}/manifest.json`);
  equal([...skeleton._joints].sort(), Object.values(manifest.generated.imports.bonePaths).sort(), 'Actual Skeleton joint path mismatch');
  const renderer = prefab.find(v => v.__type__ === 'cc.SkinnedMeshRenderer'), animation = prefab.find(v => v.__type__ === 'cc.SkeletalAnimation');
  assert(renderer?._skeleton?.__uuid__ === record.skeletonUuid && renderer._mesh?.__uuid__ && renderer._skinningRoot?.__id__ !== undefined, 'Actual renderer skin link missing');
  equal(animation?._clips?.map(v => v.__uuid__).sort(), Object.values(manifest.generated.imports.clipUuids).sort(), 'Actual animation clip links missing');
  for (const id of Object.values(manifest.generated.imports.clipUuids)) assert(fs.statSync(library(id).replace(/\.json$/, '.bin')).size > 0, 'Imported clip data missing');
  return { ...record, joints: 29, bindPoseSha256: sha(Buffer.from(JSON.stringify(skeleton._bindposes))), actualSkinnedRenderer: true };
}
export function checkProduction(sourceRoot = ROOT) {
  const root = controlledRoot(sourceRoot), records = validateCast(root);
  const conversions = ROLES.map(role => frozen(root, role, '--check'));
  const roles = records.map(r => actualLibrary(root, r));
  assert(new Set(roles.map(r => r.bindPoseSha256)).size === 3, 'Independent role bind poses unexpectedly shared');
  return { passed: true, roles, conversions, boundary: 'File/import identity only; actual runtime and visual adoption are separate.' };
}
export function rebuild(name) {
  frozenBytes();
  const scan = run(process.execPath, [path.join(ROOT, 'tools/check-public-tree.mjs')], ROOT);
  assert.equal(scan.exitCode, 0, 'Public source scan failed before copy');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(isCopyInput);
  // Validate the complete copy inventory before creating the unique destination.
  for (const file of files) assert(fs.lstatSync(safePath(ROOT, path.join(ROOT, file))).isFile(), 'Only regular copy inputs allowed');
  const target = createRebuildTarget(name), reportFile = path.join(target, 'rebuild-report.json');
  const report = { schema: 1, startedAt: new Date().toISOString(), root: relative(target), frozenGeneratorSha256: FROZEN, copyInputs: [], cacheBefore: {}, generation: [], builds: [], runtimePassed: false };
  const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  try {
    for (const file of files) {
      const source = safePath(ROOT, path.join(ROOT, file)), dest = safePath(ROOT, path.join(target, file));
      const bytes = fs.readFileSync(source); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes, { flag: 'wx' });
      report.copyInputs.push({ path: file, sha256: sha(bytes), bytes: bytes.length });
    }
    for (const cache of ['library', 'temp', 'build', 'local', 'profiles']) report.cacheBefore[cache] = fs.existsSync(path.join(target, 'game', cache));
    assert(Object.values(report.cacheBefore).every(v => !v), 'Old cache/private directory copied'); save();
    for (const role of ROLES) { console.log(`Generating ${role} from frozen original source`); report.generation.push(frozen(target, role)); save(); }
    const wrapper = path.join(target, 'tools/build-game.ps1');
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`Creator fresh-copy build attempt ${attempt}`);
      const log = path.join(target, `build-attempt-${attempt}.log`), result = run('powershell', ['-NoProfile', '-File', wrapper, '-Target', 'web-desktop'], target, log);
      report.builds.push({ attempt, exitCode: result.exitCode, log: relative(log) }); save();
      if (result.exitCode !== 0 && !result.output.includes('Build inputs changed during compilation')) throw new Error(`Creator build failed; inspect ${relative(log)}`);
      const before = ROLES.map(role => sha(fs.readFileSync(path.join(target, `game/assets/resources/office-cast/${role}/manifest.json`))));
      for (const role of ROLES) frozen(target, role, '--sync-imports');
      const changed = ROLES.some((role, i) => sha(fs.readFileSync(path.join(target, `game/assets/resources/office-cast/${role}/manifest.json`))) !== before[i]);
      if (result.exitCode === 0 && !changed) { report.identity = checkProduction(target); report.build = readAt(target, 'game/build/web-desktop/build-manifest.json'); report.technicalPassed = true; report.finishedAt = new Date().toISOString(); save(); return report; }
    }
    throw new Error('Creator import identity did not stabilize after three builds');
  } catch (error) { report.error = error.message; save(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') console.log(JSON.stringify(checkProduction(), null, 2));
    else if (args[0] === '--rebuild' && (args.length === 1 || args.length === 3 && args[1] === '--name')) console.log(JSON.stringify(rebuild(args[2]), null, 2));
    else throw new Error('Usage: node tools/check-character-assets.mjs --check | --rebuild [--name UNIQUE_NAME]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
