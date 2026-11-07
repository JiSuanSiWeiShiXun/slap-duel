import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const staged = process.argv.includes('--staged');
if (process.argv.slice(2).some(arg => !['--staged', '--self-test'].includes(arg))) throw new Error('Usage: node tools/check-public-tree.mjs [--staged | --self-test]');
const allowed = /^(?:\.gitattributes|\.gitignore|README\.md|package\.json|tsconfig\.rules\.json|docs\/public\/[A-Za-z0-9-]+\.md|tests\/[A-Za-z0-9.-]+\.cjs|tools\/(?:create-office-cast\.py|[A-Za-z0-9.-]+\.(?:mjs|ps1))|game\/(?:assets|build-config|build-templates|settings)\/.+|game\/(?:package|tsconfig)\.json)$/;
const blocked = /(?:^|\/)(?:\.planning|\.notion-pm-private|node_modules|library|temp|local|profiles|build|\.ssh)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|project\.private\.config\.json|information\.json|verify-evidence\.mjs)$|\.(?:pem|key|p12|pfx|png|jpe?g|zip|gz)$/i;
const detectors = [
  ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['service-token', /\b(?:secret_|ntn_)[A-Za-z0-9]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ['credential-assignment', /(?:password|appsecret|access[_-]?token|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{16,}["']/i],
  ['private-workspace-path', /[A-Z]:[\\/](?:Users|seasun)[\\/][^\s"'<>]+/i],
  ['private-notion-link', /https?:\/\/(?:app\.)?notion\.(?:com|so)\//i],
  ['account-form-session', /https?:\/\/[^\s"']+[?&](?:sid|token|access_token)=[A-Za-z0-9_-]{12,}/i],
];
const binaryPath = /^game\/assets\/resources\/office-cast\/(manager|veteran|rookie)\/(character\.fbx|portrait\.png)$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
function scanText(text, report) {
  for (const [category, expression] of detectors) if (expression.test(text)) report(category);
  for (const match of text.matchAll(/\bwx[0-9a-f]{16}\b/gi)) {
    // Repeated-digit fixtures are deliberately non-account examples in config tests.
    if (new Set(match[0].slice(2).toLowerCase()).size > 1) report('wechat-account-identity');
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const octets = match[0].split('.').map(Number);
    if (octets.every(n => n <= 255) && !match[0].startsWith('127.') && match[0] !== '0.0.0.0') report('server-address');
  }
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; }
  return (c ^ 0xffffffff) >>> 0;
}
function scanReadableBytes(bytes, report) {
  scanText(bytes.toString('utf8'), report);
  scanText(bytes.toString('utf16le'), report);
}
function inflateExact(source, expected, label) {
  const result = zlib.inflateSync(source, { info: true, maxOutputLength: expected || 1 });
  // inflateSync accepts trailing bytes and concatenated streams unless checked.
  assert(result.engine.bytesWritten === source.length, `${label} compressed trailing data`);
  assert(result.buffer.length === expected, `${label} decoded size`);
  return result.buffer;
}
function checkPng(bytes, report = category => { throw new Error(`PNG sensitive ${category}`); }) {
  assert(bytes.length <= 32 * 1024 * 1024, 'PNG file budget');
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature');
  let p = 8, ended = false, data = false, width = 0, height = 0, idatEnded = false;
  const seen = new Set(), compressed = [];
  while (p < bytes.length) {
    assert(p + 12 <= bytes.length, 'PNG truncated');
    const n = bytes.readUInt32BE(p), type = bytes.toString('ascii', p + 4, p + 8);
    assert(n <= 32 * 1024 * 1024 && p + 12 + n <= bytes.length && !ended, 'PNG length');
    assert(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM'].includes(type), 'PNG metadata/chunk rejected');
    assert(crc32(bytes.subarray(p + 4, p + 8 + n)) === bytes.readUInt32BE(p + 8 + n), 'PNG CRC');
    const payload = bytes.subarray(p + 8, p + 8 + n);
    if (p === 8) {
      assert(type === 'IHDR' && n === 13, 'PNG header');
      width = bytes.readUInt32BE(p + 8); height = bytes.readUInt32BE(p + 12);
      assert(width > 0 && height > 0 && width <= 2048 && height <= 2048 && bytes[p + 16] === 8 && bytes[p + 17] === 6, 'PNG dimensions/RGBA8');
      assert(bytes[p + 18] === 0 && bytes[p + 19] === 0 && bytes[p + 20] === 0, 'PNG encoding');
    } else assert(type !== 'IHDR', 'PNG duplicate header');
    if (['sRGB', 'gAMA', 'cHRM'].includes(type)) {
      assert(!data && !seen.has(type), 'PNG color chunk order/duplicate');
      if (type === 'sRGB') assert(n === 1 && payload[0] <= 3, 'PNG sRGB intent');
      // Only the fixed sRGB color metadata used by this portrait pipeline is public.
      if (type === 'gAMA') assert(n === 4 && payload.readUInt32BE(0) === 45455, 'PNG gAMA value');
      if (type === 'cHRM') {
        assert(n === 32, 'PNG cHRM length');
        const srgb = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
        assert(srgb.every((value, index) => payload.readUInt32BE(index * 4) === value), 'PNG cHRM values');
      }
      seen.add(type);
    }
    if (type === 'IDAT') { assert(!idatEnded, 'PNG split IDAT'); data = true; compressed.push(payload); }
    else if (data) idatEnded = true;
    if (type === 'IEND') { assert(data && n === 0 && p + 12 === bytes.length, 'PNG end'); ended = true; }
    p += 12 + n;
  }
  assert(ended, 'PNG missing end');
  const rowBytes = width * 4 + 1;
  const pixels = inflateExact(Buffer.concat(compressed), rowBytes * height, 'PNG IDAT');
  for (let row = 0; row < height; row++) assert(pixels[row * rowBytes] <= 4, 'PNG row filter');
  scanReadableBytes(bytes, report);
  scanReadableBytes(pixels, report);
  return { width, height };
}
function checkFbx(bytes, report) {
  assert(bytes.subarray(0, 23).equals(Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary')), 'FBX signature');
  assert(bytes.readUInt32LE(23) === 7400 && bytes.length < 24 * 1024 * 1024, 'FBX version/size');
  let budget = 0, nodes = 0;
  const scan = b => scanReadableBytes(b, report);
  scan(bytes);
  function node(p, parentEnd, depth = 0) {
    assert(depth <= 64 && ++nodes <= 100000 && p + 13 <= parentEnd, 'FBX node limit');
    const end = bytes.readUInt32LE(p), count = bytes.readUInt32LE(p + 4), size = bytes.readUInt32LE(p + 8), length = bytes[p + 12];
    if (!end) { assert(count === 0 && size === 0 && length === 0, 'FBX null'); return p + 13; }
    assert(end <= parentEnd && end > p + 13 + length && count <= 100000, 'FBX node bounds');
    const name = bytes.toString('utf8', p + 13, p + 13 + length); scan(bytes.subarray(p + 13, p + 13 + length));
    assert(!['Video', 'Texture', 'Media', 'Content'].includes(name), 'FBX external media rejected');
    let q = p + 13 + length, propsEnd = q + size;
    assert(propsEnd <= end, 'FBX properties bounds');
    for (let i = 0; i < count; i++) {
      assert(q < propsEnd, 'FBX property count');
      const kind = String.fromCharCode(bytes[q++]);
      const fixed = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 }[kind];
      if (fixed) { assert(q + fixed <= propsEnd, 'FBX scalar bounds'); q += fixed; }
      else if (kind === 'S' || kind === 'R') {
        assert(q + 4 <= propsEnd, 'FBX string header'); const n = bytes.readUInt32LE(q); q += 4;
        assert(q + n <= propsEnd && n < 4 * 1024 * 1024, 'FBX string bounds'); scan(bytes.subarray(q, q + n)); q += n;
      } else {
        const stride = { f: 4, d: 8, l: 8, i: 4, b: 1, c: 1 }[kind];
        assert(stride && q + 12 <= propsEnd, 'FBX array type/header');
        const n = bytes.readUInt32LE(q), encoding = bytes.readUInt32LE(q + 4), compressed = bytes.readUInt32LE(q + 8); q += 12;
        const decoded = n * stride; budget += decoded;
        assert(decoded <= 24 * 1024 * 1024 && budget <= 64 * 1024 * 1024 && q + compressed <= propsEnd && encoding <= 1, 'FBX array budget');
        const source = bytes.subarray(q, q + compressed);
        const buffer = encoding === 1 ? inflateExact(source, decoded, 'FBX array') : source;
        assert(buffer.length === decoded, 'FBX decoded array size'); scan(buffer); q += compressed;
      }
    }
    assert(q === propsEnd, 'FBX property size');
    while (q < end) q = node(q, end, depth + 1);
    assert(q === end, 'FBX node end'); return end;
  }
  let p = 27;
  while (p + 13 <= bytes.length && bytes.readUInt32LE(p)) p = node(p, bytes.length);
  assert(nodes > 0, 'FBX empty');
}
function audit(files, read) {
  const findings = [];
  for (const file of files) {
    const report = category => { if (!findings.some(f => f.file === file && f.category === category)) findings.push({ file, category }); };
    const binary = binaryPath.exec(file);
    if (!allowed.test(file) || blocked.test(file) && !binary) { report('nonpublic-path'); continue; }
    try {
      const bytes = read(file);
      if (binary) {
        const manifestPath = `game/assets/resources/office-cast/${binary[1]}/manifest.json`;
        assert(files.includes(manifestPath), 'Unlisted manifest');
        const manifest = JSON.parse(read(manifestPath));
        assert(manifest.schemaVersion === 1 && manifest.source.roleId === binary[1] && manifest.source.provenance.kind === 'original-procedural', 'Asset provenance');
        assert(files.includes('tools/create-office-cast.py'), 'Unlisted generator');
        const generator = read('tools/create-office-cast.py'), g = manifest.generated;
        assert(g.generatorSha256 === sha(generator) && g.sourceHash === sha(Buffer.concat([generator, Buffer.from(JSON.stringify(canonical(manifest.source)))])), 'Source identity');
        const record = g.outputs[binary[2]];
        assert(record?.path === file && record.bytes === bytes.length && record.sha256 === sha(bytes), 'Asset hash/size/path');
        if (binary[2] === 'portrait.png') { assert(g.portraitReviewed === true, 'Portrait not reviewed'); const size = checkPng(bytes, report); assert(record.width === size.width && record.height === size.height, 'Portrait dimensions'); }
        else checkFbx(bytes, report);
        continue;
      }
      if (bytes.includes(0)) { report('unreviewed-binary'); continue; }
      scanText(bytes.toString('utf8'), report);
    } catch (error) { report(`asset-validation: ${error.message}`); }
  }
  return findings;
}
function selfTest() {
  const passed = [];
  const check = (name, action) => { action(); passed.push(name); };
  const chunk = (name, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(name, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b; };
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rawPixels = Buffer.from([0, 255, 0, 0, 255]);
  const pngWith = (before = [], encoded = zlib.deflateSync(rawPixels), after = []) => Buffer.concat([signature, chunk('IHDR', ihdr), ...before, chunk('IDAT', encoded), ...after, chunk('IEND', Buffer.alloc(0))]);
  const png = pngWith();
  const dirtyPng = pngWith([chunk('tEXt', Buffer.from('File\0private'))]);
  const fbx = data => { const header = Buffer.alloc(27); Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary').copy(header); header.writeUInt32LE(7400, 23); const n = Buffer.alloc(14); n.writeUInt32LE(27 + 14 + data.length + 13); n.writeUInt32LE(1, 4); n.writeUInt32LE(data.length, 8); n[12] = 1; n[13] = 88; return Buffer.concat([header, n, data, Buffer.alloc(26)]); };
  const arr = (value, encode = raw => zlib.deflateSync(raw)) => { const raw = Buffer.from(value), compressed = encode(raw), b = Buffer.alloc(13); b[0] = 98; b.writeUInt32LE(raw.length, 1); b.writeUInt32LE(1, 5); b.writeUInt32LE(compressed.length, 9); return Buffer.concat([b, compressed]); };
  const generatorPath = 'tools/create-office-cast.py';
  const generator = Buffer.from('original generator'), source = { roleId: 'manager', provenance: { kind: 'original-procedural' } }, assetPath = 'game/assets/resources/office-cast/manager/portrait.png', manifestPath = assetPath.replace('portrait.png', 'manifest.json');
  const manifest = { schemaVersion: 1, source, generated: { generatorSha256: sha(generator), sourceHash: sha(Buffer.concat([generator, Buffer.from(JSON.stringify(canonical(source)))])), portraitReviewed: true, outputs: { 'portrait.png': { path: assetPath, bytes: png.length, sha256: sha(png), width: 1, height: 1 } } } };
  const view = new Map([[assetPath, png], [manifestPath, Buffer.from(JSON.stringify(manifest))], [generatorPath, generator]]);
  const read = map => name => { assert(map.has(name)); return map.get(name); };
  const run = map => audit([...map.keys()], read(map));
  const withPng = bytes => {
    const updated = structuredClone(manifest);
    updated.generated.outputs['portrait.png'] = { path: assetPath, bytes: bytes.length, sha256: sha(bytes), width: 1, height: 1 };
    return new Map(view).set(assetPath, bytes).set(manifestPath, Buffer.from(JSON.stringify(updated)));
  };
  const rejectPng = bytes => assert(run(withPng(bytes)).some(f => f.file === assetPath && f.category.startsWith('asset-validation:')));
  const privatePath = ['D:', 'seasun', 'private-fixture'].join('/');
  check('valid-original-manifest-png', () => assert.deepEqual(run(view), []));
  check('png-text-metadata', () => rejectPng(dirtyPng));
  check('png-crc', () => { const bad = Buffer.from(png); bad[29] ^= 1; rejectPng(bad); });
  check('png-file-tail', () => rejectPng(Buffer.concat([png, Buffer.from('tail')])));
  check('png-gama-hidden-path', () => rejectPng(pngWith([chunk('gAMA', Buffer.from(privatePath))])));
  check('png-srgb-hidden-path', () => rejectPng(pngWith([chunk('sRGB', Buffer.from(privatePath))])));
  check('png-chrm-hidden-path', () => rejectPng(pngWith([chunk('cHRM', Buffer.from(privatePath))])));
  const gamma = Buffer.alloc(4); gamma.writeUInt32BE(45455);
  const chromaticities = Buffer.alloc(32); [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((v, i) => chromaticities.writeUInt32BE(v, i * 4));
  check('png-valid-srgb-colors', () => assert.deepEqual(run(withPng(pngWith([chunk('gAMA', gamma), chunk('sRGB', Buffer.from([0])), chunk('cHRM', chromaticities)]))), []));
  check('png-color-after-data', () => rejectPng(pngWith([], undefined, [chunk('gAMA', gamma)])));
  check('png-color-duplicate', () => rejectPng(pngWith([chunk('sRGB', Buffer.from([0])), chunk('sRGB', Buffer.from([0]))])));
  check('png-color-value', () => rejectPng(pngWith([chunk('sRGB', Buffer.from([4]))])));
  check('png-idat-invalid-zlib', () => rejectPng(pngWith([], Buffer.from('not compressed'))));
  check('png-idat-trailing-stream', () => rejectPng(pngWith([], Buffer.concat([zlib.deflateSync(rawPixels), zlib.deflateSync(Buffer.from(privatePath))]))));
  check('png-idat-row-size', () => rejectPng(pngWith([], zlib.deflateSync(Buffer.from([0, 255, 0, 0])))));
  check('png-idat-inflate-budget', () => rejectPng(pngWith([], zlib.deflateSync(Buffer.alloc(1000)))));
  check('png-idat-row-filter', () => rejectPng(pngWith([], zlib.deflateSync(Buffer.from([5, 255, 0, 0, 255])))));
  check('fbx-valid-array', () => { const found = []; checkFbx(fbx(arr('original')), c => found.push(c)); assert.deepEqual(found, []); });
  check('fbx-compressed-secret', () => { const found = []; checkFbx(fbx(arr(privatePath)), c => found.push(c)); assert(found.includes('private-workspace-path')); });
  check('fbx-compressed-trailing-stream', () => assert.throws(() => checkFbx(fbx(arr('original', raw => Buffer.concat([zlib.deflateSync(raw), zlib.deflateSync(Buffer.from(privatePath))]))), () => {}), /compressed trailing data/));
  check('fbx-array-budget', () => { const excess = Buffer.from(arr('original')); excess.writeUInt32LE(0xffffffff, 1); assert.throws(() => checkFbx(fbx(excess), () => {})); });
  check('manifest-required', () => assert(run(new Map([...view].filter(([k]) => k !== manifestPath))).length));
  check('generator-must-be-listed', () => assert(audit([...view.keys()].filter(k => k !== generatorPath), read(view)).some(f => f.file === assetPath && f.category.includes('Unlisted generator'))));
  check('source-generator-hash', () => assert(run(new Map(view).set(generatorPath, Buffer.from('changed generator'))).length));
  check('asset-magic', () => assert(run(new Map(view).set(assetPath, Buffer.from('wrong'))).length));
  check('binary-path-boundary', () => assert(run(new Map(view).set('private.png', png)).length));
  check('asset-hash', () => { const altered = structuredClone(manifest); altered.generated.outputs['portrait.png'].sha256 = '0'.repeat(64); assert(run(new Map(view).set(manifestPath, Buffer.from(JSON.stringify(altered)))).length); });
  check('private-key-path', () => assert(audit(['private/file.key'], () => Buffer.from('')).length));
  check('service-token', () => { const found = []; scanText('ntn_' + 'x'.repeat(35), c => found.push(c)); assert(found.includes('service-token')); });
  console.log(JSON.stringify({ passed: true, scope: 'isolated-public-asset-fixtures', checks: passed.length, cases: passed }));
}
if (process.argv.includes('--self-test')) { selfTest(); process.exit(0); }
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
const findings = audit(files, file => staged ? execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }) : fs.readFileSync(path.join(root, file)));
if (!files.length) findings.push({ file: '<index>', category: 'empty-tree' });
console.log(JSON.stringify({ passed: findings.length === 0, scope: staged ? 'staged-public-tree' : 'tracked-working-tree', files: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
