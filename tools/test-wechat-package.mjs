import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectPath } from './bootstrap-game.mjs';
import { checkWechatPackage, MAIN_RAW_BYTE_LIMIT } from './check-wechat-package.mjs';

function fixture() {
  const parent = projectPath('game/local/tooling-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'wechat-package-'));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  const game = { subpackages: [{ name: 'resources', root: 'subpackages/resources/' }] };
  const settings = { assets: { subpackages: ['resources'], preloadBundles: [{ bundle: 'resources' }, { bundle: 'main' }],
    projectBundles: ['internal', 'resources', 'main'], remoteBundles: [] } };
  const resource = { name: 'resources', importBase: 'import', nativeBase: 'native', uuids: ['resource-id'], paths: { 0: ['role', 0] } };
  for (const file of ['game.js', 'src/system.bundle.js', 'src/polyfills.bundle.js', 'cocos-js/cc.js',
    'assets/main/index.js', 'assets/internal/index.js', 'subpackages/resources/game.js',
    'assets/main/import/scene.json', 'assets/internal/import/builtin.json', 'subpackages/resources/import/role.json',
    'subpackages/resources/native/texture.png']) write(file, 'fixture');
  write('game.json', game); write('src/settings.json', settings);
  write('assets/main/config.json', { name: 'main' }); write('assets/internal/config.json', { name: 'internal' });
  write('subpackages/resources/config.json', resource);
  return { root, write, game, settings, resource };
}

test('a large resource subpackage does not count toward the conservative main budget', () => {
  const f = fixture();
  f.write('subpackages/resources/native/large.bin', Buffer.alloc(MAIN_RAW_BYTE_LIMIT + 1));
  const before = fs.readdirSync(f.root);
  const result = checkWechatPackage(f.root);
  assert.equal(result.passed, true);
  assert.ok(result.totalRawBytes > MAIN_RAW_BYTE_LIMIT);
  assert.ok(result.mainRawBytes < MAIN_RAW_BYTE_LIMIT);
  assert.equal(result.totalRawBytes, result.mainRawBytes + result.subpackages[0].rawBytes);
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.match(result.acceptance, /official preview/);
});

test('the original undistributed resources output and an oversized main package fail', () => {
  const f = fixture();
  f.write('game.json', { subpackages: [] }); f.settings.assets.subpackages = []; f.write('src/settings.json', f.settings);
  assert.throws(() => checkWechatPackage(f.root), /declared local subpackage/);
  const sized = fixture();
  sized.write('assets/main/native/large.bin', Buffer.alloc(MAIN_RAW_BYTE_LIMIT + 1));
  assert.throws(() => checkWechatPackage(sized.root), /main raw bytes .* exceed/);
});

test('declaration mismatch, duplicate bundles, and missing loadable resources fail', () => {
  for (const mutate of [
    f => { f.settings.assets.subpackages = ['another']; f.write('src/settings.json', f.settings); },
    f => { f.game.subpackages.push(f.game.subpackages[0]); f.write('game.json', f.game); },
    f => { f.settings.assets.subpackages.push('resources'); f.write('src/settings.json', f.settings); },
    f => { f.resource.paths = {}; f.write('subpackages/resources/config.json', f.resource); },
    f => { f.write('subpackages/resources/game.js', ''); },
    f => { f.settings.assets.preloadBundles = [{ bundle: 'main' }]; f.write('src/settings.json', f.settings); },
    f => { f.write('assets/internal/index.js', ''); },
    f => { f.settings.assets.remoteBundles = ['resources']; f.write('src/settings.json', f.settings); },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => checkWechatPackage(f.root), /WeChat package:/);
  }
});

test('escaped, aliased, or undeclared roots cannot undercount the main package', () => {
  for (const root of ['../outside/', '/absolute/', 'C:/outside/', 'subpackages\\resources\\',
    'subpackages/resources/../other/', 'subpackages//resources/', 'assets/main/']) {
    const f = fixture(); f.game.subpackages[0].root = root; f.write('game.json', f.game);
    assert.throws(() => checkWechatPackage(f.root), /root must match/);
  }
  const orphan = fixture(); orphan.write('subpackages/unregistered/data.bin', 'not declared');
  assert.throws(() => checkWechatPackage(orphan.root), /undeclared subpackage/);
  const duplicate = fixture(); duplicate.write('assets/resources/native/stale.bin', 'stale main copy');
  assert.throws(() => checkWechatPackage(duplicate.root), /stale main-package copy/);
});

test('the checker refuses linked build contents before reading them', () => {
  const f = fixture();
  fs.symlinkSync(path.join(f.root, 'assets/main'), path.join(f.root, 'linked-main'), 'junction');
  assert.throws(() => checkWechatPackage(f.root), /linked files/);
  assert.throws(() => checkWechatPackage(path.resolve(projectPath('.'), '..')), /Outside project/);
});
