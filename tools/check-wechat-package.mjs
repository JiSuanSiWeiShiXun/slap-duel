import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, projectPath } from './bootstrap-game.mjs';

export const MAIN_RAW_BYTE_LIMIT = 4 * 1024 * 1024;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function fail(message) { throw new Error(`WeChat package: ${message}`); }

function collectFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('linked files/directories are not supported');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push({ relative: path.relative(root, file).replaceAll('\\', '/'), bytes: stat.size });
      else fail('non-regular build entry');
    }
  }
  visit(root);
  return files;
}

function uniqueNames(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !/^[a-z0-9_-]+$/i.test(value))) {
    fail(`${label} must contain bundle names`);
  }
  if (new Set(values.map(value => value.toLowerCase())).size !== values.length) fail(`duplicate ${label}`);
  return values;
}

/** Reads Cocos 3.8 local-subpackage output; does not execute bundle code or contact WeChat. */
export function checkWechatPackage(directory = projectPath('game/build/wechatgame')) {
  const root = projectPath(path.relative(ROOT, path.resolve(directory)));
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    fail('build root must be a real project directory');
  }
  // Walk before reading JSON so a linked config cannot cause an external read.
  const files = collectFiles(root);
  const byPath = new Map(files.map(file => [file.relative, file]));
  const requireFile = relative => {
    const file = byPath.get(relative);
    if (!file || file.bytes === 0) fail(`missing or empty ${relative}`);
    return path.join(root, relative);
  };
  for (const relative of ['game.js', 'game.json', 'src/settings.json', 'src/system.bundle.js',
    'src/polyfills.bundle.js', 'cocos-js/cc.js']) requireFile(relative);
  const game = readJson(requireFile('game.json'));
  const settings = readJson(requireFile('src/settings.json'));
  if (!Array.isArray(game.subpackages) || game.subpackages.length === 0) fail('resources must be a declared local subpackage');
  const names = uniqueNames(game.subpackages.map(bundle => bundle?.name), 'game.json subpackages');
  const packages = game.subpackages.map(bundle => {
    // Cocos' installed mini-game loader resolves subpackages/<bundle-name>/config.json.
    const expected = `subpackages/${bundle.name}`;
    if (typeof bundle.root !== 'string' || ![expected, `${expected}/`].includes(bundle.root)) {
      fail('subpackage root must match the local Cocos bundle path');
    }
    if (bundle.name === 'main' || bundle.name === 'internal') fail('main/internal must remain in the main package');
    return { name: bundle.name, root: expected, files: 0, rawBytes: 0 };
  });
  if (!names.includes('resources')) fail('resources local subpackage is missing');
  const assetSettings = settings.assets;
  const configured = uniqueNames(assetSettings?.subpackages, 'settings subpackages');
  if (configured.length !== names.length || configured.some(name => !names.includes(name))) {
    fail('game.json and settings subpackage declarations disagree');
  }
  const preload = uniqueNames(assetSettings?.preloadBundles?.map(bundle => bundle?.bundle), 'preload bundles');
  if (!preload.includes('resources') || !preload.includes('main')) fail('resources/main preload is missing');
  if (!Array.isArray(assetSettings.projectBundles)
    || ['internal', 'resources', 'main'].some(name => !assetSettings.projectBundles.includes(name))) {
    fail('main/internal/resources project bundle registration is missing');
  }
  if ((assetSettings.remoteBundles || []).includes('resources')) fail('resources must remain local');
  for (const name of ['main', 'internal']) {
    const config = readJson(requireFile(`assets/${name}/config.json`));
    if (config.name !== name) fail(`${name} bundle identity mismatch`);
    requireFile(`assets/${name}/index.js`);
    if (!files.some(file => file.relative.startsWith(`assets/${name}/import/`))) fail(`${name} imported assets are missing`);
  }
  for (const bundle of packages) {
    const config = readJson(requireFile(`${bundle.root}/config.json`));
    requireFile(`${bundle.root}/game.js`);
    if (config.name !== bundle.name) fail('subpackage bundle identity mismatch');
    for (const field of ['importBase', 'nativeBase']) {
      if (config[field] !== (field === 'importBase' ? 'import' : 'native')) fail('unsupported local bundle asset path');
    }
    if (!Array.isArray(config.uuids) || config.uuids.length === 0 || !config.paths || !Object.keys(config.paths).length) {
      fail('subpackage contains no loadable resource registrations');
    }
    for (const assetKind of ['import', 'native']) {
      if (!files.some(file => file.relative.startsWith(`${bundle.root}/${assetKind}/`))) fail(`subpackage ${assetKind} assets are missing`);
    }
    if (files.some(file => file.relative.startsWith(`assets/${bundle.name}/`))) fail('stale main-package copy of a subpackage');
  }
  let mainRawBytes = 0;
  for (const file of files) {
    const bundle = packages.find(item => file.relative.startsWith(`${item.root}/`));
    if (bundle) { bundle.files++; bundle.rawBytes += file.bytes; }
    else {
      if (file.relative.startsWith('subpackages/')) fail('undeclared subpackage files would invalidate size accounting');
      mainRawBytes += file.bytes;
    }
  }
  if (mainRawBytes > MAIN_RAW_BYTE_LIMIT) fail(`main raw bytes ${mainRawBytes} exceed conservative limit ${MAIN_RAW_BYTE_LIMIT}`);
  return { passed: true, measurement: 'uncompressed filesystem bytes', mainRawByteLimit: MAIN_RAW_BYTE_LIMIT,
    files: files.length, totalRawBytes: files.reduce((total, file) => total + file.bytes, 0), mainRawBytes,
    subpackages: packages, acceptance: 'Static packaging check only; official preview and actual runtime/device checks are still required.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('Usage: node tools/check-wechat-package.mjs');
    console.log(JSON.stringify(checkWechatPackage(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
