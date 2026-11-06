const test = require('node:test');
const assert = require('node:assert/strict');
const { latestContact, contactText } = require('../.test-build/Feedback.js');
const { Battle, DEFAULT_RULES } = require('../.test-build/core/Battle.js');
const event = (kind, actorId, atMs) => ({ id: `${kind}-${actorId}-${atMs}`, sessionId: 'feedback', kind, actorId, targetId: 1 - actorId, atMs });

test('block/parry feedback distinguishes the defender from the attacker', () => {
    assert.equal(contactText(event('block', 0, 480)), '格挡成功');
    assert.equal(contactText(event('block', 1, 480)), '被对手格挡');
    assert.equal(contactText(event('parry', 0, 480)), '精准反击');
    assert.equal(contactText(event('parry', 1, 480)), '被对手反击');
});

test('a later hit wins over an earlier parry in one low-frame-rate batch', () => {
    const early = event('parry', 0, 480), late = event('hit', 1, 2200);
    assert.equal(latestContact([early, late]), late);
    assert.equal(latestContact([late, early]), late);
    assert.equal(contactText(late), '没挡住');
});

test('parry priority is only for equal timestamps and ignores noncontact events', () => {
    const parry = event('parry', 0, 480), hit = event('hit', 1, 480);
    assert.equal(latestContact([parry, hit]), parry);
    assert.equal(latestContact([hit, parry]), parry);
    assert.equal(latestContact([event('rejected', 0, 600)]), undefined);
});

test('hit feedback consumes event damage for both actors without applying charge damage to defenses', () => {
    assert.equal(contactText({ ...event('hit', 0, 480), damage: 1 }), '命中 -1');
    assert.equal(contactText({ ...event('hit', 0, 1680), damage: 2 }), '重击命中 -2');
    assert.equal(contactText({ ...event('hit', 1, 1680), damage: 2 }), '没挡住 -2');
    assert.equal(contactText({ ...event('block', 0, 1680), damage: 0 }), '格挡成功');
    assert.equal(contactText({ ...event('parry', 0, 1680), damage: 1 }), '精准反击');
});

test('real charge contacts display the same damage used to reduce HP across the full-charge boundary', () => {
    for (const held of [DEFAULT_RULES.fullChargeMs - 1, DEFAULT_RULES.fullChargeMs]) {
        const battle = new Battle('feedback-charge', 'charge');
        const submit = (sequence, atMs, action) => battle.submit({ sessionId: 'feedback-charge', actorId: 0, sequence, atMs, action });
        submit(1, 0, 'charge-start');
        submit(2, held, 'charge-release');
        battle.advanceTo(held + DEFAULT_RULES.windupMs);
        const hit = latestContact(battle.drainEvents());
        const hpLost = DEFAULT_RULES.maxHp - battle.snapshot().fighters[1].hp;
        assert.equal(hit.damage, hpLost);
        assert.ok(contactText(hit).endsWith(`-${hpLost}`));
        assert.equal(contactText(hit).startsWith('重击'), held === DEFAULT_RULES.fullChargeMs);
    }
});
