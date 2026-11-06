import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPath } from './bootstrap-game.mjs';
import { expectedWechatBuildIdentity } from './build-config.mjs';

/** Cocos already transpiles/minifies engine and game; avoid expanding it a second time. */
export function configureWechat() {
  const file = projectPath('game/build/wechatgame/project.config.json');
  const generated = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expectedAppId = expectedWechatBuildIdentity();
  if (!expectedAppId || generated.appid !== expectedAppId || generated.compileType !== 'game') {
    throw new Error('Refusing to configure a WeChat build with mismatched identity/type');
  }
  generated.setting = { ...generated.setting, enhance: false, es6: false, minified: true };
  fs.writeFileSync(file, JSON.stringify(generated, null, 2) + '\n');
  return { appid: expectedAppId, enhance: false, es6: false, minified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(configureWechat(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
