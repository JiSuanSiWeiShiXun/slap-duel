import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectPath } from './bootstrap-game.mjs';
import { resolveWechatAppId, resolveRuntimeBuildConfig, writeRuntimeBuildConfig } from './build-config.mjs';

const fixtureAppId = digit => `wx${digit.repeat(16)}`;

test('account identity stays local and explicit environment configuration takes precedence', () => {
  const fixture = projectPath(`game/local/config-tests/${process.pid}/wechat-config.json`);
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, JSON.stringify({ appid: fixtureAppId('1') }));
  assert.equal(resolveWechatAppId({}, fixture), fixtureAppId('1'));
  assert.equal(resolveWechatAppId({ WECHAT_APP_ID: fixtureAppId('2') }, fixture), fixtureAppId('2'));
  assert.throws(() => resolveWechatAppId({ WECHAT_APP_ID: 'invalid-account-value' }, fixture), /Set WECHAT_APP_ID/);
  assert.throws(() => resolveWechatAppId({}, `${fixture}.missing`), /Set WECHAT_APP_ID/);
  const templateFile = projectPath('game/build-config/wechatgame.json');
  const before = fs.readFileSync(templateFile, 'utf8');
  assert.equal(JSON.parse(before).packages.wechatgame.appid, '');
  const runtime = resolveRuntimeBuildConfig('wechatgame', { WECHAT_APP_ID: fixtureAppId('3') });
  assert.equal(runtime.packages.wechatgame.appid, fixtureAppId('3'));
  assert.equal(runtime.buildPath, projectPath('game/build').replaceAll('\\', '/'));
  assert.equal(fs.readFileSync(templateFile, 'utf8'), before);
});

test('runtime configuration is generated only beneath ignored game/local', () => {
  const file = writeRuntimeBuildConfig('web-desktop');
  assert.equal(file, projectPath('game/local/build-config/web-desktop.json'));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.buildPath, projectPath('game/build').replaceAll('\\', '/'));
  assert.equal(JSON.parse(fs.readFileSync(projectPath('game/build-config/web-desktop.json'), 'utf8')).buildPath, 'project://build');
  assert.throws(() => resolveRuntimeBuildConfig('../another-project'), /Unknown build target/);
});

test('an independently located checkout passes configuration validation without account credentials', () => {
  const checkout = projectPath(`game/local/config-tests/relocated-${process.pid}`);
  const files = ['tools/bootstrap-game.mjs', 'game/package.json', 'game/tsconfig.json',
    'game/build-config/web-desktop.json', 'game/build-config/wechatgame.json',
    'game/assets/scenes/main.scene', 'game/assets/scenes/main.scene.meta', 'game/assets/scripts/SlapGame.ts.meta'];
  for (const relative of files) {
    const destination = path.join(checkout, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(projectPath(relative), destination);
  }
  const result = JSON.parse(execFileSync(process.execPath, [path.join(checkout, 'tools/bootstrap-game.mjs'), '--check'],
    { cwd: checkout, encoding: 'utf8' }));
  assert.equal(result.root, checkout);
  assert.equal(fs.existsSync(path.join(checkout, 'game/local/wechat-config.json')), false);
});
