import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/;
const BUILD = /^P1-[a-f0-9]+-[a-f0-9]{8}-[0-9TZ]+$/;
const UUID = /^[a-f0-9-]{36}@[a-f0-9]+$/;
const STATUS = ['passed', 'pending', 'failed', 'human_needed'];
const KINDS = ['screenshot', 'runtime-json', 'recording', 'source-reference'];
export const HUMAN_RUNTIME_CLIPS = Object.freeze([
  'idle', 'intro-positive', 'intro-negative', 'charge', 'attack-light', 'attack-heavy',
  'recovery', 'guard', 'hit', 'counter', 'counter-recovery', 'victory', 'defeat',
]);
export const HUMAN_RUNTIME_CASES = Object.freeze([
  'default-entry', 'head-gameplay', 'head-detail', 'hands-gameplay', 'hands-detail',
  'clothing-gameplay', 'clothing-detail',
  // Station is the player's presentation side. Native commands and parries remain actor 0.
  ...[0, 1].flatMap(station => ['charge-short', 'charge-full', 'tap', 'guard', 'parry',
    'counter-pause', 'counter-reset'].map(kind => `station-${station}-${kind}`)),
  'result-player', 'result-opponent', 'result-draw',
]);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = (value, label) => assert(value && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
const text = (value, label) => assert(typeof value === 'string' && value.trim(), `${label}: nonempty text required`);
function instant(value, label) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), `${label}: ISO timestamp required`);
  return Date.parse(value);
}
function json(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${label}: invalid JSON`); }
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function readReference(ref, root, label) {
  object(ref, label);
  // Evidence is local, auditable and portable. Neither URLs nor drive paths are file references.
  assert(typeof ref.path === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(ref.path) && !ref.path.includes('\\') &&
    !ref.path.split('/').some(part => !part || part === '.' || part === '..') && !path.isAbsolute(ref.path), `${label}: unsafe relative path`);
  const file = path.resolve(root, ref.path);
  assert(inside(root, file) && fs.existsSync(file) && fs.statSync(file).isFile(), `${label}: missing/unsafe file`);
  assert(inside(fs.realpathSync(root), fs.realpathSync(file)), `${label}: symlink escapes project`);
  assert(Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && SHA.test(ref.sha256), `${label}: bytes/SHA256 required`);
  const bytes = fs.readFileSync(file);
  assert(bytes.length === ref.bytes && digest(bytes) === ref.sha256, `${label}: file size/hash mismatch`);
  return bytes;
}
function ids(values, lookup, label) {
  assert(Array.isArray(values) && values.length > 0 && new Set(values).size === values.length, `${label}: unique artifact IDs required`);
  for (const id of values) assert(typeof id === 'string' && lookup.has(id), `${label}: unknown artifact ${id}`);
  return values.map(id => lookup.get(id));
}
function actorIdentity(actor, imports, sourceHash) {
  object(actor, 'runtime actor');
  assert(actor.roleId === 'manager' && actor.sourceHash === sourceHash, 'runtime actor: manager/source identity mismatch');
  assert(actor.prefabUuid === imports.prefabUuid && actor.skeletonUuid === imports.skeletonUuid &&
    UUID.test(actor.prefabUuid) && UUID.test(actor.skeletonUuid), 'runtime actor: imported identity mismatch');
  assert(actor.joints === 29 && actor.skinnedRenderers === 1 && actor.useBakedAnimation === false, 'runtime actor: skin/rig/animation mismatch');
}
function runtimeEvents(data, label) {
  assert(Array.isArray(data.events), `${label}: actual events array required`);
  const seen = new Set(), lastBySession = new Map();
  for (const event of data.events) {
    object(event, label);
    text(event.id, `${label} event id`); text(event.sessionId, `${label} event session`); text(event.kind, `${label} event kind`);
    assert(['attack-start', 'hit', 'block', 'parry', 'counter-hit', 'rejected', 'ended'].includes(event.kind), `${label}: unknown event kind`);
    assert(event.id.startsWith(`${event.sessionId}:`), `${label}: event ID/session mismatch`);
    assert(!seen.has(event.id), `${label}: duplicate event id`); seen.add(event.id);
    assert(Number.isFinite(event.atMs) && event.atMs >= 0 && event.atMs >= (lastBySession.get(event.sessionId) ?? -Infinity), `${label}: invalid/nonmonotonic event time`);
    lastBySession.set(event.sessionId, event.atMs);
    const combat = !['rejected', 'ended'].includes(event.kind);
    if (combat || event.actorId !== undefined) assert([0, 1].includes(event.actorId), `${label}: invalid event actor`);
    if (combat || event.targetId !== undefined) assert([0, 1].includes(event.targetId) && event.actorId !== event.targetId, `${label}: invalid event target`);
    if (combat || event.damage !== undefined) assert(Number.isInteger(event.damage) && event.damage >= 0 && event.damage <= 2, `${label}: invalid event damage`);
    if (!combat) text(event.reason, `${label} event reason`);
  }
}

/** Checks recorded structure and byte attribution, never visual quality or runtime truth. */
export function validateHumanRuntime(data, root = ROOT) {
  object(data, 'evidence');
  assert(data.schemaVersion === 1 && data.plan === '02-10', 'human runtime schema/plan mismatch');
  assert(['partial', 'runtime-complete'].includes(data.status), 'evidence status must be partial or runtime-complete');
  const candidate = data.candidate; object(candidate, 'candidate');
  assert(BUILD.test(candidate.buildId) && ['web-desktop', 'wechatgame'].includes(candidate.target) && SHA.test(candidate.sourceHash), 'candidate build/target/sourceHash required');
  const build = json(readReference(candidate.manifest, root, 'build manifest'), 'build manifest');
  assert(build.buildId === candidate.buildId && build.target === candidate.target && build.engine === '3.8.8' &&
    SHA.test(build.sourceDigest) && SHA.test(build.inputFingerprint), 'build manifest: identity/provenance mismatch');
  text(build.revision, 'build revision');
  const builtAt = instant(build.builtAt, 'build builtAt');
  const role = json(readReference(candidate.roleManifest, root, 'role manifest'), 'role manifest');
  assert(role.schemaVersion === 1 && role.source?.roleId === 'manager' && role.source?.generatorVersion === 'office-human-2' &&
    role.source?.rigSpecVersion === 'office-humanoid-29-v2' && role.generated?.sourceHash === candidate.sourceHash,
  'role manifest: new human lineage/source mismatch');
  const imports = role.generated?.imports; object(imports, 'role imports');
  assert(UUID.test(imports.prefabUuid) && UUID.test(imports.skeletonUuid), 'role imports: actual prefab/skeleton required');

  assert(Array.isArray(data.artifacts), 'artifacts array required');
  const artifacts = new Map();
  const artifactPaths = new Set();
  for (const artifact of data.artifacts) {
    object(artifact, 'artifact'); text(artifact.id, 'artifact id');
    assert(!artifacts.has(artifact.id) && !artifactPaths.has(artifact.path), 'duplicate artifact ID/path');
    assert(KINDS.includes(artifact.kind), `artifact ${artifact.id}: invalid kind`);
    const bytes = readReference(artifact, root, `artifact ${artifact.id}`);
    if (artifact.kind === 'screenshot') {
      assert((/\.png$/.test(artifact.path) && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (/\.jpe?g$/.test(artifact.path) && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217),
      `artifact ${artifact.id}: screenshot signature/type mismatch`);
    }
    let parsed;
    if (artifact.kind === 'runtime-json') {
      assert(artifact.path.endsWith('.json'), `artifact ${artifact.id}: JSON extension required`);
      parsed = json(bytes, artifact.id); object(parsed, artifact.id);
      assert((parsed.buildId ?? parsed.build) === candidate.buildId, `artifact ${artifact.id}: runtime build mismatch`);
      if (parsed.events !== undefined) runtimeEvents(parsed, artifact.id);
    }
    artifactPaths.add(artifact.path); artifacts.set(artifact.id, { ...artifact, parsed });
  }
  assert(Array.isArray(data.runs), 'runs array required');
  const runIds = new Set(), passed = new Set(), observedClips = new Set(), cases = new Map(), mappings = [];
  for (const run of data.runs) {
    object(run, 'run'); text(run.id, 'run id');
    assert(!runIds.has(run.id), 'duplicate run id'); runIds.add(run.id);
    assert(run.buildId === candidate.buildId && run.target === candidate.target, `run ${run.id}: build/target mismatch`);
    const allowedInput = { 'desktop-browser': ['web-desktop', 'browser-native'], 'wechat-simulator': ['wechatgame', 'wechat-official-touch'],
      'physical-phone': [candidate.target, candidate.target === 'web-desktop' ? 'browser-native' : 'physical-touch'] }[run.surface];
    assert(allowedInput && run.target === allowedInput[0] && run.input === allowedInput[1], `run ${run.id}: invalid runtime surface/input`);
    assert(['default', 'diagnostic'].includes(run.entry), `run ${run.id}: entry required`);
    const playerStation = run.playerStation ?? 0;
    assert([0, 1].includes(playerStation), `run ${run.id}: invalid player presentation station`);
    if (playerStation === 1) assert(run.entry === 'diagnostic' && run.target === 'web-desktop', `run ${run.id}: mirrored player station requires browser diagnostic entry`);
    assert(instant(run.capturedAt, `run ${run.id} capturedAt`) >= builtAt, `run ${run.id}: capture predates build`);
    object(run.viewport, 'viewport');
    assert(Number.isInteger(run.viewport.width) && run.viewport.width > 0 && Number.isInteger(run.viewport.height) && run.viewport.height > 0, 'positive viewport required');
    if (run.surface === 'physical-phone') text(run.device, 'physical phone model');
    const runArtifacts = ids(run.artifacts, artifacts, `run ${run.id}`);
    assert(runArtifacts.some(a => a.kind === 'runtime-json'), `run ${run.id}: actual runtime JSON required`);
    assert(run.actors === undefined || Array.isArray(run.actors), `run ${run.id}: actors must be an array`);
    mappings.push({ runId: run.id, playerStation, actors: (run.actors ?? []).map(actor => ({ actorId: actor.actorId, station: actor.station })) });
    assert(Array.isArray(run.cases), `run ${run.id}: cases array required`);
    for (const item of run.cases) {
      object(item, 'case');
      assert(HUMAN_RUNTIME_CASES.includes(item.id) && !cases.has(item.id), `unknown/duplicate case ${item.id}`);
      assert(STATUS.includes(item.status), `case ${item.id}: invalid status`);
      text(item.expected, `case ${item.id} expected`); text(item.actual, `case ${item.id} actual`);
      cases.set(item.id, item.status);
      if (item.status !== 'passed') {
        if (item.artifacts !== undefined) ids(item.artifacts, artifacts, `case ${item.id}`);
        continue;
      }
      const refs = ids(item.artifacts, artifacts, `case ${item.id}`);
      assert(item.artifacts.every(id => run.artifacts.includes(id)), `case ${item.id}: evidence is outside its run`);
      assert(refs.some(a => a.kind === 'screenshot') && refs.some(a => a.kind === 'runtime-json'), `case ${item.id}: actual screenshot and runtime JSON required`);
      object(item.review, `case ${item.id} review`);
      text(item.review.by, 'reviewer'); text(item.review.conclusion, 'review conclusion');
      assert(instant(item.review.at, 'review timestamp') >= Date.parse(run.capturedAt), `case ${item.id}: review predates capture`);
      assert(Array.isArray(item.observedClips) && new Set(item.observedClips).size === item.observedClips.length &&
        item.observedClips.every(clip => HUMAN_RUNTIME_CLIPS.includes(clip)), `case ${item.id}: invalid observed clips`);
      for (const clip of item.observedClips) observedClips.add(clip);
      if (item.id === 'default-entry') assert(run.entry === 'default', 'default-entry cannot use diagnostic entry');
      if (item.id.startsWith('station-') || item.id.startsWith('result-')) {
        assert(Array.isArray(run.actors) && run.actors.length === 2 && new Set(run.actors.map(actor => actor.station)).size === 2 &&
          run.actors.every(actor => [0, 1].includes(actor.station)), `run ${run.id}: two actual manager stations required`);
        assert(new Set(run.actors.map(actor => actor.actorId)).size === 2 && run.actors.every(actor => [0, 1].includes(actor.actorId) &&
          actor.station === (playerStation === 0 ? actor.actorId : 1 - actor.actorId)), `run ${run.id}: logical actor/presentation station mapping mismatch`);
        if (item.id.startsWith('station-')) assert(Number(item.id.split('-')[1]) === playerStation,
          `case ${item.id}: case station is the player's display side, not the event actor ID`);
        const rawRecords = refs.filter(a => a.kind === 'runtime-json').flatMap(a => [a.parsed,
          ...(Array.isArray(a.parsed.samples) ? a.parsed.samples.filter(sample => sample && typeof sample === 'object') : [])]);
        const recordedStations = rawRecords.filter(record => record.playerStation !== undefined).map(record => record.playerStation);
        assert(recordedStations.every(station => station === playerStation), `case ${item.id}: original runtime presentation station mismatch`);
        if (playerStation === 1) assert(recordedStations.includes(1), `case ${item.id}: right-side claim lacks actual diagnostic station capture`);
        run.actors.forEach(actor => actorIdentity(actor, imports, candidate.sourceHash));
        assert(refs.some(a => a.kind === 'runtime-json' && Array.isArray(a.parsed.events) && a.parsed.events.length > 0),
          `case ${item.id}: nonempty actual event evidence required`);
      }
      passed.add(item.id);
    }
  }
  const missing = HUMAN_RUNTIME_CASES.filter(id => !passed.has(id));
  const missingClips = HUMAN_RUNTIME_CLIPS.filter(clip => !observedClips.has(clip));
  const complete = !missing.length && !missingClips.length;
  assert(data.status !== 'runtime-complete' || complete, `runtime-complete contradicts pending cases/clips: ${[...missing, ...missingClips].join(', ')}`);
  assert(data.allPassed !== true || complete, 'allPassed contradicts pending cases/clips');
  assert(data.phaseComplete !== true, 'A manager-only record cannot complete the whole phase');
  assert(data.requirementsCompleted === undefined || (Array.isArray(data.requirementsCompleted) && !data.requirementsCompleted.length),
    'A manager-only record cannot complete whole three-character requirements');
  object(data.adoption, 'adoption');
  assert(['pending', 'accepted', 'rejected'].includes(data.adoption.status) && data.adoption.buildId === candidate.buildId, 'adoption status/build mismatch');
  if (data.adoption.status !== 'pending') {
    text(data.adoption.quote, 'actual user adoption quote');
    text(data.adoption.evidence, 'actual user reply artifact ID');
    const reply = artifacts.get(data.adoption.evidence);
    assert(reply?.kind === 'source-reference', 'adoption requires actual user reply source reference');
    const replyText = fs.readFileSync(path.resolve(root, reply.path), 'utf8');
    assert(replyText.includes(data.adoption.quote) && replyText.includes(candidate.buildId), 'adoption source lacks exact quote/build attribution');
    if (data.adoption.status === 'accepted') assert(complete, 'accepted adoption cannot hide incomplete runtime matrix');
  }
  return { valid: true, complete, buildId: candidate.buildId, target: candidate.target, passed: [...passed], missing,
    pending: [...cases].filter(([, status]) => status === 'pending' || status === 'human_needed').map(([id]) => id),
    failed: [...cases].filter(([, status]) => status === 'failed').map(([id]) => id), missingClips, mappings, adoption: data.adoption.status };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), known = new Set(['--check', '--require-complete']);
    assert(!args.some(arg => arg.startsWith('--') && !known.has(arg)), 'Unknown option');
    const paths = args.filter(arg => !arg.startsWith('--'));
    assert(paths.length === 1, 'Usage: node tools/check-human-runtime.mjs --check <relative-evidence.json> [--require-complete]');
    const absolute = path.resolve(ROOT, paths[0]);
    assert(inside(ROOT, absolute), 'Evidence input must remain inside project');
    assert(inside(fs.realpathSync(ROOT), fs.realpathSync(absolute)), 'Evidence input symlink escapes project');
    const result = validateHumanRuntime(json(fs.readFileSync(absolute), 'evidence input'));
    console.log(JSON.stringify(result, null, 2));
    console.log('Structure and file attribution only; this does not prove visual quality, runtime truth, phone coverage, or user adoption.');
    if (args.includes('--require-complete') && !result.complete) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
