(function initPageSlashContent() {
  'use strict';

  const Core = globalThis.PageSlashCore;
  const Dom = globalThis.PageSlashDom;
  const INSTANCE_KEY = '__pageSlashContentLoadedV1';

  if (!Core || !Dom || globalThis[INSTANCE_KEY]) return;
  globalThis[INSTANCE_KEY] = true;

  const DEFAULT_COMBO = Object.freeze({
    key: 's',
    code: 'KeyS',
    ctrl: false,
    alt: true,
    shift: true,
    meta: false
  });

  const MESSAGE = Object.freeze({
    getState: 'PAGE_SLASH_GET_STATE',
    toggle: 'PAGE_SLASH_TOGGLE',
    settings: 'PAGE_SLASH_SETTINGS',
    stateChanged: 'PAGE_SLASH_STATE_CHANGED'
  });

  const SLASH_COOLDOWN_MS = 90;
  const SLASH_LENGTH = 220;
  const SLASH_SAMPLES = 14;
  const POINTER_HISTORY_MS = 100;
  const MAX_PARTICLES = 240;
  const STORAGE_WRITE_DELAY_MS = 300;
  const STATE_BROADCAST_DELAY_MS = 60;

  const scoreFormatter = new Intl.NumberFormat('zh-CN');
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  let settings = {
    lifetimeScore: 0,
    customCombo: { ...DEFAULT_COMBO },
    selectedSword: 'iron',
    soundEnabled: true
  };

  let modeActive = false;
  let gameState = Core.createGameState();
  let elementStates = new WeakMap();
  let originalStyles = new WeakMap();
  let breakVersions = new WeakMap();
  let breakAnimations = new WeakMap();
  let brokenElements = new Set();
  let excludedElements = new Set();

  let host = null;
  let shadowRoot = null;
  let canvas = null;
  let context = null;
  let hudPageScore = null;
  let hudCombo = null;
  let hudSword = null;
  let topCombo = null;

  let animationFrame = 0;
  let lastFrameAt = 0;
  let lastSlashAt = -Infinity;
  let lastSoundAt = -Infinity;
  let pointerHistory = [];
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let cursorVisible = true;
  let slashEffect = null;
  let particles = [];
  let scoreLabels = [];
  let screenShake = 0;

  let pageUrl = location.href;
  let urlTimer = 0;
  let storageWriteTimer = 0;
  let stateBroadcastTimer = 0;
  let resizeWidth = 0;
  let resizeHeight = 0;
  let resizeDpr = 1;
  let audioContext = null;
  let previousCursor = null;

  function clampScore(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.floor(numeric);
  }

  function isValidCombo(combo) {
    if (!combo || typeof combo !== 'object') return false;
    const key = String(combo.key || '');
    const code = String(combo.code || '');
    const hasModifier = Boolean(combo.ctrl || combo.alt || combo.shift || combo.meta);
    return key.length === 1 && code.length > 0 && hasModifier;
  }

  function getSwords() {
    return Core.getSwords();
  }

  function getSwordById(swordId) {
    return getSwords().find((sword) => sword.id === swordId) || getSwords()[0];
  }

  function getEffectiveLifetimeScore() {
    return Math.max(settings.lifetimeScore, gameState.lifetimeScore);
  }

  function getSelectedSword() {
    const sword = getSwordById(settings.selectedSword);
    return getEffectiveLifetimeScore() >= sword.threshold ? sword : getSwords()[0];
  }

  function normalizeLifetimeScore(value) {
    return clampScore(value);
  }

  function normalizeSettings(stored) {
    const source = stored || {};
    const lifetimeScore = normalizeLifetimeScore(source.lifetimeScore);
    const selectedCandidate = getSwordById(source.selectedSword);
    const selectedSword = lifetimeScore >= selectedCandidate.threshold
      ? selectedCandidate.id
      : 'iron';

    return {
      lifetimeScore,
      customCombo: isValidCombo(source.customCombo)
        ? { ...source.customCombo }
        : { ...DEFAULT_COMBO },
      selectedSword,
      soundEnabled: source.soundEnabled !== false
    };
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get({
        lifetimeScore: 0,
        customCombo: DEFAULT_COMBO,
        selectedSword: 'iron',
        soundEnabled: true
      });
      settings = normalizeSettings(stored);
    } catch {
      settings = normalizeSettings(null);
    }

    gameState.lifetimeScore = Math.max(gameState.lifetimeScore, settings.lifetimeScore);
    updateHud();
  }

  function createPublicState() {
    const sword = getSelectedSword();
    return {
      active: modeActive,
      pageScore: clampScore(gameState.pageScore),
      lifetimeScore: clampScore(getEffectiveLifetimeScore()),
      combo: Math.max(0, Number(gameState.combo) || 0),
      multiplier: Core.getComboMultiplier(gameState.combo),
      selectedSword: sword.id,
      swordName: sword.name,
      soundEnabled: Boolean(settings.soundEnabled)
    };
  }

  function sendMessageSafely(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result?.catch) result.catch(() => {});
    } catch {
      // The popup may be closed while the page is still running.
    }
  }

  function broadcastState() {
    if (stateBroadcastTimer) return;

    stateBroadcastTimer = window.setTimeout(() => {
      stateBroadcastTimer = 0;
      sendMessageSafely({
        type: MESSAGE.stateChanged,
        state: createPublicState()
      });
    }, STATE_BROADCAST_DELAY_MS);
  }

  async function flushLifetimeScore() {
    if (storageWriteTimer) {
      window.clearTimeout(storageWriteTimer);
      storageWriteTimer = 0;
    }

    try {
      const stored = await chrome.storage.local.get({ lifetimeScore: 0 });
      const current = normalizeLifetimeScore(stored.lifetimeScore);
      const next = Math.max(current, settings.lifetimeScore, gameState.lifetimeScore);

      gameState.lifetimeScore = next;
      settings.lifetimeScore = next;
      if (next !== current) {
        await chrome.storage.local.set({ lifetimeScore: next });
      }
    } catch {
      // Gameplay remains available when extension storage is unavailable.
    }
  }

  function queueLifetimeWrite() {
    if (storageWriteTimer) window.clearTimeout(storageWriteTimer);
    storageWriteTimer = window.setTimeout(flushLifetimeScore, STORAGE_WRITE_DELAY_MS);
  }

  function createHudItem(label, value, className) {
    const item = document.createElement('div');
    item.className = className ? `hud-item ${className}` : 'hud-item';

    const labelNode = document.createElement('span');
    labelNode.className = 'hud-label';
    labelNode.textContent = label;

    const valueNode = document.createElement('strong');
    valueNode.className = 'hud-value';
    valueNode.textContent = value;

    item.append(labelNode, valueNode);
    return { item, valueNode };
  }

  function createOverlay() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'page-slash-overlay-host';
    host.setAttribute('aria-hidden', 'true');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('width', '100vw', 'important');
    host.style.setProperty('height', '100vh', 'important');
    host.style.setProperty('margin', '0', 'important');
    host.style.setProperty('padding', '0', 'important');
    host.style.setProperty('border', '0', 'important');
    host.style.setProperty('background', 'transparent', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');

    shadowRoot = host.attachShadow({ mode: 'closed' });

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = chrome.runtime.getURL('src/overlay.css');

    canvas = document.createElement('canvas');
    canvas.className = 'slash-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    context = canvas.getContext('2d', { alpha: true, desynchronized: true });

    const topStatus = document.createElement('div');
    topStatus.className = 'top-status';

    const modeDot = document.createElement('span');
    modeDot.className = 'mode-dot';
    modeDot.setAttribute('aria-hidden', 'true');

    const modeLabel = document.createElement('span');
    modeLabel.textContent = '斩击模式';

    topCombo = document.createElement('span');
    topCombo.className = 'top-hint';
    topCombo.textContent = Core.formatCombo(settings.customCombo);
    topStatus.append(modeDot, modeLabel, topCombo);

    const hud = document.createElement('div');
    hud.className = 'hud';

    const pageItem = createHudItem('本页', '0');
    const comboItem = createHudItem('连击', 'x1.00');
    const swordItem = createHudItem('剑', getSelectedSword().name, 'hud-sword');
    hudPageScore = pageItem.valueNode;
    hudCombo = comboItem.valueNode;
    hudSword = swordItem.valueNode;
    hud.append(pageItem.item, comboItem.item, swordItem.item);

    shadowRoot.append(stylesheet, canvas, topStatus, hud);
    (document.documentElement || document.body).appendChild(host);

    excludedElements.add(host);
    resizeCanvas();
    updateHud();
  }

  function destroyOverlay() {
    if (host?.isConnected) {
      host.remove();
    }

    host = null;
    shadowRoot = null;
    canvas = null;
    context = null;
    hudPageScore = null;
    hudCombo = null;
    hudSword = null;
    topCombo = null;
  }

  function resizeCanvas() {
    if (!canvas) return;

    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    resizeWidth = width;
    resizeHeight = height;
    resizeDpr = dpr;
    context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function updateHud() {
    const sword = getSelectedSword();
    const multiplier = Core.getComboMultiplier(gameState.combo);

    if (hudPageScore) hudPageScore.textContent = scoreFormatter.format(gameState.pageScore);
    if (hudCombo) hudCombo.textContent = `x${multiplier.toFixed(2)}`;
    if (hudSword) hudSword.textContent = sword.name;
    if (topCombo) topCombo.textContent = Core.formatCombo(settings.customCombo);

    if (hudSword?.parentElement) {
      hudSword.parentElement.style.setProperty('--sword-color', sword.color);
      hudSword.parentElement.style.setProperty('--sword-trail', sword.trail);
    }
  }

  function setNativeCursorHidden() {
    const root = document.documentElement;
    if (!root || previousCursor) return;

    previousCursor = {
      value: root.style.getPropertyValue('cursor'),
      priority: root.style.getPropertyPriority('cursor')
    };
    root.style.setProperty('cursor', 'none', 'important');
  }

  function restoreNativeCursor() {
    const root = document.documentElement;
    if (!root || !previousCursor) return;

    try {
      if (previousCursor.value) {
        root.style.setProperty('cursor', previousCursor.value, previousCursor.priority);
      } else {
        root.style.removeProperty('cursor');
      }
    } catch {
      // A page may replace the root element while the mode is active.
    }

    previousCursor = null;
  }

  function handleKeyDown(event) {
    if (event.repeat || !Core.comboMatches(event, settings.customCombo)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (modeActive) {
      exitMode();
    } else {
      enterMode().catch(() => {});
    }
  }

  function handlePointerMove(event) {
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;

    const now = performance.now();
    cursorX = event.clientX;
    cursorY = event.clientY;
    cursorVisible = true;
    pointerHistory.push({ x: cursorX, y: cursorY, time: now });
    pointerHistory = pointerHistory.filter((point) => now - point.time <= POINTER_HISTORY_MS);
  }

  function handleMouseMove(event) {
    handlePointerMove(event);
  }

  function handlePointerLeave(event) {
    if (event.relatedTarget) return;
    cursorVisible = false;
    pointerHistory = [];
  }

  function handlePointerEnter() {
    cursorVisible = true;
  }

  function getSlashAngle() {
    const first = pointerHistory[0];
    const last = pointerHistory[pointerHistory.length - 1];

    if (!first || !last || Math.hypot(last.x - first.x, last.y - first.y) < 12) {
      return -Math.PI / 4;
    }

    return Math.atan2(last.y - first.y, last.x - first.x);
  }

  function isMouseLikePointer(event) {
    return !event.pointerType || event.pointerType === 'mouse' || event.pointerType === 'pen';
  }

  function handlePointerDown(event) {
    if (!modeActive || !isMouseLikePointer(event)) return;

    if (event.button === 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensureAudio();
      slashAt({ x: event.clientX, y: event.clientY }, getSlashAngle());
    } else {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function handleMouseDown(event) {
    if (!modeActive) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (!window.PointerEvent && event.button === 0) {
      ensureAudio();
      slashAt({ x: event.clientX, y: event.clientY }, getSlashAngle());
    }
  }

  function handleContextMenu(event) {
    if (!modeActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    exitMode();
  }

  function swallowInteraction(event) {
    if (!modeActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function addModeListeners() {
    window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
    window.addEventListener('mousemove', handleMouseMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('click', swallowInteraction, true);
    window.addEventListener('auxclick', swallowInteraction, true);
    window.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('pointerleave', handlePointerLeave, true);
    window.addEventListener('mouseleave', handlePointerLeave, true);
    window.addEventListener('pointerenter', handlePointerEnter, true);
    window.addEventListener('mouseenter', handlePointerEnter, true);
    window.addEventListener('resize', resizeCanvas, { passive: true });
    window.addEventListener('popstate', handleUrlChange, true);
    window.addEventListener('hashchange', handleUrlChange, true);
  }

  function removeModeListeners() {
    window.removeEventListener('pointermove', handlePointerMove, true);
    window.removeEventListener('mousemove', handleMouseMove, true);
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('mousedown', handleMouseDown, true);
    window.removeEventListener('click', swallowInteraction, true);
    window.removeEventListener('auxclick', swallowInteraction, true);
    window.removeEventListener('contextmenu', handleContextMenu, true);
    window.removeEventListener('pointerleave', handlePointerLeave, true);
    window.removeEventListener('mouseleave', handlePointerLeave, true);
    window.removeEventListener('pointerenter', handlePointerEnter, true);
    window.removeEventListener('mouseenter', handlePointerEnter, true);
    window.removeEventListener('resize', resizeCanvas);
    window.removeEventListener('popstate', handleUrlChange, true);
    window.removeEventListener('hashchange', handleUrlChange, true);
  }

  function ensureAudio() {
    if (!settings.soundEnabled) return null;
    if (audioContext) {
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      return audioContext;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
      audioContext = new AudioContextClass();
    } catch {
      audioContext = null;
    }

    return audioContext;
  }

  function playHitSound(hit) {
    if (!settings.soundEnabled) return;

    const now = performance.now();
    if (now - lastSoundAt < 35) return;
    lastSoundAt = now;

    const audio = ensureAudio();
    if (!audio || audio.state !== 'running') return;

    const sword = getSelectedSword();
    const startAt = audio.currentTime;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const frequency = sword.tone * (1 + Math.min(12, gameState.combo) * 0.018);

    oscillator.type = hit.broken ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(80, frequency * (hit.broken ? 1.55 : 0.72)),
      startAt + (hit.broken ? 0.16 : 0.075)
    );

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(hit.broken ? 0.085 : 0.045, startAt + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + (hit.broken ? 0.19 : 0.1));

    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + (hit.broken ? 0.2 : 0.11));
  }

  function pushParticle(particle) {
    if (particles.length >= MAX_PARTICLES) {
      particles.splice(0, particles.length - MAX_PARTICLES + 1);
    }
    particles.push(particle);
  }

  function spawnHitEffects(element, hit, point) {
    const rect = element.getBoundingClientRect();
    const center = {
      x: point?.x ?? rect.left + rect.width / 2,
      y: point?.y ?? rect.top + rect.height / 2
    };
    const sword = getSelectedSword();
    const reduced = reducedMotionQuery.matches;
    const baseCount = reduced ? 8 : Math.min(24, 7 + hit.tier.tier * 3);
    const count = hit.broken ? baseCount + (reduced ? 2 : 8) : baseCount;

    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 65 + Math.random() * (hit.broken ? 230 : 150);
      const life = 260 + Math.random() * (hit.broken ? 420 : 260);
      pushParticle({
        kind: index % 3 === 0 ? 'shard' : 'spark',
        x: center.x + (Math.random() - 0.5) * 16,
        y: center.y + (Math.random() - 0.5) * 16,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 25,
        gravity: 260,
        size: 1.2 + Math.random() * (hit.broken ? 3.8 : 2.4),
        life,
        maxLife: life,
        color: Math.random() > 0.45 ? sword.color : sword.trail,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 9
      });
    }

    scoreLabels.push({
      x: center.x,
      y: center.y - 10,
      value: hit.score,
      life: hit.broken ? 820 : 620,
      maxLife: hit.broken ? 820 : 620,
      color: sword.color,
      broken: hit.broken
    });

    if (!reduced) {
      screenShake = Math.min(5.5, 1.8 + hit.tier.tier * 0.65);
    }
  }

  function getHiddenStyle(originalStyle) {
    const base = String(originalStyle || '').trim();
    return `${base ? `${base};` : ''}visibility: hidden !important; pointer-events: none !important;`;
  }

  function finalizeBrokenElement(element, version) {
    if (breakVersions.get(element) !== version || !brokenElements.has(element)) return;

    try {
      const animation = breakAnimations.get(element);
      animation?.cancel();
      breakAnimations.delete(element);

      if (element.isConnected) {
        element.setAttribute('style', getHiddenStyle(originalStyles.get(element)));
      }
    } catch {
      // The page may remove the element before the break animation settles.
    }
  }

  function breakElement(element) {
    if (brokenElements.has(element)) return;

    try {
      originalStyles.set(element, element.getAttribute('style'));
      const version = (breakVersions.get(element) || 0) + 1;
      breakVersions.set(element, version);
      brokenElements.add(element);
      excludedElements.add(element);

      if (!element.isConnected) return;

      if (typeof element.animate !== 'function') {
        finalizeBrokenElement(element, version);
        return;
      }

      const animation = element.animate(
        [
          { opacity: '1', filter: 'blur(0)', transform: 'scale(1)' },
          { opacity: '0', filter: 'blur(2px)', transform: 'scale(0.94)' }
        ],
        {
          duration: reducedMotionQuery.matches ? 80 : 180,
          easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
          fill: 'forwards'
        }
      );

      breakAnimations.set(element, animation);
      animation.finished.then(
        () => finalizeBrokenElement(element, version),
        () => finalizeBrokenElement(element, version)
      );
    } catch {
      finalizeBrokenElement(element, breakVersions.get(element) || 0);
    }
  }

  function restoreBrokenElements() {
    const elements = Array.from(brokenElements);

    for (const element of elements) {
      try {
        const version = (breakVersions.get(element) || 0) + 1;
        breakVersions.set(element, version);
        const animation = breakAnimations.get(element);
        animation?.cancel();
        breakAnimations.delete(element);

        if (!element.isConnected) continue;

        const originalStyle = originalStyles.get(element);
        if (originalStyle === null) {
          element.removeAttribute('style');
        } else {
          element.setAttribute('style', originalStyle);
        }
      } catch {
        // Ignore pages that replace or lock target nodes during restoration.
      }
    }

    brokenElements = new Set();
    breakAnimations = new WeakMap();
    breakVersions = new WeakMap();
    originalStyles = new WeakMap();
    elementStates = new WeakMap();
    excludedElements = new Set(host ? [host] : []);
  }

  function resetPageState() {
    const lifetimeScore = Math.max(settings.lifetimeScore, gameState.lifetimeScore);
    gameState = Core.createGameState();
    gameState.lifetimeScore = lifetimeScore;
    settings.lifetimeScore = lifetimeScore;
    slashEffect = null;
    particles = [];
    scoreLabels = [];
    pointerHistory = [];
    lastSlashAt = -Infinity;
    screenShake = 0;
    updateHud();
    broadcastState();
  }

  function resetForUrlChange() {
    restoreBrokenElements();
    resetPageState();
    pageUrl = location.href;
  }

  function handleUrlChange() {
    if (location.href !== pageUrl) resetForUrlChange();
  }

  function damageTarget(element, point) {
    if (!element?.isConnected) return false;

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const area = Dom.getVisibleArea(element, viewport);
    if (area < 16) return false;

    let targetState = elementStates.get(element);
    if (!targetState) {
      const tier = Core.getElementTier(area);
      targetState = { hp: tier.hp, baseScore: tier.baseScore };
      elementStates.set(element, targetState);
    }

    const result = Core.registerHit(gameState, area, performance.now(), targetState);
    if (!result.ok) return false;

    updateHud();
    spawnHitEffects(element, result.hit, point);
    playHitSound(result.hit);
    queueLifetimeWrite();
    broadcastState();

    if (result.hit.broken) {
      breakElement(element);
    }

    return true;
  }

  function hitTargets(point, angle) {
    const samples = Dom.buildSlashSamples(point, angle, SLASH_LENGTH, SLASH_SAMPLES);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const targets = new Map();

    for (const sample of samples) {
      let stack = [];
      try {
        stack = document.elementsFromPoint(sample.x, sample.y);
      } catch {
        stack = [];
      }

      const target = Dom.chooseTarget(stack, viewport, excludedElements);
      if (target && !targets.has(target)) {
        targets.set(target, { element: target, point: sample });
      }
    }

    for (const target of targets.values()) {
      damageTarget(target.element, target.point);
    }
  }

  function slashAt(point, angle) {
    const now = performance.now();
    if (now - lastSlashAt < SLASH_COOLDOWN_MS) return;

    lastSlashAt = now;
    slashEffect = {
      startedAt: now,
      duration: reducedMotionQuery.matches ? 130 : 210,
      angle,
      samples: Dom.buildSlashSamples(point, angle, SLASH_LENGTH, SLASH_SAMPLES)
    };

    hitTargets(point, angle);
  }

  function updateParticles(deltaSeconds) {
    for (const particle of particles) {
      particle.life -= deltaSeconds * 1000;
      particle.x += particle.vx * deltaSeconds;
      particle.y += particle.vy * deltaSeconds;
      particle.vy += particle.gravity * deltaSeconds;
      particle.rotation += particle.spin * deltaSeconds;
      particle.vx *= 0.992;
      particle.vy *= 0.992;
    }

    particles = particles.filter((particle) => particle.life > 0);
    scoreLabels = scoreLabels.filter((label) => {
      label.life -= deltaSeconds * 1000;
      label.y -= 24 * deltaSeconds;
      return label.life > 0;
    });
  }

  function drawParticles() {
    for (const particle of particles) {
      const alpha = Math.max(0, particle.life / particle.maxLife);
      context.save();
      context.globalAlpha = alpha;
      context.fillStyle = particle.color;
      context.strokeStyle = particle.color;
      context.shadowColor = particle.color;
      context.shadowBlur = particle.kind === 'spark' ? 9 : 4;

      if (particle.kind === 'spark') {
        context.lineWidth = particle.size;
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(particle.x, particle.y);
        context.lineTo(
          particle.x - particle.vx * 0.025,
          particle.y - particle.vy * 0.025
        );
        context.stroke();
      } else {
        context.translate(particle.x, particle.y);
        context.rotate(particle.rotation);
        context.beginPath();
        context.moveTo(-particle.size * 1.6, -particle.size);
        context.lineTo(particle.size * 1.5, -particle.size * 0.2);
        context.lineTo(particle.size * 0.2, particle.size * 1.4);
        context.closePath();
        context.fill();
      }

      context.restore();
    }
  }

  function drawScoreLabels() {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '800 14px ui-sans-serif, system-ui, sans-serif';

    for (const label of scoreLabels) {
      const alpha = Math.max(0, label.life / label.maxLife);
      context.save();
      context.globalAlpha = alpha;
      context.fillStyle = label.color;
      context.shadowColor = label.color;
      context.shadowBlur = label.broken ? 15 : 8;
      context.fillText(`+${label.value}`, label.x, label.y);
      context.restore();
    }
  }

  function drawSlash(now) {
    if (!slashEffect) return;

    const progress = Math.min(1, (now - slashEffect.startedAt) / slashEffect.duration);
    if (progress >= 1) {
      slashEffect = null;
      return;
    }

    const sword = getSelectedSword();
    const samples = slashEffect.samples;
    const fade = Math.sin(progress * Math.PI);
    const first = samples[0];
    const last = samples[samples.length - 1];

    context.save();
    context.globalCompositeOperation = 'lighter';
    context.lineCap = 'round';
    context.shadowColor = sword.trail;
    context.shadowBlur = 24 * fade;
    context.strokeStyle = sword.trail;
    context.globalAlpha = fade * 0.42;
    context.lineWidth = 13 * (1 - progress * 0.4);
    context.beginPath();
    context.moveTo(first.x, first.y);
    context.lineTo(last.x, last.y);
    context.stroke();

    context.strokeStyle = sword.color;
    context.globalAlpha = fade;
    context.lineWidth = 3.5 * (1 - progress * 0.3);
    context.beginPath();
    context.moveTo(first.x, first.y);
    context.lineTo(last.x, last.y);
    context.stroke();
    context.restore();
  }

  function drawSwordCursor() {
    if (!cursorVisible) return;

    const sword = getSelectedSword();
    const angle = getSlashAngle();
    const hover = 1 + Math.sin(performance.now() / 520) * 0.015;

    context.save();
    context.translate(cursorX, cursorY);
    context.rotate(angle);
    context.scale(hover, hover);
    context.globalCompositeOperation = 'lighter';

    context.shadowColor = sword.trail;
    context.shadowBlur = 14;
    context.strokeStyle = sword.color;
    context.fillStyle = sword.color;
    context.lineWidth = 1.4;

    const bladeGradient = context.createLinearGradient(-21, 0, 19, 0);
    bladeGradient.addColorStop(0, 'rgba(255,255,255,0.22)');
    bladeGradient.addColorStop(0.55, sword.color);
    bladeGradient.addColorStop(1, '#ffffff');
    context.fillStyle = bladeGradient;

    context.beginPath();
    context.moveTo(-21, -2.9);
    context.lineTo(12, -3.2);
    context.lineTo(22, 0);
    context.lineTo(12, 3.2);
    context.lineTo(-21, 2.9);
    context.closePath();
    context.fill();
    context.stroke();

    context.shadowBlur = 8;
    context.fillStyle = sword.trail;
    context.fillRect(-25, -7, 4, 14);

    context.fillStyle = '#1d2635';
    context.strokeStyle = sword.color;
    context.beginPath();
    context.roundRect(-39, -3.2, 14, 6.4, 3);
    context.fill();
    context.stroke();

    context.fillStyle = sword.color;
    context.beginPath();
    context.arc(-43, 0, 3.1, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawFrame(now) {
    if (!modeActive || !context || !canvas) return;

    if (window.innerWidth !== resizeWidth || window.innerHeight !== resizeHeight) {
      resizeCanvas();
    }

    const deltaSeconds = lastFrameAt
      ? Math.min(0.05, Math.max(0, now - lastFrameAt) / 1000)
      : 0;
    lastFrameAt = now;
    updateParticles(deltaSeconds);

    const dpr = resizeDpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, resizeWidth, resizeHeight);

    context.save();
    if (screenShake > 0 && !reducedMotionQuery.matches) {
      context.translate(
        (Math.random() - 0.5) * screenShake,
        (Math.random() - 0.5) * screenShake
      );
      screenShake *= Math.pow(0.005, deltaSeconds);
      if (screenShake < 0.08) screenShake = 0;
    }

    drawSlash(now);
    drawParticles();
    drawScoreLabels();
    drawSwordCursor();
    context.restore();

    animationFrame = window.requestAnimationFrame(drawFrame);
  }

  async function enterMode() {
    if (modeActive) return;

    await loadSettings();
    if (modeActive) return;

    modeActive = true;
    createOverlay();
    setNativeCursorHidden();
    addModeListeners();

    pageUrl = location.href;
    urlTimer = window.setInterval(handleUrlChange, 1000);
    lastFrameAt = 0;
    animationFrame = window.requestAnimationFrame(drawFrame);
    updateHud();
    broadcastState();
  }

  function exitMode() {
    if (!modeActive) return;

    modeActive = false;
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    window.clearInterval(urlTimer);
    urlTimer = 0;
    removeModeListeners();
    restoreBrokenElements();
    restoreNativeCursor();
    destroyOverlay();
    flushLifetimeScore();

    slashEffect = null;
    particles = [];
    scoreLabels = [];
    pointerHistory = [];
    cursorVisible = true;
    screenShake = 0;
    resetPageState();
  }

  function applySettingsPatch(patch) {
    if (!patch || typeof patch !== 'object') return;

    if (typeof patch.soundEnabled === 'boolean') {
      settings.soundEnabled = patch.soundEnabled;
    }

    if (isValidCombo(patch.customCombo)) {
      settings.customCombo = { ...patch.customCombo };
    }

    if (typeof patch.selectedSword === 'string') {
      const sword = getSwordById(patch.selectedSword);
      if (getEffectiveLifetimeScore() >= sword.threshold) {
        settings.selectedSword = sword.id;
      }
    }

    updateHud();
    broadcastState();
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== 'local') return;

    if (changes.lifetimeScore) {
      const incoming = normalizeLifetimeScore(changes.lifetimeScore.newValue);
      const merged = Math.max(incoming, gameState.lifetimeScore);
      gameState.lifetimeScore = merged;
      settings.lifetimeScore = merged;
    }

    if (changes.selectedSword) {
      const sword = getSwordById(changes.selectedSword.newValue);
      if (settings.lifetimeScore >= sword.threshold) settings.selectedSword = sword.id;
    }

    if (changes.soundEnabled) {
      settings.soundEnabled = changes.soundEnabled.newValue !== false;
    }

    if (changes.customCombo && isValidCombo(changes.customCombo.newValue)) {
      settings.customCombo = { ...changes.customCombo.newValue };
    }

    updateHud();
    broadcastState();
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    switch (message?.type) {
      case MESSAGE.getState:
        sendResponse(createPublicState());
        return false;

      case MESSAGE.toggle:
        if (modeActive) {
          exitMode();
          sendResponse({ ok: true, state: createPublicState() });
          return false;
        }

        enterMode()
          .then(() => sendResponse({ ok: true, state: createPublicState() }))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;

      case MESSAGE.settings:
        applySettingsPatch(message.settings);
        sendResponse({ ok: true, state: createPublicState() });
        return false;

      default:
        return false;
    }
  }

  window.addEventListener('keydown', handleKeyDown, true);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  chrome.storage.onChanged.addListener(handleStorageChange);

  loadSettings();
})();
