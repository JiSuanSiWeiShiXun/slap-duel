'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { physicalSafeToUiRect, layoutFromUiSafeRect } = require('../.test-build/GameLayout.js');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const rect = (x, y, width, height) => ({ x, y, width, height });
const dimensions = [[360, 640], [390, 844], [844, 390]];
function fromScreen(cssWidth, cssHeight, dpr = 1, edges = [0, 0, 0, 0]) {
  const design = cssWidth > cssHeight ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
  const rawWidth = cssWidth * dpr, rawHeight = cssHeight * dpr;
  const scale = Math.min(rawWidth / design.width, rawHeight / design.height);
  const viewport = rect((rawWidth - design.width * scale) / 2, (rawHeight - design.height * scale) / 2,
    design.width * scale, design.height * scale);
  const [left, right, top, bottom] = edges.map(n => n * dpr);
  const uiSafe = physicalSafeToUiRect(rect(left, bottom, rawWidth - left - right, rawHeight - top - bottom), viewport, { x: scale, y: scale });
  return layoutFromUiSafeRect(design, uiSafe, { x: scale / dpr, y: scale / dpr });
}
function touches(layout) {
  return [...layout.menu.cards, ...layout.menu.modes, layout.menu.opponent, layout.menu.start, layout.menu.practice,
    layout.intro.enter, layout.intro.back, layout.battle.pause, layout.battle.guard, layout.battle.attack, layout.battle.retry,
    layout.result.retry, layout.result.change, layout.common.primary, layout.common.secondary, layout.common.tertiary, layout.common.back];
}
function disjoint(a, b) {
  return a.x + a.width / 2 <= b.x - b.width / 2 || b.x + b.width / 2 <= a.x - a.width / 2 ||
    a.y + a.height / 2 <= b.y - b.height / 2 || b.y + b.height / 2 <= a.y - a.height / 2;
}

test('raw safe area honors viewport origin and independent scale axes', () => {
  assert.deepEqual(physicalSafeToUiRect(rect(80, 160, 400, 600), rect(20, 40, 1000, 1000), { x: 2, y: 4 }),
    rect(30, 30, 200, 150));
});

test('equivalent CSS safe edges at different physical DPR yield equivalent local bounds and target sizes', () => {
  for (const [width, height] of dimensions) {
    const first = fromScreen(width, height, 1, [12, 8, 28, 16]);
    const second = fromScreen(width, height, 2, [12, 8, 28, 16]);
    assert.deepEqual(first.safe, second.safe);
    assert.deepEqual(first.menu, second.menu);
    close(first.minTargetWidth, second.minTargetWidth);
  }
});

test('SHOW_ALL letterboxing does not manufacture safe insets on a tall screen', () => {
  const layout = fromScreen(390, 844, 2);
  assert.deepEqual(layout.safe, { left: -360, right: 360, bottom: -640, top: 640, width: 720, height: 1280, centerX: 0, centerY: 0 });
});

test('asymmetric UI safe rectangle clips to design bounds before applying centered local origin', () => {
  const layout = layoutFromUiSafeRect({ width: 1280, height: 720 }, rect(24, 36, 1200, 660), { x: .6, y: .6 });
  assert.deepEqual(layout.safe, { left: -616, right: 584, bottom: -324, top: 336, width: 1200, height: 660, centerX: -16, centerY: 6 });
  const outside = layoutFromUiSafeRect({ width: 720, height: 1280 }, rect(-40, -100, 820, 1480), { x: .5, y: .5 });
  assert.equal(outside.safe.width, 720); assert.equal(outside.safe.height, 1280);
});

test('all actual interactive page rectangles remain at least44 CSSpx and inside safe bounds in three viewports', () => {
  for (const [width, height] of dimensions) {
    const layout = fromScreen(width, height, 2);
    for (const target of touches(layout)) {
      assert.ok(target.width * layout.cssScaleX >= 44 - 1e-8);
      assert.ok(target.height * layout.cssScaleY >= 44 - 1e-8);
      assert.ok(target.x - target.width / 2 >= layout.safe.left - 1e-8);
      assert.ok(target.x + target.width / 2 <= layout.safe.right + 1e-8);
      assert.ok(target.y - target.height / 2 >= layout.safe.bottom - 1e-8);
      assert.ok(target.y + target.height / 2 <= layout.safe.top + 1e-8);
    }
  }
});

test('result buttons and build marker reserve separate rows in all orientations', () => {
  for (const [width, height] of dimensions) {
    const layout = fromScreen(width, height);
    assert.ok(disjoint(layout.result.retry, layout.result.change));
    assert.ok(disjoint(layout.result.retry, layout.common.build));
    assert.ok(disjoint(layout.result.change, layout.common.build));
    for (const card of layout.intro.cards) {
      assert.ok(disjoint(card, layout.intro.enter));
      assert.ok(disjoint(card, layout.intro.back));
    }
  }
});

test('landscape intro gives full-width three-line stories their own row below portraits', () => {
  const layout = fromScreen(844, 390);
  for (const [i, story] of layout.intro.stories.entries()) {
    assert.ok(story.width >= 32 * 11);
    assert.equal(story.height, 32 * 1.5 * 3);
    assert.ok(disjoint(story, layout.intro.portraits[i]));
    assert.ok(story.y - story.height / 2 >= layout.intro.cards[i].y - layout.intro.cards[i].height / 2);
  }
});

test('orientation round trip produces identical rectangles without retaining prior layout state', () => {
  const portrait = fromScreen(360, 640), before = JSON.stringify(portrait.menu);
  fromScreen(844, 390);
  assert.equal(JSON.stringify(fromScreen(360, 640).menu), before);
  assert.ok(Object.isFrozen(portrait.menu.cards[0]));
  assert.ok(Object.isFrozen(portrait.safe));
});

test('invalid geometry and nonfinite scales are rejected instead of producing misleading hit targets', () => {
  assert.throws(() => physicalSafeToUiRect(rect(0, 0, 1, 1), rect(0, 0, 1, 1), { x: 0, y: 1 }), /scale/i);
  assert.throws(() => layoutFromUiSafeRect({ width: 0, height: 720 }, rect(0, 0, 1, 1), { x: 1, y: 1 }), /design/i);
  assert.throws(() => layoutFromUiSafeRect({ width: 720, height: 1280 }, rect(800, 0, 20, 10), { x: 1, y: 1 }), /safe/i);
});
