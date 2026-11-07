const test = require('node:test');
const assert = require('node:assert/strict');
const { CharacterTimeline, solveTwoBone, characterContacts } = require('../.test-build/CharacterTimeline.js');
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
  manager: 'ff49ef76912e0a3c4f807fc96aecf2ac1fe0389344e7a46b922cf3b2f7689b5c',
  veteran: 'a45a72b8037f85fd3008ef692c2acbd3dd9067354136e9ab6e1ce12bb2275359',
  rookie: 'a4eab106bfec150cc87c92666241b98467505a3de1246d72bc76ee69d32fea1b',
};
const distance = (a,b) => Math.hypot(...a.map((v,i) => v-b[i]));
test('geometry fixture retains actual source provenance and independently matches imported bone proportions', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const [role, data] of Object.entries(rig)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,'../game/assets/resources/office-cast',role,'manifest.json'),'utf8'));
    assert.equal(manifest.generated.sourceHash,capturedSourceHashes[role]);
    assert.ok(Math.abs(data.a-.46*manifest.source.proportions.arm*manifest.source.proportions.height)<1e-6);
    assert.ok(Math.abs(data.b-.44*manifest.source.proportions.arm*manifest.source.proportions.height)<1e-6);
    assert.notEqual(manifest.source.guardHand,manifest.source.counterHand);
    assert.ok(manifest.generated.imports.bonePaths['UpperArm.L'] && manifest.generated.imports.bonePaths['Hand.R']);
  }
});
test('actual imported9 ordered role pairs x2 stations keep fixed bones and reach the opposite cheek', () => {
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
test('actual guard and incoming parried palm remain reachable for9x2 imported shapes', () => {
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
test('all role pairs and both stations catch one palm, then use the other at0/179/180/440 boundaries', () => {
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
