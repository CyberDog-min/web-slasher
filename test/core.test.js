const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core.js');

test('maps visible area to five durability tiers', () => {
  assert.deepEqual(Core.getElementTier(3999), { tier: 1, hp: 1, baseScore: 60 });
  assert.deepEqual(Core.getElementTier(4000), { tier: 1, hp: 1, baseScore: 60 });
  assert.deepEqual(Core.getElementTier(4001), { tier: 2, hp: 2, baseScore: 160 });
  assert.deepEqual(Core.getElementTier(16000), { tier: 2, hp: 2, baseScore: 160 });
  assert.deepEqual(Core.getElementTier(16001), { tier: 3, hp: 3, baseScore: 360 });
  assert.deepEqual(Core.getElementTier(64000), { tier: 3, hp: 3, baseScore: 360 });
  assert.deepEqual(Core.getElementTier(64001), { tier: 4, hp: 4, baseScore: 760 });
  assert.deepEqual(Core.getElementTier(256000), { tier: 4, hp: 4, baseScore: 760 });
  assert.deepEqual(Core.getElementTier(256001), { tier: 5, hp: 5, baseScore: 1600 });
});

test('damages an element and awards a larger final blow', () => {
  const state = Core.createGameState();
  const first = Core.registerHit(state, 10000, 1000);
  const second = Core.registerHit(state, 10000, 2000);

  assert.equal(first.hit.damage, 1);
  assert.equal(first.hit.score, 80);
  assert.equal(first.hit.broken, false);
  assert.equal(second.hit.score, 138);
  assert.equal(second.hit.broken, true);
  assert.equal(second.state.pageScore, 218);
  assert.equal(second.state.lifetimeScore, 218);
});

test('increases combo within the combo window and resets after timeout', () => {
  const state = Core.createGameState();
  Core.registerHit(state, 1000, 1000);
  const comboHit = Core.registerHit(state, 1000, 2000);
  const resetHit = Core.registerHit(state, 1000, 4000);

  assert.equal(comboHit.hit.multiplier, 1.15);
  assert.equal(resetHit.hit.multiplier, 1);
});

test('unlocks swords at exact lifetime thresholds', () => {
  assert.deepEqual(Core.unlockSwords(799), ['iron']);
  assert.deepEqual(Core.unlockSwords(800), ['iron', 'thunder']);
  assert.deepEqual(Core.unlockSwords(22000), [
    'iron',
    'thunder',
    'frost',
    'crimson',
    'meteor',
    'void'
  ]);
});

test('returns isolated copies of the canonical sword catalog', () => {
  const swords = Core.getSwords();
  assert.deepEqual(swords.map((sword) => sword.id), [
    'iron',
    'thunder',
    'frost',
    'crimson',
    'meteor',
    'void'
  ]);
  assert.deepEqual(swords.map((sword) => sword.threshold), [
    0,
    800,
    2500,
    6000,
    12000,
    22000
  ]);

  swords[0].name = 'mutated';
  assert.equal(Core.getSwords()[0].name, '铁刃');
});

test('normalizes and formats key combinations', () => {
  const combo = Core.normalizeCombo({
    key: 'S',
    code: 'KeyS',
    altKey: true,
    shiftKey: true
  });

  assert.equal(Core.formatCombo(combo), 'Alt + Shift + S');
  assert.equal(Core.comboMatches({
    key: 's',
    code: 'KeyS',
    altKey: true,
    shiftKey: true
  }, combo), true);
  assert.equal(Core.normalizeCombo({ key: 's', code: 'KeyS' }), null);
});
