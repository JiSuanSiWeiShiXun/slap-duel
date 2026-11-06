const test = require('node:test');
const assert = require('node:assert/strict');
const { InputBridge } = require('../.test-build/InputBridge.js');

function setup() {
    const actions = [];
    return { actions, input: new InputBridge(action => actions.push(action)) };
}

test('tap emits once despite duplicate start/end and a second pointer', () => {
    const { input, actions } = setup();
    input.downAttack(1, 'tap');
    input.downAttack(1, 'tap');
    input.downAttack(2, 'tap');
    input.up(2);
    input.up(1);
    input.up(1);
    assert.deepEqual(actions, ['attack']);
    input.downAttack(2, 'tap');
    assert.deepEqual(actions, ['attack', 'attack']);
});

test('global pointer release finishes charge even after moving outside button', () => {
    const { input, actions } = setup();
    input.downAttack(7, 'charge');
    input.up(99);
    assert.deepEqual(actions, ['charge-start']);
    // Position belongs to Cocos; bridge intentionally releases by captured ID.
    input.up(7);
    assert.deepEqual(actions, ['charge-start', 'charge-release']);
});

test('cancel never releases attack, and a late end is harmless', () => {
    const { input, actions } = setup();
    input.downAttack(4, 'charge');
    input.cancel(4);
    input.up(4);
    input.cancel(4);
    assert.deepEqual(actions, ['charge-start', 'charge-cancel']);
});

test('pause/reset clears every pointer and never replays a held command', () => {
    const { input, actions } = setup();
    input.downAttack(1, 'charge');
    input.downGuard(2);
    input.cancelAll();
    input.cancelAll();
    input.up(1);
    input.up(2);
    assert.deepEqual(actions, ['charge-start', 'guard', 'charge-cancel']);
    input.downAttack(1, 'tap');
    assert.equal(actions.at(-1), 'attack');
});

test('same pointer cannot own attack and guard; repeat guard start is ignored', () => {
    const { input, actions } = setup();
    input.downGuard(0);
    input.downGuard(0);
    input.downAttack(0, 'charge');
    input.up(0);
    input.downAttack(0, 'charge');
    assert.deepEqual(actions, ['guard', 'charge-start']);
});
