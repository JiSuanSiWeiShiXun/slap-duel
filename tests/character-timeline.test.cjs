const test = require('node:test');
const assert = require('node:assert/strict');
const { CharacterTimeline, solveTwoBone, characterContacts, presentationSide } = require('../.test-build/CharacterTimeline.js');
const { Battle, DEFAULT_RULES } = require('../.test-build/core/Battle.js');
const freeze = v => { Object.freeze(v); for (const child of Object.values(v)) if (child && typeof child === 'object') freeze(child); return v; };
const command = (sessionId, actorId, atMs, action, sequence = 1) => ({ sessionId, actorId, atMs, action, sequence });
function counterFrames(defender = 0) {
  const b = new Battle('clips', 'tap'), t = new CharacterTimeline(), frames = [];
  b.submit(command('clips', 1 - defender, 0, 'attack')); b.submit(command('clips', defender, 430, 'guard'));
  for (const now of [0, 430, 480, 659, 660, 661, 920]) {
    b.advanceTo(now); const state = freeze(b.snapshot()), events = freeze(b.drainEvents()); t.consume(state, events);
    frames.push({ state, events, samples: t.sample(state) });
  }
  return { b, t, frames };
}
test('compiled timeline maps every rule phase with deterministic read-only samples', () => {
  const b = new Battle('phases', 'charge'), t = new CharacterTimeline(), idle = b.snapshot();
  const expected = { idle: 'idle', charging: 'charge', windup: 'attack-light', recovery: 'recovery', guard: 'guard', parried: 'guard', counter: 'counter', 'counter-recovery': 'counter-recovery', stunned: 'hit' };
  for (const [phase, semanticClip] of Object.entries(expected)) {
    const state = freeze({ ...idle, nowMs: 51, fighters: [{ ...idle.fighters[0], phase, phaseStartMs: 1 }, idle.fighters[1]] });
    t.consume(state, []); const samples = t.sample(state);
    assert.equal(samples[0].semanticClip, semanticClip); assert.deepEqual(t.sample(state), samples);
    assert.ok(samples[0].normalizedTime >= 0 && samples[0].normalizedTime <= 1);
  }
});
test('attack-start damage survives the short UI trace and is session scoped', () => {
  const b = new Battle('heavy', 'charge'), t = new CharacterTimeline();
  b.submit(command('heavy', 0, 0, 'charge-start')); b.submit(command('heavy', 0, 1200, 'charge-release', 2)); b.advanceTo(1230);
  const state = freeze(b.snapshot()), events = b.drainEvents();
  t.consume(state, [...events, ...Array.from({ length: 40 }, (_, i) => ({ id: 'noise'+i, sessionId: 'heavy', kind: 'rejected', atMs: 1230 }))]);
  assert.equal(t.sample(state)[0].semanticClip, 'attack-heavy');
  t.consume(state, [...events].reverse()); assert.equal(t.sample(state)[0].semanticClip, 'attack-heavy');
  t.consume(state, [{ id: 'unseen-old', sessionId: 'heavy', atMs: 0, kind: 'attack-start', actorId: 0, damage: 1 }]);
  assert.equal(t.sample(state)[0].semanticClip, 'attack-heavy', 'cross-batch old attack cannot overwrite the current palm');
  const next = { ...state, sessionId: 'next' }; t.consume(next, events);
  assert.equal(t.sample(next)[0].semanticClip, 'attack-light');
});
test('charge reaches full at1200 and stays there until cancelled', () => {
  const b = new Battle('charge', 'charge'), t = new CharacterTimeline(); b.submit(command('charge', 0, 0, 'charge-start'));
  for (const now of [0, 600, 1200, 2401]) { b.advanceTo(now); const s = b.snapshot(); t.consume(s, b.drainEvents()); assert.equal(t.sample(s)[0].normalizedTime, Math.min(now / 1200, 1)); }
  b.submit(command('charge', 0, 2401, 'charge-cancel', 2)); b.advanceTo(2401); t.consume(b.snapshot(), b.drainEvents()); assert.equal(t.sample(b.snapshot())[0].semanticClip, 'idle');
});
test('future transport events are retryable at their rule time', () => {
  const s = new Battle('future', 'tap').snapshot(), t = new CharacterTimeline();
  const event = { id: 'future-heavy', sessionId: 'future', atMs: 100, kind: 'attack-start', actorId: 0, damage: 2 };
  t.consume(s, [event]);
  const later = { ...s, nowMs: 101, fighters: [{ ...s.fighters[0], phase: 'windup', phaseStartMs: 100 }, s.fighters[1]] };
  t.consume(later, [event]); assert.equal(t.sample(later)[0].semanticClip, 'attack-heavy');
});
test('parry catches before hit and counter contact remains exactly180ms on either side', () => {
  for (const side of [0,1]) {
    const { t, frames } = counterFrames(side), catchFrame = frames[2], before = frames[3], hit = frames[4], after = frames[5];
    assert.equal(catchFrame.samples[side].semanticClip, 'counter'); assert.equal(catchFrame.samples[side].normalizedTime, 0);
    assert.equal(before.samples[side].normalizedTime, 179 / 180); assert.equal(before.samples[1-side].pose.headRoll, 0);
    assert.equal(before.state.fighters[1-side].hp, 5); assert.equal(hit.state.fighters[1-side].hp, 4);
    assert.equal(hit.samples[side].semanticClip, 'counter-recovery'); assert.equal(hit.samples[side].normalizedTime, 0);
    assert.equal(hit.samples[1-side].semanticClip, 'hit'); assert.notEqual(after.samples[1-side].pose.headRoll, 0);
    assert.notEqual(hit.samples[side].pose.blockingHand, hit.samples[side].pose.counterHand);
    assert.deepEqual(t.sample(before.state), t.sample(before.state));
  }
});
test('all fresh batches, duplicates, old sessions and expired attacks do not replay', () => {
  const { frames } = counterFrames(), t = new CharacterTimeline(), reverse = new CharacterTimeline(), events = frames.flatMap(f => f.events), state = frames.at(-1).state;
  for (const f of frames) t.consume(f.state, f.events);
  reverse.consume(state, [...events].reverse()); assert.deepEqual(reverse.sample(state), t.sample(state));
  reverse.consume(state, events); assert.deepEqual(reverse.sample(state), t.sample(state));
  const late = { ...state, nowMs: 3000 }; reverse.consume(late, events); assert.deepEqual(reverse.sample(late), new CharacterTimeline().sample(late));
});
test('result uses actual winner and a separate elapsed time, including timeout with both alive', () => {
  const s = new Battle('end', 'tap').snapshot(), t = new CharacterTimeline();
  for (const result of ['player', 'bot', 'draw']) {
    const state = freeze({ ...s, nowMs: 60000, result }); t.consume(state, []);
    const first = t.sample(state, state.nowMs, 0), half = t.sample(state, state.nowMs, 450), last = t.sample(state, state.nowMs, 900);
    assert.deepEqual(first.map(f => f.semanticClip), result === 'draw' ? ['idle','idle'] : result === 'player' ? ['victory','defeat'] : ['defeat','victory']);
    assert.deepEqual(first.map(f => f.normalizedTime), [0,0]); assert.deepEqual(last.map(f => f.normalizedTime), result === 'draw' ? [0,0] : [1,1]);
    assert.deepEqual(half.map(f=>f.resultProgress),[.5,.5]); assert.ok(first.every(f=>f.outcome!==null));
    assert.deepEqual(t.sample(state, state.nowMs, 450), half); assert.equal(state.nowMs, 60000);
  }
});

// Actual imported glTF/bin FK, counter-recovery0 / idle0, both roots positive scale.
// Source identity is checked against manifests; geometry additionally has independent length constraints.
const rig = {
  manager: { a: .4600002, b: .4399999, shoulder: [-.4617916,1.505,.2380404], cheek: [.3142368,1.8808716,.0796795], arm: 1, height: 1 },
  veteran: { a: .4508001, b: .4312003, shoulder: [-.4220492,1.5071848,.2153441], cheek: [.3013447,1.8791122,.1073269], arm: .98, height: 1 },
  rookie: { a: .4927522, b: .4713282, shoulder: [-.4117178,1.5582249,.2408116], cheek: [.2934130,1.9410441,.1243366], arm: 1.03, height: 1.04 },
};
const guardShoulders = { manager:[-.2359644,1.47,-.1464372], veteran:[-.2661378,1.4689625,-.1174429], rookie:[-.2611350,1.5279314,-.1032784] };
const capturedSourceHashes = {
  // Revision2 changes only narration. Full converted glTF/bin and PNG are byte-identical to the FK capture.
  manager: 'b15f0eb6c5e925308dbaf3c3e2385cb17823adaadcfae367691a55a0d1887b8e',
  veteran: 'a45a72b8037f85fd3008ef692c2acbd3dd9067354136e9ab6e1ce12bb2275359',
  rookie: 'a4eab106bfec150cc87c92666241b98467505a3de1246d72bc76ee69d32fea1b',
};
const distance = (a,b) => Math.hypot(...a.map((v,i) => v-b[i]));
function humanGeometryFixture() {
  const fs = require('node:fs'), path = require('node:path');
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/human-manager-geometry.json'), 'utf8'));
}
function humanManifest() {
  return JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,
    '../game/assets/resources/office-cast/manager/manifest.json'), 'utf8'));
}
function validateHumanGeometryFixture(fixture, manifest) {
  assert.equal(fixture.schemaVersion, 1); assert.equal(fixture.roleId, 'manager');
  assert.equal(fixture.rigSpecVersion, 'office-humanoid-29-v2');
  assert.equal(manifest.source.rigSpecVersion, fixture.rigSpecVersion);
  assert.equal(fixture.sourceHash, manifest.generated.sourceHash);
  const provenance = fixture.provenance;
  assert.equal(provenance.buildId, 'P1-259c994-5d0653db-20261108T044836602Z');
  assert.equal(provenance.input, 'browser-native');
  assert.equal(provenance.captureSha256, 'c4ba7540a719fda7d548a6d0a10285e51861dcc5bfa9b1d3b6e28d8eaecebe83');
  for (const key of ['modelSha256', 'convertedBinSha256', 'importedSkeletonSha256']) assert.match(provenance[key], /^[a-f0-9]{64}$/);
  assert.equal(provenance.modelSha256, manifest.generated.outputs['character.fbx'].sha256);
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,
    '../game/assets/resources/office-cast/manager/character.fbx'))).digest('hex'), provenance.modelSha256);
  assert.equal(provenance.animationFps, 60);
  for (const duration of [provenance.animationDuration, provenance.rawDuration]) assert(Math.abs(duration - 15.1) <= 1 / 60 + .0001);
  assert.deepEqual(fixture.samples.map(s => s.sourceSampleIndex), [0, 36, 39]);
  assert.deepEqual(fixture.samples[0].phases, ['idle', 'idle']);
  assert.deepEqual(fixture.samples.map(s => s.ruleNowMs), [185, 1691, 1872]);
  const vector = value => assert(Array.isArray(value) && value.length === 3 && value.every(Number.isFinite));
  for (const sample of fixture.samples) {
    assert.deepEqual(sample.actors.map(actor => actor.station), [0, 1]);
    for (const actor of sample.actors) {
      assert.equal(actor.actorId, actor.station, 'This native left-side capture keeps the original actor-to-station mapping');
      assert.equal(actor.roleId, fixture.roleId); assert.equal(actor.sourceHash, fixture.sourceHash);
      assert.equal(actor.rigSpecVersion, fixture.rigSpecVersion);
      assert.equal(actor.prefabUuid, manifest.generated.imports.prefabUuid);
      assert.equal(actor.skeletonUuid, manifest.generated.imports.skeletonUuid);
      assert.equal(actor.joints, 29); assert.equal(actor.skinnedRenderers, 1); assert.equal(actor.useBakedAnimation, false);
      assert.equal(actor.staging.motionScale, .67);
      assert(actor.station === 0 ? actor.staging.baseX < 0 : actor.staging.baseX > 0);
      assert.deepEqual(actor.geometry.map(arm => arm.side), ['L', 'R']);
      for (const arm of actor.geometry) {
        for (const key of ['shoulder', 'elbow', 'wrist']) vector(arm[key]);
        assert(Math.abs(distance(arm.shoulder, arm.elbow) - arm.upperLength) < 1e-6);
        assert(Math.abs(distance(arm.elbow, arm.wrist) - arm.foreLength) < 1e-6);
        const upper = manifest.generated.mesh.restJoints[`UpperArm.${arm.side}`];
        const fore = manifest.generated.mesh.restJoints[`Forearm.${arm.side}`];
        assert(Math.abs(distance(upper.head, upper.tail) - arm.upperLength) < 1e-6, 'Actual engine upper-arm length must match independently exported rest geometry');
        assert(Math.abs(distance(fore.head, fore.tail) - arm.foreLength) < 1e-6, 'Actual engine forearm length must match independently exported rest geometry');
      }
      for (const key of ['leadPalm', 'rearPalm', 'cheek', 'root']) vector(actor.actual[key]);
    }
  }
  const parry = fixture.events.find(event => event.kind === 'parry'), counter = fixture.events.find(event => event.kind === 'counter-hit');
  assert.equal(parry.damage, 0); assert.equal(counter.damage, 1); assert.equal(counter.atMs - parry.atMs, 180);
}
test('geometry fixture retains actual source provenance and independently matches imported bone proportions', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const [role, data] of Object.entries(rig)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,'../game/assets/resources/office-cast',role,'manifest.json'),'utf8'));
    if (manifest.source.rigSpecVersion === 'office-humanoid-29-v2') {
      assert.equal(role, 'manager');
      validateHumanGeometryFixture(humanGeometryFixture(), manifest);
      continue;
    }
    assert.equal(manifest.generated.sourceHash,capturedSourceHashes[role]);
    assert.ok(Math.abs(data.a-.46*manifest.source.proportions.arm*manifest.source.proportions.height)<1e-6);
    assert.ok(Math.abs(data.b-.44*manifest.source.proportions.arm*manifest.source.proportions.height)<1e-6);
    assert.notEqual(manifest.source.guardHand,manifest.source.counterHand);
    assert.ok(manifest.generated.imports.bonePaths['UpperArm.L'] && manifest.generated.imports.bonePaths['Hand.R']);
  }
});
test('frozen v1 nine ordered role pairs x2 stations keep fixed bones and reach the opposite cheek', () => {
  for (const [role,a] of Object.entries(rig)) for (const [target,b] of Object.entries(rig)) for (const side of [0,1]) {
    const sign = side === 0 ? 1 : -1;
    const shoulder = a.shoulder.map((v,i) => i === 0 ? v*sign : v), palm = b.cheek.map((v,i) => i === 0 ? v*sign : v);
    const solved = solveTwoBone(shoulder, a.a, a.b, palm, .095);
    assert.equal(solved.reachable, true, `${role}->${target} side${side}`);
    assert.ok(Math.abs(distance(shoulder,solved.elbow)-a.a) < 1e-6);
    assert.ok(Math.abs(distance(solved.elbow,solved.wrist)-a.b) < 1e-6);
    assert.ok(distance([solved.wrist[0],solved.wrist[1]+.095,solved.wrist[2]],palm)<1e-6);
    assert.ok(solved.requestedDistance < a.a+a.b && solved.requestedDistance > Math.abs(a.a-a.b));
    assert.ok([...solved.elbow,...solved.wrist,solved.error].every(Number.isFinite));
  }
});
test('two-bone solver reports unreachable targets and rejects invalid geometry', () => {
  const s = solveTwoBone([0,0,0],.46,.44,[3,2,0],.095);
  assert.equal(s.reachable,false); assert.ok(s.error>1); assert.ok(s.solvedDistance<.9);
  const zero = solveTwoBone([0,0,0],.46,.44,[0,.095,0],.095);
  assert.equal(zero.reachable,false); assert.ok([...zero.elbow,...zero.wrist].every(Number.isFinite));
  assert.throws(()=>solveTwoBone([NaN,0,0],.46,.44,[0,1,0],.095),/finite/);
});

test('optional human forward elbow pole preserves the old default and both rigid segment lengths', () => {
  const shoulder = freeze([0, 0, 0]), palm = freeze([.7, .095, 0]);
  const oldPole = freeze([0, -1, -.15]), humanPole = freeze([0, -.5, 1]);
  const original = solveTwoBone(shoulder, .46, .44, palm, .095);
  assert.deepEqual(original, solveTwoBone(shoulder, .46, .44, palm, .095, oldPole));
  const human = solveTwoBone(shoulder, .46, .44, palm, .095, humanPole);
  assert(original.elbow[2] < 0 && human.elbow[2] > 0, 'Human pole bends in front of the torso instead of retaining the old backward elbow');
  assert.deepEqual(human.wrist, original.wrist); assert.equal(human.reachable, true);
  for (const solved of [original, human]) {
    assert(Math.abs(distance(shoulder, solved.elbow) - .46) < 1e-10);
    assert(Math.abs(distance(solved.elbow, solved.wrist) - .44) < 1e-10);
    assert(distance([solved.wrist[0], solved.wrist[1] + .095, solved.wrist[2]], palm) < 1e-10);
  }
  assert.throws(() => solveTwoBone(shoulder, .46, .44, palm, .095, [0, NaN, 1]), /finite/);
});

test('actual 60 FPS human fixture rejects old-source or altered geometric provenance', () => {
  const fixture = humanGeometryFixture(), manifest = humanManifest();
  assert.doesNotThrow(() => validateHumanGeometryFixture(fixture, manifest));
  for (const change of [
    f => f.sourceHash = capturedSourceHashes.manager,
    f => f.sourceHash = 'c7cfc072f9b9aa57f17763d6db40f2a867491840f9f696751707d3725c47f16f',
    f => f.provenance.buildId = 'P1-259c994-83e0bdfd-20261108T000000000Z',
    f => f.provenance.captureSha256 = '0'.repeat(64),
    f => f.provenance.modelSha256 = '0'.repeat(64),
    f => f.provenance.modelSha256 = 'bb4604e8e7e1dc8435b7bad0f24ef5177cb7a710f2c7783cd4e71b6bae00e6ff',
    f => f.provenance.animationDuration = 37.75,
    f => f.samples[0].actors[1].sourceHash = capturedSourceHashes.manager,
    f => f.samples[0].actors[0].geometry[0].upperLength += .01,
    f => f.samples[0].actors[0].geometry[0].shoulder[0] = NaN,
  ]) {
    const altered = structuredClone(fixture); change(altered);
    assert.throws(() => validateHumanGeometryFixture(altered, manifest));
  }
});

test('human solver reproduces the independently captured Cocos wrist and forward elbow geometry', () => {
  const fixture = humanGeometryFixture(); validateHumanGeometryFixture(fixture, humanManifest());
  let solutions = 0;
  for (const sample of fixture.samples.slice(1)) for (const actor of sample.actors) {
    for (const [hand, captured] of Object.entries(actor.contacts)) {
      const side = (hand === 'lead') === (actor.station === 0) ? 'L' : 'R';
      const arm = actor.geometry.find(a => a.side === side);
      const offset = distance(arm.wrist, actor.actual[`${hand}Palm`]);
      assert(Math.abs(offset - .1) < 1e-6, 'Source palm socket must be measured through the actual imported transform');
      const target = [captured.wrist[0], captured.wrist[1] + offset, captured.wrist[2]];
      const solved = solveTwoBone(arm.shoulder, arm.upperLength, arm.foreLength, target, offset, [0, -.5, 1]);
      assert.equal(solved.reachable, true);
      assert(distance(solved.elbow, captured.elbow) < 1e-6);
      assert(distance(solved.wrist, arm.wrist) < 1e-6);
      assert(captured.actualError < 1e-6);
      solutions++;
    }
  }
  assert.equal(solutions, 6, 'This capture contains six actual corrected hand solutions; it is not full visual or station acceptance');
});

test('staging anchors scale hand placement to the human face and preserve the legacy actor alongside it', () => {
  const state = new Battle('staging', 'charge').snapshot();
  state.nowMs = 600;
  state.fighters = state.fighters.map(f => ({ ...f, phase: 'charging', phaseStartMs: 0 }));
  const legacy = [0, 1].map(i => ({ root: [i === 0 ? -.55 : .55, 0, 0], cheek: [i === 0 ? -.3 : .3, 1.88, .1],
    leadPalm: [i === 0 ? -.2 : .2, 1.4, .1], rearPalm: [i === 0 ? -.8 : .8, 1.1, .1] }));
  const old = characterContacts(state, legacy);
  const mixed = structuredClone(legacy);
  mixed[0] = { root: [-.31, 0, 0], cheek: [-.1425, 1.3, .067], leadPalm: [-.0755, .9784, .067], rearPalm: [-.4775, .7774, .067],
    staging: { baseX: -.31, motionScale: .67 } };
  freeze(mixed); freeze(state);
  const adjusted = characterContacts(state, mixed);
  assert.deepEqual(adjusted[1], old[1], 'The source-v1 actor retains its existing hand semantics');
  const transform = p => [-.31 + (p[0] + .55) * .67, 1.3 + (p[1] - 1.88) * .67, p[2] * .67];
  for (const hand of ['lead', 'rear']) assert(distance(adjusted[0][hand], transform(old[0][hand])) < 1e-10);
  assert(adjusted[0].lead[1] < mixed[0].cheek[1], 'Charged human hand is below its actual face instead of the legacy height');
  assert.deepEqual(characterContacts(state, mixed), adjusted, 'Repeated read-only sampling cannot drift anchors or staging');
});

test('staging baseX parks recovery consistently while the hit still reaches the opposing actual cheek', () => {
  for (const actor of [0, 1]) {
    const state = new Battle('stage-contact', 'tap').snapshot();
    const anchors = [0, 1].map(i => ({ root: [i === 0 ? -.12 : .12, 0, 0], cheek: [i === 0 ? -.1 : .1, 1.3, .067],
      leadPalm: [0, 1.1, .067], rearPalm: [0, .9, .067], staging: { baseX: i === 0 ? -.31 : .31, motionScale: .67 } }));
    state.fighters[actor] = { ...state.fighters[actor], phase: 'windup', phaseStartMs: 0 };
    state.nowMs = 480;
    assert.deepEqual(characterContacts(state, anchors)[actor].lead, anchors[1 - actor].cheek);
    state.fighters[actor] = { ...state.fighters[actor], phase: 'recovery', phaseStartMs: 480 };
    state.nowMs = 480 + DEFAULT_RULES.recoveryMs;
    const parked = characterContacts(state, anchors)[actor].lead;
    const driftedRoot = structuredClone(anchors); driftedRoot[actor].root[0] += .17;
    assert.deepEqual(characterContacts(state, driftedRoot)[actor].lead, parked, 'Recovery rests at the declared base instead of accumulating root lunge');
    assert(parked[1] < anchors[actor].cheek[1]);
  }
  const state = new Battle('bad-staging', 'tap').snapshot();
  const anchors = [0, 1].map(i => ({ root: [0, 0, 0], cheek: [i === 0 ? -.1 : .1, 1.3, .1], leadPalm: [0, 1.1, .1], rearPalm: [0, 1, .1] }));
  for (const staging of [{ baseX: Infinity }, { baseX: 0, motionScale: 0 }, { baseX: 0, motionScale: -1 },
    { baseX: 0, motionScale: NaN }, { baseX: 0, motionScale: 2.01 }]) {
    const bad = structuredClone(anchors); bad[0].staging = staging;
    assert.throws(() => characterContacts(state, bad), /staging/);
  }
});

test('presentation stations mirror positions while native player and Bot remain logical actors zero and one', () => {
  assert.deepEqual([presentationSide(0), presentationSide(1)], [0, 1]);
  assert.deepEqual([presentationSide(0, 1), presentationSide(1, 1)], [1, 0]);
  for (const invalid of [-1, 2, NaN, null, true, '1']) {
    assert.throws(() => presentationSide(invalid, 0), /presentation side/);
    assert.throws(() => presentationSide(0, invalid), /presentation side/);
  }
  const { t, frames } = counterFrames(0);
  const events = frames.flatMap(frame => frame.events);
  assert.deepEqual(events.filter(e => ['parry', 'counter-hit'].includes(e.kind)).map(e => [e.kind, e.actorId, e.targetId]),
    [['parry', 0, 1], ['counter-hit', 0, 1]]);
  const mirror = point => [-point[0], point[1], point[2]];
  for (const { state } of frames) {
    const before = JSON.stringify(state);
    const left = t.sample(state, state.nowMs, 0, 0), right = t.sample(state, state.nowMs, 0, 1);
    assert.deepEqual(left.map(s => [s.semanticClip, s.normalizedTime, s.lunge]), right.map(s => [s.semanticClip, s.normalizedTime, s.lunge]));
    for (const actorId of [0, 1]) {
      assert(distance(right[actorId].pose.body, mirror(left[actorId].pose.body)) < 1e-10);
      assert(distance(right[actorId].pose.head, mirror(left[actorId].pose.head)) < 1e-10);
      assert(Math.abs(right[actorId].pose.bodyYaw + left[actorId].pose.bodyYaw) < 1e-10);
      assert(Math.abs(right[actorId].pose.headRoll + left[actorId].pose.headRoll) < 1e-10);
      for (const hand of ['lead', 'rear']) assert(distance(right[actorId].pose.arms[hand].palm, mirror(left[actorId].pose.arms[hand].palm)) < 1e-10);
    }
    assert.equal(JSON.stringify(state), before, 'Presentation cannot reorder fighters or rewrite the native command owner');
  }
});

test('actor-zero right-side parry mirrors hand targets and still counters logical actor one', () => {
  const { frames } = counterFrames(0);
  const left = [0, 1].map(actorId => ({ root: [actorId === 0 ? -.38 : .38, 0, 0], cheek: [actorId === 0 ? -.18 : .18, 2.03, .01],
    leadPalm: [actorId === 0 ? -.02 : .02, 1.38, -.24], rearPalm: [actorId === 0 ? -.56 : .56, 1.38, .4],
    staging: { baseX: actorId === 0 ? -.38 : .38, motionScale: .67, side: actorId } }));
  const mirror = point => [-point[0], point[1], point[2]];
  const right = left.map(anchor => ({ root: mirror(anchor.root), cheek: mirror(anchor.cheek), leadPalm: mirror(anchor.leadPalm), rearPalm: mirror(anchor.rearPalm),
    staging: { ...anchor.staging, baseX: -anchor.staging.baseX, side: 1 - anchor.staging.side } }));
  for (const frame of frames) {
    const original = characterContacts(frame.state, left), mirrored = characterContacts(frame.state, right);
    for (const actorId of [0, 1]) for (const hand of ['lead', 'rear']) {
      if (original[actorId][hand] === null) assert.equal(mirrored[actorId][hand], null);
      else assert(distance(mirrored[actorId][hand], mirror(original[actorId][hand])) < 1e-10);
    }
  }
  const caught = characterContacts(frames[2].state, right), hit = characterContacts(frames[4].state, right);
  assert.deepEqual(caught[0].lead, caught[1].lead, 'The right-side player catches the Bot hand');
  assert.deepEqual(hit[0].rear, right[1].cheek, 'Logical player zero reaches logical opponent one after the same 180 ms');
  assert.equal(frames[4].state.fighters[0].hp, 5); assert.equal(frames[4].state.fighters[1].hp, 4);
  for (const badSide of [-1, 2, NaN, null, true, '1']) {
    const bad = structuredClone(right); bad[0].staging.side = badSide;
    assert.throws(() => characterContacts(frames[2].state, bad), /staging/);
  }
});

test('omitting staging side preserves the old actor-index hand targets', () => {
  const { frames } = counterFrames();
  const anchors = [0, 1].map(i => ({ root: [i === 0 ? -.55 : .55, 0, 0], cheek: [i === 0 ? -.3 : .3, 1.88, .1],
    leadPalm: [0, 1.4, .1], rearPalm: [0, 1.1, .1] }));
  const explicit = anchors.map((a, side) => ({ ...a, staging: { side, baseX: side === 0 ? -.55 : .55 } }));
  for (const frame of frames) assert.deepEqual(characterContacts(frame.state, anchors), characterContacts(frame.state, explicit));
});

test('right-side query assignment is statically gated by the explicit motion diagnostic flag', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../game/assets/scripts/SlapGame.ts'), 'utf8');
  const guarded = /if\s*\(\s*query\.get\(['"]diagnosticMotion['"]\)\s*===\s*['"]1['"]\s*&&\s*query\.get\(['"]diagnosticStation['"]\)\s*===\s*['"]1['"]\s*\)\s*this\.playerStation\s*=\s*1\s*;/g;
  const assignments = source.match(guarded);
  assert.equal(assignments?.length, 1, 'Exactly one explicit two-flag browser diagnostic gate enables the mirror');
  assert(!/this\.playerStation\s*=\s*1\b/.test(source.replace(guarded, '')), 'No unguarded assignment can enable the mirror');
  assert.match(source, /session\.submit\(\{[^}]*actorId:\s*0[,}]/, 'Native player input retains logical actor zero');
});
test('frozen v1 guard and incoming parried palm remain reachable for nine x two imported shapes', () => {
  for (const [role,a] of Object.entries(rig)) for (const [target,b] of Object.entries(rig)) for (const side of [0,1]) {
    const sign=side===0?1:-1, mirror=p=>p.map((v,i)=>i===0?v*sign:v);
    const shoulder=mirror(guardShoulders[role]);
    const ownCheek=mirror(a.cheek.map((v,i)=>i===0?-v:v));
    const ownGuard=[ownCheek[0]+sign*.10,ownCheek[1]-.025,ownCheek[2]+.07];
    assert.equal(solveTwoBone(shoulder,a.a,a.b,ownGuard,.095).reachable,true);
    const otherShoulder=mirror(guardShoulders[target].map((v,i)=>i===0?-v:v));
    assert.equal(solveTwoBone(otherShoulder,b.a,b.b,ownGuard,.095).reachable,true,`${target} incoming to${role} guard side${side}`);
  }
});
test('non-striking hand stays explicitly parked and charge uses the same lead hand at both stations', () => {
  const state=new Battle('hands','charge').snapshot(), anchors=[0,1].map(i=>({root:[i===0?-.55:.55,0,0],cheek:[i===0?-.3:.3,1.88,.1],leadPalm:[0,1.4,.1],rearPalm:[0,1.1,.1]}));
  for(const phase of ['charging','windup','recovery','guard','parried']) {
    state.fighters=state.fighters.map(f=>({...f,phase})); const targets=characterContacts(state,anchors);
    assert.ok(targets.every(t=>t.lead&&t.rear)); assert.ok(targets[0].rear[0]<-.55&&targets[1].rear[0]>.55);
  }
});
test('frozen v1 role pairs and both stations catch one palm, then use the other at0/179/180/440 boundaries', () => {
  for (const a of Object.values(rig)) for (const b of Object.values(rig)) for (const defender of [0,1]) {
    const { frames } = counterFrames(defender);
    const actors = defender===0?[a,b]:[b,a];
    const anchors = actors.map((r,i)=>({root:[i===0?-.55:.55,0,0],cheek:r.cheek.map((v,k)=>k===0&&i===0?-v:v),leadPalm:[0,1.4,.1],rearPalm:[0,1.1,.1]}));
    const caught = characterContacts(frames[2].state,anchors);
    assert.deepEqual(caught[defender].lead,caught[1-defender].lead);
    const before=characterContacts(frames[3].state,anchors), contact=characterContacts(frames[4].state,anchors);
    assert.ok(distance(before[defender].rear,anchors[1-defender].cheek)>0);
    assert.deepEqual(contact[defender].rear,anchors[1-defender].cheek);
    assert.deepEqual(characterContacts(frames[4].state,anchors),contact,'paused same time has no contact drift');
    assert.deepEqual(characterContacts(frames[6].state,anchors),[{lead:null,rear:null},{lead:null,rear:null}]);
  }
});
test('same batch can retain two independent damage-qualified attacks without changing rules', () => {
  const state=new Battle('both','tap').snapshot(); state.nowMs=100;
  state.fighters=state.fighters.map(f=>({...f,phase:'windup',phaseStartMs:100}));
  const events=[0,1].map(i=>({id:'attack'+i,sessionId:'both',atMs:100,kind:'attack-start',actorId:i,damage:i===0?2:1}));
  const t=new CharacterTimeline(); t.consume(state,[...events].reverse());
  assert.deepEqual(t.sample(state).map(s=>s.semanticClip),['attack-heavy','attack-light']);
  t.consume(state,events); assert.deepEqual(t.sample(state).map(s=>s.semanticClip),['attack-heavy','attack-light']);
});
test('first48ms of counter recovery retain a drawable real-palm contact without extending260ms recovery', () => {
  for(const side of [0,1]) {
    const {t,frames}=counterFrames(side), hit=frames[4].state;
    const anchors=[0,1].map(i=>({root:[i===0?-.21:.21,0,0],cheek:[i===0?-.3:.3,1.88,.1],leadPalm:[0,1.4,.1],rearPalm:[0,1.1,.1]}));
    for(const age of [0,14,29,48]) {
      const state={...hit,nowMs:660+age};
      assert.equal(t.sample(state)[side].normalizedTime,0);
      assert.equal(t.sample(state)[side].lunge,.34);
      assert.deepEqual(characterContacts(state,anchors)[side].rear,anchors[1-side].cheek);
    }
    const end={...hit,nowMs:920}; assert.equal(t.sample(end)[side].normalizedTime,1); assert.equal(t.sample(end)[side].lunge,0);
    assert.equal(DEFAULT_RULES.counterWindupMs,180); assert.equal(DEFAULT_RULES.counterRecoveryMs,260);
  }
});
test('counter-hit arriving before parry across batches cannot keep an expired chain at440ms', () => {
  for(const defender of [0,1]) {
    const {frames}=counterFrames(defender), state=frames.at(-1).state, events=frames.flatMap(f=>f.events);
    const ordered=new CharacterTimeline(), lateParry=new CharacterTimeline();
    ordered.consume(state,events);
    lateParry.consume(state,events.filter(e=>e.kind!=='parry'));
    lateParry.consume(state,events.filter(e=>e.kind==='parry'));
    assert.deepEqual(lateParry.sample(state),ordered.sample(state));
    assert.deepEqual(lateParry.sample(state),new CharacterTimeline().sample(state),'440ms is the completed-chain boundary');
  }
});
