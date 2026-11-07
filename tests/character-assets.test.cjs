const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const api = import(pathToFileURL(path.join(root, 'tools/check-character-assets.mjs')).href);
const fixtures = path.join(root, 'game/local/asset-rebuild');
function fixture(t) {
  fs.mkdirSync(fixtures, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtures, 'test-'));
  for (const role of ['manager', 'veteran', 'rookie']) {
    const relative = `game/assets/resources/office-cast/${role}`;
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
    for (const name of ['manifest.json', 'character.fbx', 'character.fbx.meta', 'portrait.png', 'portrait.png.meta'])
      fs.copyFileSync(path.join(root, relative, name), path.join(dir, relative, name));
  }
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}
function mutate(dir, role, fn, name = 'manifest.json') {
  const file = path.join(dir, `game/assets/resources/office-cast/${role}/${name}`);
  const value = JSON.parse(fs.readFileSync(file, 'utf8')); fn(value);
  fs.writeFileSync(file, JSON.stringify(value));
}
test('three actual original roles validate independently with stable imports', async t => {
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
test('copy whitelist excludes generated binaries, private identity, caches and portable', async () => {
  const { isCopyInput } = await api;
  for (const file of ['game/assets/scripts/SlapGame.ts', 'game/assets/resources/office-cast/manager/manifest.json', 'game/assets/resources/office-cast/manager/character.fbx.meta', 'tools/build-game.ps1']) assert.equal(isCopyInput(file), true, file);
  for (const file of ['game/library/old.json', 'game/temp/old.json', 'game/build/index.html', '.env', '.planning/STATE.md', 'game/settings/v2/packages/information.json', 'game/local/wechat-config.json', 'game/local/toolchain/blender.exe', 'game/assets/resources/office-cast/manager/character.fbx', 'game/assets/.secret']) assert.equal(isCopyInput(file), false, file);
});
test('fresh target refuses overwrite and escaping names', async t => {
  const { createRebuildTarget } = await api;
  const name = `test-target-${crypto.randomUUID()}`, dir = createRebuildTarget(name);
  t.after(() => fs.rmSync(dir, { recursive: true }));
  assert.throws(() => createRebuildTarget(name), /exist|overwrite/i);
  for (const bad of ['../escape', '/outside', 'nested/name', '.hidden']) assert.throws(() => createRebuildTarget(bad));
});
test('rejects a junction before traversal or write', async t => {
  const { safePath } = await api;
  fs.mkdirSync(fixtures, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtures, 'test-links-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  fs.symlinkSync(path.join(root, 'docs'), path.join(dir, 'link'), 'junction');
  assert.throws(() => safePath(root, path.join(dir, 'link/public')), /link|junction/i);
});
