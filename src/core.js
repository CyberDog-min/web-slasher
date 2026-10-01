(function initPageSlashCore(globalScope) {
  'use strict';

  const TIERS = [
    { maxArea: 4000, hp: 1, baseScore: 15 },
    { maxArea: 16000, hp: 2, baseScore: 40 },
    { maxArea: 64000, hp: 3, baseScore: 90 },
    { maxArea: 256000, hp: 4, baseScore: 200 },
    { maxArea: Infinity, hp: 5, baseScore: 450 }
  ];

  const SWORDS = Object.freeze([
    Object.freeze({
      id: 'iron',
      name: '铁刃',
      threshold: 0,
      color: '#e8f2ff',
      trail: '#94a3b8',
      tone: 520
    }),
    Object.freeze({
      id: 'thunder',
      name: '雷光',
      threshold: 1000,
      color: '#fff7a8',
      trail: '#38bdf8',
      tone: 680
    }),
    Object.freeze({
      id: 'frost',
      name: '霜锋',
      threshold: 4000,
      color: '#e0fbff',
      trail: '#67e8f9',
      tone: 760
    }),
    Object.freeze({
      id: 'crimson',
      name: '赤霄',
      threshold: 16000,
      color: '#ffe0d8',
      trail: '#fb7185',
      tone: 420
    }),
    Object.freeze({
      id: 'meteor',
      name: '星陨',
      threshold: 64000,
      color: '#fff1c7',
      trail: '#f59e0b',
      tone: 340
    }),
    Object.freeze({
      id: 'void',
      name: '无相',
      threshold: 256000,
      color: '#ffffff',
      trail: '#a78bfa',
      tone: 260
    })
  ]);

  const COMBO_WINDOW_MS = 1500;
  const MAX_COMBO_MULTIPLIER = 3.5;

  function normalizeArea(area) {
    const numeric = Number(area);
    return Number.isFinite(numeric) ? Math.max(1, numeric) : 1;
  }

  function getElementTier(area) {
    const normalizedArea = normalizeArea(area);
    const tierIndex = TIERS.findIndex((tier) => normalizedArea <= tier.maxArea);
    const tier = TIERS[tierIndex];

    return {
      tier: tierIndex + 1,
      hp: tier.hp,
      baseScore: tier.baseScore
    };
  }

  function createGameState() {
    return {
      pageScore: 0,
      lifetimeScore: 0,
      combo: 0,
      lastHitAt: -Infinity,
      targets: new Map()
    };
  }

  function getComboMultiplier(combo) {
    const normalizedCombo = Math.max(1, Math.floor(Number(combo) || 1));
    return Math.min(MAX_COMBO_MULTIPLIER, 1 + (normalizedCombo - 1) * 0.15);
  }

  function registerHit(state, area, now, targetState = null) {
    const normalizedArea = normalizeArea(area);
    const tier = getElementTier(normalizedArea);
    const key = String(Math.round(normalizedArea));
    const target = targetState || state.targets.get(key) || {
      hp: tier.hp,
      baseScore: tier.baseScore
    };

    if (!targetState) {
      state.targets.set(key, target);
    }

    const withinCombo = now - state.lastHitAt <= COMBO_WINDOW_MS;
    state.combo = withinCombo ? state.combo + 1 : 1;
    state.lastHitAt = now;

    const multiplier = getComboMultiplier(state.combo);
    const damage = 1;
    target.hp = Math.max(0, target.hp - damage);
    const broken = target.hp === 0;
    const score = Math.round(
      (tier.baseScore / tier.hp + (broken ? tier.baseScore * 0.25 : 0)) * multiplier
    );

    state.pageScore += score;
    state.lifetimeScore += score;

    return {
      ok: true,
      reason: null,
      hit: {
        damage,
        score,
        broken,
        tier,
        multiplier
      },
      state
    };
  }

  function getSwords() {
    return SWORDS.map((sword) => ({ ...sword }));
  }

  function unlockSwords(lifetimeScore) {
    const score = Math.max(0, Number(lifetimeScore) || 0);
    return SWORDS.filter((sword) => score >= sword.threshold).map((sword) => sword.id);
  }

  function normalizeCombo(eventLike) {
    if (!eventLike) return null;

    const key = String(eventLike.key || '').toLowerCase();
    const hasModifier = Boolean(
      eventLike.ctrlKey || eventLike.altKey || eventLike.shiftKey || eventLike.metaKey
    );

    if (!key || key.length !== 1 || !hasModifier) return null;

    return {
      key,
      code: String(eventLike.code || `Key${key.toUpperCase()}`),
      ctrl: Boolean(eventLike.ctrlKey),
      alt: Boolean(eventLike.altKey),
      shift: Boolean(eventLike.shiftKey),
      meta: Boolean(eventLike.metaKey)
    };
  }

  function comboMatches(eventLike, combo) {
    if (!combo || !eventLike) return false;

    return String(eventLike.key || '').toLowerCase() === combo.key
      && String(eventLike.code || '') === combo.code
      && Boolean(eventLike.ctrlKey) === Boolean(combo.ctrl)
      && Boolean(eventLike.altKey) === Boolean(combo.alt)
      && Boolean(eventLike.shiftKey) === Boolean(combo.shift)
      && Boolean(eventLike.metaKey) === Boolean(combo.meta);
  }

  function formatCombo(combo) {
    if (!combo) return '未设置';

    const keys = [];
    if (combo.ctrl) keys.push('Ctrl');
    if (combo.alt) keys.push('Alt');
    if (combo.shift) keys.push('Shift');
    if (combo.meta) keys.push('Meta');
    keys.push(String(combo.key || '').toUpperCase());

    return keys.join(' + ');
  }

  const api = Object.freeze({
    getElementTier,
    createGameState,
    registerHit,
    getComboMultiplier,
    getSwords,
    unlockSwords,
    normalizeCombo,
    comboMatches,
    formatCombo
  });

  globalScope.PageSlashCore = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
