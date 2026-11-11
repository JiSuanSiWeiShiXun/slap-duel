import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { HUMAN_BASE, HUMAN_CLOTHING, HUMAN_GENERATOR, HUMAN_MATERIALS, isHumanSource, validateHumanSource, validateHumanOutputs, validateHumanTimelineContract } from './human-asset-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const allowed = /^(?:\.gitattributes|\.gitignore|\.env\.example|README\.md|package\.json|tsconfig\.rules\.json|docs\/public\/[A-Za-z0-9-]+\.md|tests\/(?:[A-Za-z0-9.-]+\.cjs|fixtures\/human-manager-geometry\.json)|tools\/(?:create-office-(?:cast|human)\.py|[A-Za-z0-9.-]+\.(?:mjs|ps1))|game\/(?:assets|build-config|build-templates|settings)\/.+|game\/(?:package|tsconfig)\.json)$/;
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
const binaryPath = /^game\/assets\/resources\/office-cast\/(manager|veteran|rookie)\/(character\.fbx|portrait\.png|fabric\.png)$/;
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
export function checkPng(bytes, report = category => { throw new Error(`PNG sensitive ${category}`); }) {
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
export function checkFbx(bytes, report, options) {
  assert(bytes.subarray(0, 23).equals(Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary')), 'FBX signature');
  assert(bytes.readUInt32LE(23) === 7400 && bytes.length < 24 * 1024 * 1024, 'FBX version/size');
  const mediaNames = options?.mediaNames || [];
  if (options) assert.deepEqual(options, { mediaNames: ['fabric.png'] }, 'Only the declared human fabric media contract is admitted');
  const referencedMedia = new Set();
  let budget = 0, nodes = 0;
  const scan = b => scanReadableBytes(b, report);
  scan(bytes);
  function node(p, parentEnd, depth = 0, parents = []) {
    assert(depth <= 64 && ++nodes <= 100000 && p + 13 <= parentEnd, 'FBX node limit');
    const end = bytes.readUInt32LE(p), count = bytes.readUInt32LE(p + 4), size = bytes.readUInt32LE(p + 8), length = bytes[p + 12];
    if (!end) { assert(count === 0 && size === 0 && length === 0, 'FBX null'); return p + 13; }
    assert(end <= parentEnd && end > p + 13 + length && count <= 100000, 'FBX node bounds');
    const name = bytes.toString('utf8', p + 13, p + 13 + length); scan(bytes.subarray(p + 13, p + 13 + length));
    assert(name !== 'Content', 'FBX embedded media rejected');
    assert(!['Video', 'Texture', 'Media'].includes(name) || mediaNames.length > 0, 'FBX external media rejected');
    let q = p + 13 + length, propsEnd = q + size;
    assert(propsEnd <= end, 'FBX properties bounds');
    const stringProperties = [];
    for (let i = 0; i < count; i++) {
      assert(q < propsEnd, 'FBX property count');
      const kind = String.fromCharCode(bytes[q++]);
      const fixed = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 }[kind];
      if (fixed) { assert(q + fixed <= propsEnd, 'FBX scalar bounds'); q += fixed; }
      else if (kind === 'S' || kind === 'R') {
        assert(q + 4 <= propsEnd, 'FBX string header'); const n = bytes.readUInt32LE(q); q += 4;
        assert(q + n <= propsEnd && n < 4 * 1024 * 1024, 'FBX string bounds');
        const value = bytes.subarray(q, q + n); scan(value);
        if (kind === 'S') stringProperties.push(value.toString('utf8'));
        q += n;
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
    const mediaContext = parents.includes('Video') || parents.includes('Texture');
    if (mediaNames.length && mediaContext && ['Filename', 'FileName', 'RelativeFilename', 'RelativeFileName'].includes(name)) {
      assert(count === 1 && stringProperties.length === 1 && mediaNames.includes(stringProperties[0]), 'FBX media filename is not an exact declared relative asset');
      referencedMedia.add(stringProperties[0]);
    }
    if (mediaNames.length && name === 'Media') assert(count === 1 && stringProperties.length === 1 &&
      stringProperties[0] === 'OfficeFabric\0\x01Video', 'FBX media reference rejected');
    if (mediaNames.length && name === 'Video') assert(stringProperties[0] === 'OfficeFabric\0\x01Video', 'FBX video identity rejected');
    if (mediaNames.length && parents.includes('Video') && name === 'P' && stringProperties[0] === 'Path') assert(stringProperties.at(-1) === 'fabric.png', 'FBX video path is not an exact declared relative asset');
    while (q < end) q = node(q, end, depth + 1, [...parents, name]);
    assert(q === end, 'FBX node end'); return end;
  }
  let p = 27;
  while (p + 13 <= bytes.length && bytes.readUInt32LE(p)) p = node(p, bytes.length);
  assert(nodes > 0, 'FBX empty');
  if (mediaNames.length) assert.deepEqual([...referencedMedia].sort(), [...mediaNames].sort(), 'FBX declared texture reference missing');
}
function audit(files, read) {
  const findings = [];
  for (const file of files) {
    const report = category => { if (!findings.some(f => f.file === file && f.category === category)) findings.push({ file, category }); };
    const binary = binaryPath.exec(file);
    const privateEnv = file !== '.env.example' && /(?:^|\/)\.env(?:\.[^/]*)?$/i.test(file);
    if (!allowed.test(file) || blocked.test(file) && !binary || privateEnv) { report('nonpublic-path'); continue; }
    try {
      const bytes = read(file);
      if (binary) {
        const manifestPath = `game/assets/resources/office-cast/${binary[1]}/manifest.json`;
        assert(files.includes(manifestPath), 'Unlisted manifest');
        const manifest = JSON.parse(read(manifestPath));
        assert(manifest.schemaVersion === 1 && manifest.source.roleId === binary[1], 'Asset provenance');
        const human = isHumanSource(manifest.source);
        if (human) {
          validateHumanSource(manifest.source, binary[1]);
          for (const name of validateHumanOutputs(manifest.generated)) assert(files.includes(`game/assets/resources/office-cast/${binary[1]}/${name}`), 'Unlisted human output');
          assert(files.includes('tools/human-asset-contract.mjs'), 'Unlisted human contract');
          const metaPath = `game/assets/resources/office-cast/${binary[1]}/character.fbx.meta`;
          assert(files.includes(metaPath), 'Unlisted human import metadata');
          const raw = JSON.parse(read(metaPath)).userData?.animationImportSettings;
          assert(Array.isArray(raw) && raw.length === 1, 'Human raw import timeline missing');
          validateHumanTimelineContract(manifest.generated.mesh, manifest.generated.convertedSkin, raw[0].duration);
        }
        else assert(manifest.source.provenance.kind === 'original-procedural' && binary[2] !== 'fabric.png', 'Asset provenance');
        const generatorPath = human ? HUMAN_GENERATOR : 'tools/create-office-cast.py';
        assert(files.includes(generatorPath), 'Unlisted generator');
        const generator = read(generatorPath), g = manifest.generated;
        assert(g.generatorSha256 === sha(generator) && g.sourceHash === sha(Buffer.concat([generator, Buffer.from(JSON.stringify(canonical(manifest.source)))])), 'Source identity');
        const record = g.outputs[binary[2]];
        assert(record?.path === file && record.bytes === bytes.length && record.sha256 === sha(bytes), 'Asset hash/size/path');
        if (binary[2].endsWith('.png')) {
          if (binary[2] === 'portrait.png') assert(g.portraitReviewed === true, 'Portrait not reviewed');
          const size = checkPng(bytes, report); assert(record.width === size.width && record.height === size.height, 'PNG dimensions');
        } else checkFbx(bytes, report, human ? { mediaNames: ['fabric.png'] } : undefined);
        continue;
      }
      if (bytes.includes(0)) { report('unreviewed-binary'); continue; }
      const text = bytes.toString('utf8');
      if (file === '.env.example' && text.split(/\r?\n/).some(line => {
        const value = line.trim();
        return value && !value.startsWith('#') && !/^[A-Za-z_][A-Za-z0-9_]*=\s*$/.test(value);
      })) report('nonempty-env-example');
      scanText(text, report);
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
  const namedFbx = (name, text, mediaContext = false) => {
    const header = Buffer.alloc(27); Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary').copy(header); header.writeUInt32LE(7400, 23);
    const value = text === undefined ? Buffer.alloc(0) : Buffer.from(text), prop = text === undefined ? Buffer.alloc(0) : Buffer.alloc(value.length + 5);
    if (prop.length) { prop[0] = 83; prop.writeUInt32LE(value.length, 1); value.copy(prop, 5); }
    const parent = mediaContext ? Buffer.alloc(20) : Buffer.alloc(0), node = Buffer.alloc(13 + Buffer.byteLength(name));
    node.writeUInt32LE(27 + parent.length + node.length + prop.length + 13); node.writeUInt32LE(prop.length ? 1 : 0, 4); node.writeUInt32LE(prop.length, 8); node[12] = Buffer.byteLength(name); node.write(name, 13);
    if (mediaContext) { parent.writeUInt32LE(27 + parent.length + node.length + prop.length + 26); parent[12] = 7; parent.write('Texture', 13); }
    return Buffer.concat([header, parent, node, prop, Buffer.alloc(mediaContext ? 39 : 26)]);
  };
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
  check('fbx-v1-still-rejects-texture-node', () => assert.throws(() => checkFbx(namedFbx('Texture'), () => {}), /external media/));
  check('fbx-v2-exact-relative-fabric', () => assert.doesNotThrow(() => checkFbx(namedFbx('RelativeFilename', 'fabric.png', true), () => {}, { mediaNames: ['fabric.png'] })));
  check('fbx-v2-refuses-other-media-options', () => assert.throws(() => checkFbx(namedFbx('RelativeFilename', 'other.png'), () => {}, { mediaNames: ['other.png'] }), /declared human fabric/));
  check('fbx-v2-refuses-escaping-media', () => assert.throws(() => checkFbx(namedFbx('Filename', '../fabric.png', true), () => {}, { mediaNames: ['fabric.png'] }), /exact declared relative/));
  check('fbx-v2-refuses-absolute-media', () => assert.throws(() => checkFbx(namedFbx('Filename', 'C:/external/fabric.png', true), () => {}, { mediaNames: ['fabric.png'] }), /exact declared relative/));
  check('fbx-v2-refuses-other-logical-media', () => assert.throws(() => checkFbx(namedFbx('Media', 'Other\0\x01Video'), () => {}, { mediaNames: ['fabric.png'] }), /media reference/));
  check('fbx-v2-refuses-embedded-media', () => assert.throws(() => checkFbx(namedFbx('Content', 'original'), () => {}, { mediaNames: ['fabric.png'] }), /embedded media/));
  check('fbx-v2-requires-texture-reference', () => assert.throws(() => checkFbx(fbx(arr('original')), () => {}, { mediaNames: ['fabric.png'] }), /texture reference missing/));
  check('manifest-required', () => assert(run(new Map([...view].filter(([k]) => k !== manifestPath))).length));
  check('generator-must-be-listed', () => assert(audit([...view.keys()].filter(k => k !== generatorPath), read(view)).some(f => f.file === assetPath && f.category.includes('Unlisted generator'))));
  check('source-generator-hash', () => assert(run(new Map(view).set(generatorPath, Buffer.from('changed generator'))).length));
  check('asset-magic', () => assert(run(new Map(view).set(assetPath, Buffer.from('wrong'))).length));
  check('binary-path-boundary', () => assert(run(new Map(view).set('private.png', png)).length));
  check('asset-hash', () => { const altered = structuredClone(manifest); altered.generated.outputs['portrait.png'].sha256 = '0'.repeat(64); assert(run(new Map(view).set(manifestPath, Buffer.from(JSON.stringify(altered)))).length); });
  const humanSource = {
    roleId: 'manager', assetRevision: 3, generatorVersion: 'office-human-2', rigSpecVersion: 'office-humanoid-29-v2', blenderVersion: '4.5.14 LTS',
    provenance: { kind: 'cc0-derived', source: HUMAN_GENERATOR, author: 'Slap Duel project', license: 'CC0 base with project derivative' },
    baseMesh: { ...HUMAN_BASE, authors: ['Dan Ulrich'] },
    clothing: structuredClone(HUMAN_CLOTHING),
    runtime: { boneCount: 29, identityMaterial: 8, materials: [...HUMAN_MATERIALS], restPose: 'human-a-rest-v2', uvStrategy: 'single-tile-atlas',
      anchors: { palm: [0, .001, 0], cheekLeft: [.0012, .0007, .00145], cheekRight: [-.0012, .0007, .00145] } },
  };
  const humanGenerator = Buffer.from('human generator fixture'), humanBase = 'game/assets/resources/office-cast/manager/';
  const humanFbx = namedFbx('RelativeFilename', 'fabric.png', true);
  const humanManifest = { schemaVersion: 1, source: humanSource, generated: {
    generatorSha256: sha(humanGenerator), sourceHash: sha(Buffer.concat([humanGenerator, Buffer.from(JSON.stringify(canonical(humanSource)))])), portraitReviewed: true,
    mesh: { timelineFps: { fps: 60, fpsBase: 1 }, sourceClips: Array.from({ length: 13 }, () => ({ fps: 60, to: 15.1 })) },
    convertedSkin: { animationFps: 60, animationDuration: 15.1 },
    outputs: Object.fromEntries([['character.fbx', humanFbx], ['portrait.png', png], ['fabric.png', png]].map(([name, bytes]) => [name,
      { path: humanBase + name, bytes: bytes.length, sha256: sha(bytes), ...(name.endsWith('.png') ? { width: 1, height: 1 } : {}) }])) } };
  const humanView = new Map([[HUMAN_GENERATOR, humanGenerator], ['tools/human-asset-contract.mjs', Buffer.from('contract fixture')],
    [manifestPath, Buffer.from(JSON.stringify(humanManifest))], [humanBase + 'character.fbx', humanFbx], [assetPath, png], [humanBase + 'fabric.png', png],
    [humanBase + 'character.fbx.meta', Buffer.from(JSON.stringify({ userData: { animationImportSettings: [{ duration: 15.1 }] } }))]]);
  const alterHuman = change => { const updated = structuredClone(humanManifest); change(updated); return new Map(humanView).set(manifestPath, Buffer.from(JSON.stringify(updated))); };
  check('v2-public-fixed-derived-package', () => assert.deepEqual(run(humanView), []));
  check('v2-public-refuses-24fps-scene', () => assert(run(alterHuman(m => m.generated.mesh.timelineFps.fps = 24)).length));
  check('v2-public-refuses-37.75s-converted-timebase', () => assert(run(alterHuman(m => m.generated.convertedSkin.animationDuration = 37.75)).length));
  check('v2-public-refuses-24fps-converted-sampler', () => assert(run(alterHuman(m => m.generated.convertedSkin.animationFps = 24)).length));
  check('v2-public-refuses-37.75s-Creator-raw-timeline', () => {
    const changed = new Map(humanView).set(humanBase + 'character.fbx.meta', Buffer.from(JSON.stringify({ userData: { animationImportSettings: [{ duration: 37.75 }] } })));
    assert(run(changed).length);
  });
  check('v2-public-requires-import-timeline-metadata', () => assert(run(new Map([...humanView].filter(([name]) => name !== humanBase + 'character.fbx.meta'))).length));
  check('v2-public-fixed-base-url', () => {
    const changed = alterHuman(m => {
      m.source.baseMesh.url = 'https://example.com/body.zip';
      m.generated.sourceHash = sha(Buffer.concat([humanGenerator, Buffer.from(JSON.stringify(canonical(m.source)))]));
    });
    assert(run(changed).length);
  });
  check('v2-public-contract-must-be-listed', () => assert(run(new Map([...humanView].filter(([name]) => name !== 'tools/human-asset-contract.mjs'))).length));
  check('v2-public-fabric-must-be-listed', () => assert(run(new Map([...humanView].filter(([name]) => name !== humanBase + 'fabric.png'))).length));
  check('v2-public-other-texture-path', () => assert(run(new Map(humanView).set(humanBase + 'normal.png', png)).some(item => item.category === 'nonpublic-path')));
  check('v2-public-generator-hash', () => assert(run(new Map(humanView).set(HUMAN_GENERATOR, Buffer.from('changed human generator'))).length));
  check('v2-public-fabric-metadata', () => {
    const changed = alterHuman(m => { const record = m.generated.outputs['fabric.png']; record.bytes = dirtyPng.length; record.sha256 = sha(dirtyPng); });
    changed.set(humanBase + 'fabric.png', dirtyPng); assert(run(changed).some(item => item.file === humanBase + 'fabric.png' && item.category.startsWith('asset-validation:')));
  });
  check('private-key-path', () => assert(audit(['private/file.key'], () => Buffer.from('')).length));
  check('env-example-empty-values', () => assert.deepEqual(audit(['.env.example'], () => Buffer.from('# Local configuration\nVIGGLE_API_KEY=\n')), []));
  check('env-example-rejects-filled-values', () => assert(audit(['.env.example'], () => Buffer.from('VIGGLE_API_KEY=fixture-value\n')).some(f => f.category === 'nonempty-env-example')));
  check('env-example-still-scans-comments', () => assert(audit(['.env.example'], () => Buffer.from('# ntn_' + 'x'.repeat(35))).some(f => f.category === 'service-token')));
  check('private-env-paths', () => {
    for (const file of ['.env', '.env.local', '.env.production', 'game/assets/.env', 'game/assets/.env.example',
      '.ENV', '.ENV.production', '.Env.example', 'game/assets/.ENV', 'game/assets/.ENV.production', 'game/assets/.Env.example']) {
      assert(audit([file], () => Buffer.from('')).some(f => f.category === 'nonpublic-path'));
    }
  });
  check('service-token', () => { const found = []; scanText('ntn_' + 'x'.repeat(35), c => found.push(c)); assert(found.includes('service-token')); });
  console.log(JSON.stringify({ passed: true, scope: 'isolated-public-asset-fixtures', checks: passed.length, cases: passed }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const staged = process.argv.includes('--staged');
if (process.argv.slice(2).some(arg => !['--staged', '--self-test'].includes(arg))) throw new Error('Usage: node tools/check-public-tree.mjs [--staged | --self-test]');
if (process.argv.includes('--self-test')) { selfTest(); process.exit(0); }
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
const findings = audit(files, file => staged ? execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }) : fs.readFileSync(path.join(root, file)));
if (!files.length) findings.push({ file: '<index>', category: 'empty-tree' });
console.log(JSON.stringify({ passed: findings.length === 0, scope: staged ? 'staged-public-tree' : 'tracked-working-tree', files: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
}
