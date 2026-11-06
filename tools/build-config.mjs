import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfig, projectPath } from './bootstrap-game.mjs';

const targets = new Set(['web-desktop', 'wechatgame']);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

/** Machine/account identity belongs to ignored configuration, never the template. */
export function resolveWechatAppId(environment = process.env, localFile = projectPath('game/local/wechat-config.json')) {
  let appid = environment.WECHAT_APP_ID;
  if (appid === undefined && fs.existsSync(localFile)) appid = readJson(localFile).appid;
  if (typeof appid !== 'string' || !/^wx[0-9a-f]{16}$/i.test(appid)) {
    throw new Error('Set WECHAT_APP_ID or appid in ignored game/local/wechat-config.json to a valid WeChat AppID');
  }
  return appid;
}

export function resolveRuntimeBuildConfig(target, environment = process.env) {
  if (!targets.has(target)) throw new Error('Unknown build target');
  checkConfig();
  const config = readJson(projectPath(`game/build-config/${target}.json`));
  config.buildPath = projectPath('game/build').replaceAll('\\', '/');
  if (target === 'wechatgame') config.packages.wechatgame.appid = resolveWechatAppId(environment);
  return config;
}

/** Cocos receives an absolute, local-only copy while public input remains portable. */
export function writeRuntimeBuildConfig(target, environment = process.env) {
  const config = resolveRuntimeBuildConfig(target, environment);
  const file = projectPath(`game/local/build-config/${target}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}

export function expectedWechatBuildIdentity() {
  const appid = resolveWechatAppId();
  const runtimeFile = projectPath('game/local/build-config/wechatgame.json');
  const runtime = readJson(runtimeFile);
  if (runtime.platform !== 'wechatgame' || runtime.packages?.wechatgame?.appid !== appid
    || path.resolve(runtime.buildPath) !== projectPath('game/build')) {
    throw new Error('Local WeChat build identity changed; rebuild before configuring or opening');
  }
  return appid;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && targets.has(args[0])) console.log(writeRuntimeBuildConfig(args[0]));
    else if (args.length === 1 && args[0] === '--wechat-identity') {
      // Intended for the launcher to consume; never write this result into a public file.
      const template = resolveRuntimeBuildConfig('wechatgame');
      console.log(JSON.stringify({ appid: template.packages.wechatgame.appid, orientation: template.packages.wechatgame.orientation }));
    } else throw new Error('Usage: node tools/build-config.mjs TARGET | --wechat-identity');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
