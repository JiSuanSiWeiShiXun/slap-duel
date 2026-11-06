import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, projectPath } from './bootstrap-game.mjs';
import { verifyBuild } from './check-game.mjs';

const rootFiles = new Set(['index.html', 'index.js', 'application.js', 'style.css', 'favicon.ico', 'build-manifest.json']);
const runtimeDirectories = new Set(['assets', 'cocos-js', 'src']);
const runtimeExtensions = new Set(['.js', '.json', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg', '.wasm', '.bin', '.cconb', '.ttf', '.woff', '.woff2', '.mp3', '.ogg', '.wav']);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const safeRelative = value => typeof value === 'string' && /^[A-Za-z0-9_@./-]+$/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));

function assertLocal(directory) { return projectPath(path.relative(ROOT, path.resolve(directory))); }

function allFiles(directory, prefix = '') {
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Symbolic link rejected: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safeRelative(relative)) throw new Error(`Unsafe release path: ${relative}`);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link rejected: ${relative}`);
    if (entry.isDirectory()) return allFiles(absolute, relative);
    if (!entry.isFile()) throw new Error(`Non-file rejected: ${relative}`);
    return [relative];
  });
}

/** Explicit Cocos runtime roots; source maps are the only silently omitted files. */
export function selectPublicFiles(sourceRoot) {
  assertLocal(sourceRoot);
  const files = allFiles(sourceRoot).filter(relative => {
    if (relative.endsWith('.map')) return false;
    const parts = relative.split('/');
    const allowed = parts.length === 1 ? rootFiles.has(relative)
      : runtimeDirectories.has(parts[0]) && runtimeExtensions.has(path.extname(relative));
    if (!allowed) throw new Error(`Unexpected file in public build: ${relative}`);
    return true;
  }).sort();
  for (const required of ['index.html', 'index.js', 'application.js', 'style.css', 'build-manifest.json',
    'cocos-js/cc.js', 'src/import-map.json', 'src/settings.json', 'src/system.bundle.js', 'src/polyfills.bundle.js',
    'src/chunks/bundle.js', 'assets/main/config.json', 'assets/main/index.js', 'assets/internal/config.json', 'assets/internal/index.js']) {
    if (!files.includes(required)) throw new Error(`Runtime file missing: ${required}`);
  }
  return files;
}

function checksums(manifestText, files) {
  return [...files.map(file => `${file.sha256}  site/${file.path}`), `${sha256(manifestText)}  release-manifest.json`].join('\n') + '\n';
}

export function stageRelease(sourceRoot, releaseRoot, build) {
  assertLocal(sourceRoot);
  assertLocal(releaseRoot);
  if (fs.existsSync(releaseRoot)) throw new Error(`Release already exists; never overwrite: ${releaseRoot}`);
  const selected = selectPublicFiles(sourceRoot);
  const sourceBuild = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (sourceBuild.buildId !== build.buildId || sourceBuild.sourceDigest !== build.sourceDigest) throw new Error('Build manifest changed before packaging');
  const files = selected.map(relative => {
    const bytes = fs.readFileSync(path.join(sourceRoot, relative));
    const target = path.join(releaseRoot, 'site', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = { schema: 1, app: 'seasun-slap-duel', kind: 'single-player-static-web',
    buildId: build.buildId, sourceDigest: build.sourceDigest, engine: build.engine, revision: build.revision,
    builtAt: build.builtAt, packagedAt: new Date().toISOString(),
    omitted: 'Source maps (*.map); original runtime files remain byte-identical.', files };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(releaseRoot, 'release-manifest.json'), manifestText, { flag: 'wx' });
  fs.writeFileSync(path.join(releaseRoot, 'SHA256SUMS'), checksums(manifestText, files), { flag: 'wx' });
  return verifyRelease(releaseRoot);
}

export function verifyRelease(releaseRoot) {
  assertLocal(releaseRoot);
  // Reject links/unsafe paths before reading any untrusted manifest contents.
  const actual = allFiles(releaseRoot).sort();
  const manifestText = fs.readFileSync(path.join(releaseRoot, 'release-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.schema !== 1 || manifest.kind !== 'single-player-static-web' || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest');
  const expected = new Set(['release-manifest.json', 'SHA256SUMS']);
  for (const file of manifest.files) {
    if (!safeRelative(file.path) || expected.has(`site/${file.path}`) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid/duplicate manifest path or hash');
    expected.add(`site/${file.path}`);
    const data = fs.readFileSync(path.join(releaseRoot, 'site', file.path));
    if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error(`Checksum mismatch: ${file.path}`);
  }
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Release has missing or unexpected files');
  const publicFiles = selectPublicFiles(path.join(releaseRoot, 'site'));
  if (JSON.stringify(publicFiles) !== JSON.stringify(manifest.files.map(file => file.path).sort())) throw new Error('Release public boundary mismatch');
  if (fs.readFileSync(path.join(releaseRoot, 'SHA256SUMS'), 'utf8') !== checksums(manifestText, manifest.files)) throw new Error('Checksum list mismatch');
  const build = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'site/build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.buildId !== build.buildId || manifest.sourceDigest !== build.sourceDigest) throw new Error('Release/build identity mismatch');
  return { buildId: manifest.buildId, fileCount: manifest.files.length, totalBytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0) };
}

export function packageCurrentBuild() {
  const build = verifyBuild('web-desktop');
  if (!/^P1-[a-f0-9]+-[a-f0-9]{8}-[0-9TZ]+$/.test(build.buildId)) throw new Error('Unsafe build ID');
  const releaseRoot = projectPath(`game/local/releases/${build.buildId}`);
  const archive = `${releaseRoot}.tar.gz`;
  if (fs.existsSync(archive)) throw new Error(`Archive already exists; never overwrite: ${archive}`);
  const result = stageRelease(projectPath('game/build/web-desktop'), releaseRoot, build);
  execFileSync('tar', ['-czf', archive, '-C', releaseRoot, 'site', 'release-manifest.json', 'SHA256SUMS'], { cwd: ROOT, stdio: 'pipe' });
  const archiveFiles = execFileSync('tar', ['-tzf', archive], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/)
    .map(name => name.replace(/^\.\//, '')).filter(name => !name.endsWith('/')).sort();
  if (JSON.stringify(archiveFiles) !== JSON.stringify(allFiles(releaseRoot).sort())) throw new Error('Archive inventory differs from verified release');
  const archiveHash = sha256(fs.readFileSync(archive));
  fs.writeFileSync(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`, { flag: 'wx' });
  const receipt = { ...result, archive, sha256: archiveHash, archiveBytes: fs.statSync(archive).size, releaseRoot,
    siteRoot: path.join(releaseRoot, 'site'), verifiedArchiveInventory: true };
  fs.writeFileSync(`${releaseRoot}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) console.log(JSON.stringify(packageCurrentBuild(), null, 2));
    else if (args.length === 2 && args[0] === '--verify') console.log(JSON.stringify(verifyRelease(args[1]), null, 2));
    else throw new Error('Usage: node tools/package-web-release.mjs [--verify RELEASE_DIRECTORY]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
