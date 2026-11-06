import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GAME = path.join(ROOT, 'game');
export const IDS = Object.freeze({
  project: 'eba032cc-9be8-4fbf-ab7b-d1b72cac8335',
  scene: 'ab1175a8-174a-4c23-9e97-75d8825befc3',
  script: '74264b70-e9bb-4b88-9eae-ddac14aa1c30',
  rootNode: '8596015b-d2e5-4380-9df7-a62fe83351eb',
  component: '576c67c4-5143-4999-8f6a-7a1eb482255c',
  scenesFolder: 'df71d1ee-1734-48da-9c76-b0578b1c46c6',
  scriptsFolder: '170f5368-4d8e-4286-9f9f-79be6234914c',
  buildInfo: 'e78a77a9-d393-4ce6-81dd-89db085586b8',
});
const install = process.env.COCOS_INSTALL || 'E:/DevTools/CocosCreator/3.8.8';
const templateRoot = path.join(install, 'resources/resources/3d/engine/editor/assets/default_file_content');

export function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function projectPath(relative) {
  const target = path.resolve(ROOT, relative);
  if (!inside(ROOT, target)) throw new Error(`Outside project: ${relative}`);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!inside(fs.realpathSync(ROOT), fs.realpathSync(ancestor))) throw new Error(`Linked outside project: ${relative}`);
  return target;
}

// Cocos non-minimal script UUID form: first five hex digits + 18 base64 digits.
// Official example: 7bf9df40-4bc9-4e25-8cb0-9a500f949102 -> 7bf9d9AS8lOJYywmlAPlJEC.
export function compressUuid(uuid) {
  const hex = uuid.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('Invalid UUID');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = hex.slice(0, 5);
  for (let i = 5; i < 32; i += 3) {
    const value = parseInt(hex.slice(i, i + 3), 16);
    output += chars[value >> 6] + chars[value & 63];
  }
  return output;
}

function readJson(relative) { return JSON.parse(fs.readFileSync(projectPath(relative), 'utf8').replace(/^\uFEFF/, '')); }
function createJson(relative, value) {
  const target = projectPath(relative);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

export function checkConfig() {
  projectPath('game/local/build-logs');
  const pkg = readJson('game/package.json');
  if (pkg.uuid !== IDS.project || pkg.creator?.version !== '3.8.8') throw new Error('Project identity/version mismatch');
  readJson('game/tsconfig.json');
  const meta = readJson('game/assets/scenes/main.scene.meta');
  const script = readJson('game/assets/scripts/SlapGame.ts.meta');
  const scene = readJson('game/assets/scenes/main.scene');
  if (meta.uuid !== IDS.scene || script.uuid !== IDS.script || scene[1]?._id !== IDS.scene) throw new Error('Scene/script identity mismatch');
  const controller = scene.find(x => x.__type__ === compressUuid(IDS.script));
  if (!controller || scene[controller.node?.__id__]?._name !== 'SlapGameRoot') throw new Error('Missing controller scene reference');
  for (const target of ['web-desktop', 'wechatgame']) {
    const config = readJson(`game/build-config/${target}.json`);
    if (config.platform !== target || config.startScene !== IDS.scene || config.scenes?.[0]?.uuid !== IDS.scene) throw new Error(`Invalid ${target} scene config`);
    if (config.buildPath !== 'project://build' || config.outputName !== target) throw new Error(`Invalid ${target} output path`);
    if (config.designResolution?.width !== 720 || config.designResolution?.height !== 1280) throw new Error('Unexpected design resolution');
  }
  return { root: ROOT, project: IDS.project, scene: IDS.scene, script: IDS.script, scriptType: compressUuid(IDS.script) };
}

export function bootstrap() {
  const scene = JSON.parse(fs.readFileSync(path.join(templateRoot, 'scene/default.scene'), 'utf8'));
  scene[0]._name = 'main';
  scene[1]._name = 'main';
  scene[1]._id = IDS.scene;
  // SlapGame creates the live camera and lights; avoid duplicate template rendering.
  for (const child of scene[1]._children) scene[child.__id__]._active = false;
  const rootIndex = scene.length;
  scene[1]._children.push({ __id__: rootIndex });
  scene.push({ __type__: 'cc.Node', _name: 'SlapGameRoot', _objFlags: 0,
    _parent: { __id__: 1 }, _children: [], _active: true,
    _components: [{ __id__: rootIndex + 1 }], _prefab: null,
    _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
    _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
    _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
    _layer: 1073741824, _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _id: IDS.rootNode });
  scene.push({ __type__: compressUuid(IDS.script), _name: '', _objFlags: 0,
    node: { __id__: rootIndex }, _enabled: true, __prefab: null, _id: IDS.component });
  createJson('game/package.json', { name: 'seasun-slap-duel', uuid: IDS.project, creator: { version: '3.8.8' } });
  createJson('game/tsconfig.json', { extends: './temp/tsconfig.cocos.json', compilerOptions: { strict: true } });
  createJson('game/assets/scenes/main.scene', scene);
  const sceneMeta = JSON.parse(fs.readFileSync(path.join(templateRoot, 'scene/default.scene.meta'), 'utf8'));
  createJson('game/assets/scenes/main.scene.meta', { ...sceneMeta, uuid: IDS.scene });
  const scriptMeta = JSON.parse(fs.readFileSync(path.join(templateRoot, 'typescript/ts.meta'), 'utf8'));
  createJson('game/assets/scripts/SlapGame.ts.meta', { ...scriptMeta, uuid: IDS.script });
  createJson('game/assets/scripts/BuildInfo.ts.meta', { ...scriptMeta, uuid: IDS.buildInfo });
  const buildInfo = projectPath('game/assets/scripts/BuildInfo.ts');
  if (!fs.existsSync(buildInfo)) fs.writeFileSync(buildInfo, "// Generated by tools/build-game.ps1 before each real Cocos build.\nexport const BUILD_ID = 'P1-development-unbuilt';\n", { flag: 'wx' });
  for (const [folder, uuid] of [['scenes', IDS.scenesFolder], ['scripts', IDS.scriptsFolder]]) {
    createJson(`game/assets/${folder}.meta`, { ver: '1.2.0', importer: 'directory', imported: true, uuid, files: [], subMetas: {}, userData: {} });
  }
  for (const target of ['web-desktop', 'wechatgame']) {
    createJson(`game/build-config/${target}.json`, {
      name: 'seasun-slap-duel', platform: target, buildPath: 'project://build',
      outputName: target, debug: true, sourceMaps: true, md5Cache: false,
      startScene: IDS.scene, scenes: [{ url: 'db://assets/scenes/main.scene', uuid: IDS.scene }],
      designResolution: { width: 720, height: 1280, fitWidth: true, fitHeight: false },
      ...(target === 'wechatgame' ? { packages: { wechatgame: {
        appid: '', orientation: 'portrait',
        buildOpenDataContextTemplate: false, separateEngine: false,
        highPerformanceMode: false, wasmSubpackage: false,
      } } } : {}),
    });
  }
  return checkConfig();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(x => x !== '--check')) throw new Error('Usage: node tools/bootstrap-game.mjs [--check]');
    console.log(JSON.stringify(process.argv.includes('--check') ? checkConfig() : bootstrap(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
