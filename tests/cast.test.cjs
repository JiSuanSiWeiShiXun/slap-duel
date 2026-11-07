'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ROLE_IDS, castResource, createCastCatalog, makeRoundSetup, projectIntro, RoundGate } = require('../.test-build/Cast.js');
const { LocalSession } = require('../.test-build/session/LocalSession.js');
const raw = () => ['manager', 'veteran', 'rookie'].map(role => JSON.parse(fs.readFileSync(`game/assets/resources/office-cast/${role}/manifest.json`, 'utf8')));
const catalog = () => createCastCatalog(raw());
const selection = (playerRoleId = 'manager', opponentRoleId = 'veteran', mode = 'tap') => ({ playerRoleId, opponentRoleId, mode });

test('cast uses exactly three fixed resource mappings and rejects arbitrary paths', () => {
  assert.deepEqual(ROLE_IDS, ['manager', 'veteran', 'rookie']);
  for (const role of ROLE_IDS) {
    assert.deepEqual(castResource(role), {
      manifestPath: `office-cast/${role}/manifest`,
      modelPath: `office-cast/${role}/character`,
      portraitPath: `office-cast/${role}/portrait`,
    });
    assert.ok(Object.isFrozen(castResource(role)));
  }
  for (const bad of ['../manager', 'https://example.test/manager', '__proto__', 'constructor', '', 0, null]) {
    assert.throws(() => castResource(bad), /role/i);
    assert.throws(() => makeRoundSetup(catalog(), selection(bad)), /role/i);
    assert.throws(() => makeRoundSetup(catalog(), selection('manager', bad)), /role/i);
  }
});

test('catalog copies validated runtime fields from each actual manifest and keeps both facets', () => {
  const source = raw(), cast = createCastCatalog(source);
  assert.deepEqual(Object.keys(cast), [...ROLE_IDS]);
  for (const manifest of source) {
    const entry = cast[manifest.source.roleId];
    assert.equal(entry.assetRevision, manifest.source.assetRevision);
    assert.equal(entry.displayName, manifest.source.displayName);
    assert.deepEqual(entry.facets, manifest.source.facets);
    assert.equal(entry.sourceHash, manifest.generated.sourceHash);
    assert.equal(entry.prefabUuid, manifest.generated.imports.prefabUuid);
    assert.equal(entry.portraitTextureUuid, manifest.generated.imports.portraitTextureUuid);
    assert.equal(entry.modelPath, castResource(entry.roleId).modelPath);
    assert.equal(entry.portraitPath, castResource(entry.roleId).portraitPath);
    assert.equal('appearance' in entry, false);
  }
  source[0].source.facets.positive = 'mutated source';
  source[0].source.assetRevision = 999;
  assert.notEqual(cast.manager.facets.positive, 'mutated source');
  assert.notEqual(cast.manager.assetRevision, 999);
  assert.ok(Object.isFrozen(cast));
  assert.ok(Object.isFrozen(cast.manager));
  assert.ok(Object.isFrozen(cast.manager.facets));
});

test('catalog rejects missing, duplicate, unknown or malformed role manifests', () => {
  assert.throws(() => createCastCatalog(raw().slice(0, 2)), /catalog|three|missing/i);
  assert.throws(() => createCastCatalog([...raw(), raw()[0]]), /catalog|three|duplicate/i);
  const duplicate = raw(); duplicate[2] = duplicate[0];
  assert.throws(() => createCastCatalog(duplicate), /duplicate|missing/i);
  for (const mutate of [
    m => { m.source.roleId = '../manager'; },
    m => { m.schemaVersion = 999; },
    m => { m.source.assetRevision = 0; },
    m => { m.source.assetRevision = 1.5; },
    m => { m.source.displayName = ' '; },
    m => { delete m.source.facets.positive; },
    m => { m.source.facets.negative = ''; },
    m => { m.generated.sourceHash = 'invalid'; },
    m => { m.generated.imports.prefabUuid = 'https://example.test/prefab'; },
    m => { delete m.generated.imports.portraitTextureUuid; },
  ]) {
    const source = raw(); mutate(source[0]);
    assert.throws(() => createCastCatalog(source), /role|manifest|revision|facet|name|hash|uuid/i);
  }
});

for (const playerRole of ['manager', 'veteran', 'rookie']) {
  for (const opponentRole of ['manager', 'veteran', 'rookie']) {
    test(`viewer projection preserves identities for ${playerRole}/${opponentRole}`, () => {
      const cast = catalog(), setup = makeRoundSetup(cast, selection(playerRole, opponentRole));
      assert.equal(setup.mode, 'tap');
      assert.deepEqual(setup.actors.map(actor => actor.actorId), [0, 1]);
      assert.deepEqual(setup.actors.map(actor => actor.roleId), [playerRole, opponentRole]);
      for (const viewer of [0, 1]) {
        const intro = projectIntro(setup, viewer);
        assert.ok(Object.isFrozen(intro));
        assert.equal(intro.length, 2);
        for (const [actorId, card] of intro.entries()) {
          const actor = setup.actors[actorId], own = actorId === viewer;
          assert.equal(card.actorId, actorId);
          assert.equal(card.roleId, actor.roleId);
          assert.equal(card.assetRevision, actor.assetRevision);
          assert.equal(card.facet, own ? 'positive' : 'negative');
          assert.equal(card.text, actor.facets[card.facet]);
          assert.equal(card.label, own ? '你眼中的自己' : '这位对手的职场往事');
          assert.equal(card.modelPath, actor.modelPath);
          assert.equal(card.portraitPath, actor.portraitPath);
          assert.equal(card.prefabUuid, actor.prefabUuid);
          assert.equal(card.portraitTextureUuid, actor.portraitTextureUuid);
          assert.equal('facets' in card, false);
          assert.ok(Object.isFrozen(card));
        }
        assert.equal(intro[viewer].facet, 'positive');
        assert.equal(intro[1 - viewer].facet, 'negative');
      }
      assert.deepEqual(setup.actors[0].facets, cast[playerRole].facets);
      assert.deepEqual(setup.actors[1].facets, cast[opponentRole].facets);
    });
  }
}

test('setup deeply locks role revision and mode independently of selection or future catalog', () => {
  const source = raw(), cast = createCastCatalog(source), selected = selection('rookie', 'rookie', 'charge');
  const setup = makeRoundSetup(cast, selected), before = JSON.stringify(setup);
  selected.playerRoleId = 'veteran'; selected.mode = 'tap';
  source[2].source.assetRevision++;
  const laterCast = createCastCatalog(source), later = makeRoundSetup(laterCast, selected);
  assert.equal(setup.actors[0].roleId, 'rookie');
  assert.equal(setup.mode, 'charge');
  assert.equal(later.actors[0].roleId, 'veteran');
  assert.notEqual(setup.actors[1].assetRevision, later.actors[1].assetRevision);
  assert.equal(JSON.stringify(setup), before);
  for (const action of [
    () => { setup.mode = 'tap'; },
    () => { setup.actors[0].roleId = 'manager'; },
    () => { setup.actors[0].assetRevision = 999; },
    () => { setup.actors[0].facets.negative = 'changed'; },
    () => { setup.actors.reverse(); },
  ]) assert.throws(action, TypeError);
  assert.ok(Object.isFrozen(setup));
  assert.ok(Object.isFrozen(setup.actors));
  assert.ok(Object.isFrozen(setup.actors[0]));
  assert.notEqual(setup.actors[0], setup.actors[1]);
});

test('invalid viewer and unsupported attack mode fail without silently changing control identity', () => {
  const cast = catalog(), setup = makeRoundSetup(cast, selection());
  for (const viewer of [-1, 2, '0', null, NaN, undefined]) assert.throws(() => projectIntro(setup, viewer), /viewer/i);
  for (const mode of ['', 'skill', null, 1]) assert.throws(() => makeRoundSetup(cast, selection('manager', 'rookie', mode)), /mode/i);
  const before = JSON.stringify(setup);
  projectIntro(setup, 1);
  assert.equal(JSON.stringify(setup), before);
  assert.equal(setup.actors[0].actorId, 0);
});

test('round gate locks one start until clear and rejects copied or cancelled generation tickets', () => {
  const gate = new RoundGate(), cast = catalog();
  const setup = makeRoundSetup(cast, selection()), another = makeRoundSetup(cast, selection('rookie', 'rookie'));
  assert.equal(gate.retry(), null);
  const first = gate.start(setup);
  assert.ok(first);
  assert.ok(Object.isFrozen(first));
  assert.equal(first.setup, setup);
  assert.equal(gate.isCurrent(first), true);
  assert.equal(gate.isCurrent({ ...first }), false);
  assert.equal(gate.start(setup), null);
  assert.equal(gate.start(another), null);
  gate.clear();
  assert.equal(gate.isCurrent(first), false);
  const next = gate.start(another);
  assert.ok(next.generation > first.generation);
  assert.equal(next.setup, another);
  assert.equal(gate.isCurrent(next), true);
});

test('late loading success or failure cannot replace a newer selection or recover a cleared round', async () => {
  const gate = new RoundGate(), cast = catalog();
  const old = gate.start(makeRoundSetup(cast, selection('manager', 'veteran')));
  let finish, fail;
  const deferredSuccess = new Promise(resolve => { finish = resolve; });
  const deferredFailure = new Promise((resolve, reject) => { fail = reject; });
  const applied = [], errors = [];
  const success = deferredSuccess.then(value => { if (gate.isCurrent(old)) applied.push(value); });
  const failure = deferredFailure.catch(error => { if (gate.isCurrent(old)) errors.push(error); });
  gate.clear();
  const current = gate.start(makeRoundSetup(cast, selection('rookie', 'manager', 'charge')));
  finish('stale manager skin'); fail(new Error('stale resource failure'));
  await Promise.all([success, failure]);
  assert.deepEqual(applied, []); assert.deepEqual(errors, []);
  assert.equal(gate.isCurrent(current), true);
  assert.equal(current.setup.actors[0].roleId, 'rookie');
  gate.clear();
  assert.equal(gate.isCurrent(current), false);
});

test('retry retains both roles, revision and mode while replacing ticket and clearing session events', () => {
  const gate = new RoundGate(), setup = makeRoundSetup(catalog(), selection('rookie', 'manager', 'charge'));
  const first = gate.start(setup), old = new LocalSession({ sessionId: `cast-${first.generation}`, mode: setup.mode, practice: 'hit', seed: 42 });
  old.submit({ sessionId: `cast-${first.generation}`, actorId: 0, atMs: 0, sequence: 1, action: 'charge-start' });
  old.submit({ sessionId: `cast-${first.generation}`, actorId: 0, atMs: 1200, sequence: 2, action: 'charge-release' });
  old.advanceTo(1680);
  assert.equal(old.snapshot().fighters[1].hp, 3);
  const retry = gate.retry();
  assert.notEqual(retry, first);
  assert.ok(retry.generation > first.generation);
  assert.equal(retry.setup, first.setup);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(retry), true);
  assert.equal(gate.start(makeRoundSetup(catalog(), selection('veteran', 'rookie'))), null);
  const session = new LocalSession({ sessionId: `cast-${retry.generation}`, mode: retry.setup.mode, practice: 'hit', seed: 42 });
  session.submit({ sessionId: `cast-${first.generation}`, actorId: 0, atMs: 0, sequence: 1, action: 'charge-release' });
  session.advanceTo(2000);
  assert.deepEqual(session.snapshot().fighters.map(fighter => fighter.hp), [5, 5]);
  assert.deepEqual(session.drainEvents(), []);
  assert.equal(retry.setup.actors[0].roleId, 'rookie');
  assert.equal(retry.setup.actors[1].roleId, 'manager');
  assert.equal(retry.setup.mode, 'charge');
  assert.ok(Object.isFrozen(retry.setup.actors[0].facets));
  assert.equal(projectIntro(retry.setup, 1)[0].text, setup.actors[0].facets.negative);
});
