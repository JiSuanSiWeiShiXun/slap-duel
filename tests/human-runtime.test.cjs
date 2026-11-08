const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const api = import(pathToFileURL(path.join(root, 'tools/check-human-runtime.mjs')).href);
const privateRoot = path.join(root, 'game/local/human-runtime-checker-tests');
const buildId = 'P1-abcdef0-12345678-20261108T010000000Z';
const sourceHash = 'a'.repeat(64);
const imports = { prefabUuid: '11111111-1111-1111-1111-111111111111@9d5eb', skeletonUuid: '11111111-1111-1111-1111-111111111111@438fe' };
function fixture(t) {
  fs.mkdirSync(privateRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(privateRoot, 'test-'));
  t.after(() => {
    assert(path.resolve(dir).startsWith(path.resolve(privateRoot) + path.sep));
    fs.rmSync(dir, { recursive: true });
  });
  const ref = (name, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    fs.writeFileSync(path.join(dir, name), bytes);
    return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  const data = {
    schemaVersion: 1, plan: '02-10', status: 'partial',
    candidate: { buildId, target: 'web-desktop', sourceHash,
      manifest: ref('build-manifest.json', { buildId, target: 'web-desktop', engine: '3.8.8', revision: 'abcdef0',
        sourceDigest: 'b'.repeat(64), inputFingerprint: 'c'.repeat(64), builtAt: '2026-11-08T01:00:00.000Z' }),
      roleManifest: ref('manager-manifest.json', { schemaVersion: 1,
        source: { roleId: 'manager', generatorVersion: 'office-human-2', rigSpecVersion: 'office-humanoid-29-v2' },
        generated: { sourceHash, imports } }) },
    artifacts: [
      { id: 'screen', kind: 'screenshot', ...ref('actual.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')) },
      { id: 'raw', kind: 'runtime-json', ...ref('runtime.json', { build: buildId,
        events: [{ id: 'local-1:1', sessionId: 'local-1', kind: 'hit', actorId: 0, targetId: 1, atMs: 1680, damage: 1 }] }) },
      { id: 'raw-right', kind: 'runtime-json', ...ref('runtime-right.json', { build: buildId, playerStation: 1,
        events: [{ id: 'local-2:1', sessionId: 'local-2', kind: 'hit', actorId: 0, targetId: 1, atMs: 1680, damage: 1 }] }) },
    ],
    runs: [{ id: 'native-web', buildId, target: 'web-desktop', surface: 'desktop-browser', input: 'browser-native', entry: 'default',
      capturedAt: '2026-11-08T01:01:00.000Z', viewport: { width: 390, height: 844 }, artifacts: ['screen', 'raw'], playerStation: 0,
      actors: [0, 1].map(actorId => ({ actorId, station: actorId, roleId: 'manager', sourceHash, ...imports, joints: 29, skinnedRenderers: 1, useBakedAnimation: false })),
      cases: [{ id: 'default-entry', status: 'passed', expected: 'Default menu shows the human manager.', actual: 'Menu observed.',
        artifacts: ['screen', 'raw'], observedClips: [], review: { by: 'test reviewer', at: '2026-11-08T01:02:00.000Z', conclusion: 'Actual captured surface reviewed.' } }] }],
    adoption: { status: 'pending', buildId },
  };
  return { dir, ref, data };
}
function complete(data, constants) {
  const template = data.runs[0].cases[0];
  data.runs[0].cases = constants.HUMAN_RUNTIME_CASES.filter(id => !id.startsWith('station-1-')).map(id => ({ ...structuredClone(template), id }));
  data.runs[0].cases[0].observedClips = [...constants.HUMAN_RUNTIME_CLIPS];
  const right = structuredClone(data.runs[0]);
  right.id = 'native-web-right'; right.playerStation = 1; right.entry = 'diagnostic'; right.artifacts = ['screen', 'raw-right'];
  right.actors = right.actors.map(actor => ({ ...actor, station: 1 - actor.actorId }));
  right.cases = constants.HUMAN_RUNTIME_CASES.filter(id => id.startsWith('station-1-')).map(id => ({ ...structuredClone(template), id, artifacts: ['screen', 'raw-right'] }));
  data.runs.push(right);
  data.status = 'runtime-complete';
}

test('partial actual records remain structurally valid and cannot imply complete/adopted', async t => {
  const { validateHumanRuntime, HUMAN_RUNTIME_CASES } = await api, { data, dir } = fixture(t);
  data.runs[0].cases.push({ id: 'station-0-parry', status: 'pending', expected: 'A native precise parry.', actual: 'Not reached in this run.' });
  const result = validateHumanRuntime(data, dir);
  assert.equal(result.valid, true); assert.equal(result.complete, false); assert.equal(result.adoption, 'pending');
  assert.deepEqual(result.passed, ['default-entry']);
  assert.deepEqual(result.pending, ['station-0-parry']);
  assert.equal(result.missing.length, HUMAN_RUNTIME_CASES.length - 1);
  assert(result.missing.includes('station-0-parry'));
});
test('complete structure requires every actual case and all thirteen observed clips', async t => {
  const constants = await api, { data, dir } = fixture(t); complete(data, constants);
  const result = constants.validateHumanRuntime(data, dir);
  assert.equal(result.complete, true); assert.equal(result.passed.length, constants.HUMAN_RUNTIME_CASES.length);
  assert.deepEqual(result.missingClips, []); assert.equal(result.adoption, 'pending');
});
for (const [name, change, error] of [
  ['pending status asserted complete', d => d.status = 'runtime-complete', /contradicts pending/],
  ['partial record asserts allPassed', d => d.allPassed = true, /allPassed contradicts pending/],
  ['manager-only record completes phase', d => d.phaseComplete = true, /manager-only record/],
  ['manager-only record completes broad requirements', d => d.requirementsCompleted = ['ART-01'], /manager-only record/],
  ['unknown status', d => d.runs[0].cases[0].status = 'complete', /invalid status/],
  ['duplicate case', d => d.runs[0].cases.push(structuredClone(d.runs[0].cases[0])), /duplicate case/],
  ['unknown case', d => d.runs[0].cases[0].id = 'looks-human', /unknown/],
  ['missing actual conclusion', d => d.runs[0].cases[0].actual = '', /nonempty text/],
  ['missing original screenshot', d => d.runs[0].cases[0].artifacts = ['raw'], /screenshot and runtime JSON/],
  ['unknown screenshot reference', d => d.runs[0].cases[0].artifacts = ['missing', 'raw'], /unknown artifact/],
  ['unreviewed image', d => delete d.runs[0].cases[0].review, /review/],
  ['invented clip', d => d.runs[0].cases[0].observedClips = ['cheer'], /invalid observed clips/],
  ['diagnostic entry counted default', d => d.runs[0].entry = 'diagnostic', /default-entry/],
  ['old runtime build', d => d.runs[0].buildId = 'P1-0000000-00000000-20261107T010000000Z', /build\/target mismatch/],
  ['synthetic browser inputs', d => d.runs[0].input = 'dispatchEvent', /runtime surface\/input/],
  ['handler calls used for input', d => d.runs[0].input = 'game-handler', /runtime surface\/input/],
  ['browser evidence counted as WeChat', d => d.runs[0].surface = 'wechat-simulator', /runtime surface\/input/],
  ['anonymous physical device', d => d.runs[0].surface = 'physical-phone', /phone model/],
  ['capture before build', d => d.runs[0].capturedAt = '2026-11-07T00:00:00Z', /predates build/],
  ['review before capture', d => d.runs[0].cases[0].review.at = '2026-11-07T00:00:00Z', /predates capture/],
  ['duplicate artifact', d => d.artifacts.push(structuredClone(d.artifacts[0])), /duplicate artifact/],
  ['remote evidence URL', d => d.artifacts[0].path = 'https://example.com/a.png', /unsafe relative path/],
  ['path traversal', d => d.artifacts[0].path = '../actual.png', /unsafe relative path/],
  ['drive-relative reference', d => d.artifacts[0].path = 'C:actual.png', /unsafe relative path/],
  ['unknown adoption status', d => d.adoption.status = 'approved', /adoption status/],
  ['adoption attached to old build', d => d.adoption.buildId = 'old', /adoption status/],
  ['adoption without user quote', d => d.adoption.status = 'accepted', /user adoption quote/],
]) test(`human runtime rejects ${name}`, async t => {
  const { validateHumanRuntime } = await api, { data, dir } = fixture(t); change(data);
  assert.throws(() => validateHumanRuntime(data, dir), error);
});

test('raw event data must be chronological and preserve unique actual event IDs', async t => {
  const { validateHumanRuntime } = await api, { data, dir, ref } = fixture(t);
  const event = { id: 'local-1:1', sessionId: 'local-1', kind: 'hit', actorId: 0, targetId: 1, atMs: 1680, damage: 1 };
  Object.assign(data.artifacts[1], ref('runtime.json', { build: buildId, events: [event, event] }));
  assert.throws(() => validateHumanRuntime(data, dir), /duplicate event/);
  Object.assign(data.artifacts[1], ref('runtime.json', { build: buildId, events: [event, { ...event, id: 'local-1:2', atMs: 1679 }] }));
  assert.throws(() => validateHumanRuntime(data, dir), /nonmonotonic/);
});
test('a changed screenshot is rejected even when its original path still exists', async t => {
  const { validateHumanRuntime } = await api, { data, dir } = fixture(t);
  fs.appendFileSync(path.join(dir, 'actual.png'), 'altered');
  assert.throws(() => validateHumanRuntime(data, dir), /size\/hash mismatch/);
});
test('text cannot masquerade as an actual runtime screenshot', async t => {
  const { validateHumanRuntime } = await api, { data, dir, ref } = fixture(t);
  Object.assign(data.artifacts[0], ref('actual.png', 'not an image'));
  assert.throws(() => validateHumanRuntime(data, dir), /screenshot signature/);
});
test('real ended/rejected optional fields and a new session clock are accepted', async t => {
  const { validateHumanRuntime } = await api, { data, dir, ref } = fixture(t);
  Object.assign(data.artifacts[1], ref('runtime.json', { build: buildId, events: [
    { id: 'local-1:1', sessionId: 'local-1', kind: 'rejected', atMs: 100, actorId: 0, reason: 'invalid-time' },
    { id: 'local-1:2', sessionId: 'local-1', kind: 'ended', atMs: 200, reason: 'player' },
    { id: 'local-2:1', sessionId: 'local-2', kind: 'attack-start', atMs: 0, actorId: 0, targetId: 1, damage: 1 },
  ] }));
  assert.doesNotThrow(() => validateHumanRuntime(data, dir));
});
test('raw runtime JSON cannot silently borrow a different build', async t => {
  const { validateHumanRuntime } = await api, { data, dir, ref } = fixture(t);
  Object.assign(data.artifacts[1], ref('runtime.json', { build: 'old' }));
  assert.throws(() => validateHumanRuntime(data, dir), /runtime build mismatch/);
});
test('manager combat cases require both imported real skin identities and actual events', async t => {
  const { validateHumanRuntime } = await api, { data, dir, ref } = fixture(t);
  data.runs[0].cases[0].id = 'station-0-parry';
  assert.doesNotThrow(() => validateHumanRuntime(data, dir));
  data.runs[0].actors[1].sourceHash = 'f'.repeat(64);
  assert.throws(() => validateHumanRuntime(data, dir), /source identity mismatch/);
  data.runs[0].actors[1].sourceHash = sourceHash;
  data.runs[0].actors[1].useBakedAnimation = true;
  assert.throws(() => validateHumanRuntime(data, dir), /skin\/rig\/animation/);
  data.runs[0].actors[1].useBakedAnimation = false;
  Object.assign(data.artifacts[1], ref('runtime.json', { build: buildId, events: [] }));
  assert.throws(() => validateHumanRuntime(data, dir), /nonempty actual event evidence/);
});
test('right-side evidence keeps native parry actor zero and records the inverse presentation mapping', async t => {
  const constants = await api, { data, dir, ref } = fixture(t); complete(data, constants);
  Object.assign(data.artifacts[2], ref('runtime-right.json', { build: buildId, samples: [{ playerStation: 1 }], events: [
    { id: 'local-2:1', sessionId: 'local-2', kind: 'parry', actorId: 0, targetId: 1, atMs: 480, damage: 0 },
    { id: 'local-2:2', sessionId: 'local-2', kind: 'counter-hit', actorId: 0, targetId: 1, atMs: 660, damage: 1 },
  ] }));
  const result = constants.validateHumanRuntime(data, dir);
  assert.equal(result.complete, true);
  assert.deepEqual(result.mappings[1], { runId: 'native-web-right', playerStation: 1, actors: [{ actorId: 0, station: 1 }, { actorId: 1, station: 0 }] });
  data.runs[1].actors[0].station = 0; data.runs[1].actors[1].station = 1;
  assert.throws(() => constants.validateHumanRuntime(data, dir), /logical actor\/presentation station mapping/);
});
test('station-one claims require original mirrored diagnostic capture and cannot borrow ordinary actor-one events', async t => {
  const constants = await api, { data, dir, ref } = fixture(t); complete(data, constants);
  data.runs[1].entry = 'default';
  assert.throws(() => constants.validateHumanRuntime(data, dir), /requires browser diagnostic entry/);
  data.runs[1].entry = 'diagnostic';
  Object.assign(data.artifacts[2], ref('runtime-right.json', { build: buildId, events: [
    { id: 'local-2:1', sessionId: 'local-2', kind: 'parry', actorId: 1, targetId: 0, atMs: 480, damage: 0 },
  ] }));
  assert.throws(() => constants.validateHumanRuntime(data, dir), /lacks actual diagnostic station capture/);
  Object.assign(data.artifacts[2], ref('runtime-right.json', { build: buildId, playerStation: 0, events: [] }));
  assert.throws(() => constants.validateHumanRuntime(data, dir), /original runtime presentation station mismatch/);
});
test('accepted adoption requires exact build-bound user reply and complete runtime structure', async t => {
  const constants = await api, { data, dir, ref } = fixture(t); complete(data, constants);
  data.adoption = { status: 'accepted', buildId, quote: 'This actual character is suitable for expansion.', evidence: 'reply' };
  data.artifacts.push({ id: 'reply', kind: 'source-reference', ...ref('reply.md', `${buildId}\n${data.adoption.quote}\n`) });
  assert.equal(constants.validateHumanRuntime(data, dir).adoption, 'accepted');
  data.adoption.quote = 'An invented replacement quote.';
  assert.throws(() => constants.validateHumanRuntime(data, dir), /exact quote\/build/);
});
test('missing clip coverage and failed/pending cases cannot hide under runtime-complete', async t => {
  const constants = await api, { data, dir } = fixture(t); complete(data, constants);
  data.runs[0].cases[0].observedClips.pop();
  assert.throws(() => constants.validateHumanRuntime(data, dir), /contradicts pending/);
  data.runs[0].cases[0].observedClips = [...constants.HUMAN_RUNTIME_CLIPS];
  data.runs[0].cases[1].status = 'failed';
  data.status = 'partial';
  assert.deepEqual(constants.validateHumanRuntime(data, dir).failed, ['head-gameplay']);
  data.status = 'runtime-complete';
  assert.throws(() => constants.validateHumanRuntime(data, dir), /contradicts pending/);
});
test('CLI returns 0 for valid partial structure and 2 when completeness is required', async t => {
  const { data, dir } = fixture(t);
  // CLI references are always relative to the actual project root, unlike isolated unit fixtures.
  const prefix = path.relative(root, dir).replaceAll('\\', '/');
  data.candidate.manifest.path = `${prefix}/${data.candidate.manifest.path}`;
  data.candidate.roleManifest.path = `${prefix}/${data.candidate.roleManifest.path}`;
  for (const artifact of data.artifacts) artifact.path = `${prefix}/${artifact.path}`;
  const filename = path.join(dir, 'evidence.json'); fs.writeFileSync(filename, JSON.stringify(data));
  const checker = path.join(root, 'tools/check-human-runtime.mjs');
  const checked = spawnSync(process.execPath, [checker, '--check', filename], { encoding: 'utf8', cwd: root });
  assert.equal(checked.status, 0, checked.stderr); assert.match(checked.stdout, /"complete": false/);
  const required = spawnSync(process.execPath, [checker, '--check', filename, '--require-complete'], { encoding: 'utf8', cwd: root });
  assert.equal(required.status, 2, required.stderr);
});
