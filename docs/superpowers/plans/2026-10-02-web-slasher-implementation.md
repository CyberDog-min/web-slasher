# 斩页 Page Slash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension that turns the pointer into a sword, lets users slash page elements, awards size-based scores, and unlocks six visual swords from lifetime score.

**Architecture:** Keep all scoring, progression, combo, and key-normalization rules in a dependency-free `src/core.js`. Keep DOM hit-testing helpers in `src/dom.js`, page integration and rendering in `src/content.js`, and extension settings in popup/options pages. The content script owns gameplay state and writes only temporary inline-style overrides to hit elements.

**Tech Stack:** Chrome Manifest V3, vanilla JavaScript, Canvas 2D, Shadow DOM, Web Audio API, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-02-slice-web-elements-extension-design.md`

## Global Constraints

- No build step, framework, network request, account, or leaderboard in phase one.
- Support Chrome Manifest V3 and ordinary `http`, `https`, and local pages.
- Default combo is exactly `Alt+Shift+S`.
- Local score resets on refresh or URL change; lifetime score persists in `chrome.storage.local`.
- Six swords unlock at `0`, `800`, `2500`, `6000`, `12000`, and `22000` lifetime points.
- Sword skins never change damage or score.
- Do not permanently modify or delete page elements; restore inline styles on exit.
- Limit active particles to 240.
- Respect `prefers-reduced-motion`.

---

### Task 1: Test Runner and Size-Based Scoring

**Files:**
- Create: `package.json`
- Create: `src/core.js`
- Create: `test/core.test.js`

**Interfaces:**
- Produces: `PageSlashCore.getElementTier(area): {area,hp,baseScore,tier}`
- Produces: `PageSlashCore.createGameState(): {pageScore,lifetimeScore,combo,lastHitAt,targets}`
- Produces: `PageSlashCore.registerHit(state, area, now, targetState?): {ok,reason,hit,state}`

- [ ] **Step 1: Write the failing scoring tests**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core.js');

test('maps visible area to five durability tiers', () => {
  assert.deepEqual(Core.getElementTier(3999), { tier: 1, hp: 1, baseScore: 60 });
  assert.deepEqual(Core.getElementTier(4000), { tier: 2, hp: 2, baseScore: 160 });
  assert.deepEqual(Core.getElementTier(16000), { tier: 3, hp: 3, baseScore: 360 });
  assert.deepEqual(Core.getElementTier(64000), { tier: 4, hp: 4, baseScore: 760 });
  assert.deepEqual(Core.getElementTier(256000), { tier: 5, hp: 5, baseScore: 1600 });
});

test('damages an element and awards a larger final blow', () => {
  const state = Core.createGameState();
  const first = Core.registerHit(state, 10000, 1000);
  const second = Core.registerHit(state, 10000, 2000);
  assert.equal(first.hit.damage, 1);
  assert.equal(first.hit.score, 80);
  assert.equal(first.hit.broken, false);
  assert.equal(second.hit.score, 120);
  assert.equal(second.hit.broken, true);
  assert.equal(second.state.pageScore, 200);
  assert.equal(second.state.lifetimeScore, 200);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- --test-name-pattern="maps visible area|damages an element"`

Expected: FAIL because `src/core.js` does not exist.

- [ ] **Step 3: Add the minimal core implementation**

```javascript
const TIERS = [
  { maxArea: 4000, hp: 1, baseScore: 60 },
  { maxArea: 16000, hp: 2, baseScore: 160 },
  { maxArea: 64000, hp: 3, baseScore: 360 },
  { maxArea: 256000, hp: 4, baseScore: 760 },
  { maxArea: Infinity, hp: 5, baseScore: 1600 }
];

function getElementTier(area) {
  const tierIndex = TIERS.findIndex((tier) => area <= tier.maxArea);
  const tier = TIERS[tierIndex];
  return { tier: tierIndex + 1, hp: tier.hp, baseScore: tier.baseScore };
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

function registerHit(state, area, now, targetState = null) {
  const tier = getElementTier(Math.max(1, Number(area) || 1));
  const key = String(Math.round(area));
  const target = targetState || state.targets.get(key) || { hp: tier.hp, baseScore: tier.baseScore };
  if (!targetState) state.targets.set(key, target);
  const damage = 1;
  target.hp = Math.max(0, target.hp - damage);
  const broken = target.hp === 0;
  const score = Math.round(tier.baseScore / tier.hp + (broken ? tier.baseScore * 0.25 : 0));
  state.pageScore += score;
  state.lifetimeScore += score;
  return {
    ok: true,
    reason: null,
    hit: { damage, score, broken, tier, multiplier: 1 },
    state
  };
}

const api = { getElementTier, createGameState, registerHit };
globalThis.PageSlashCore = api;
if (typeof module === 'object' && module.exports) module.exports = api;
```

- [ ] **Step 4: Re-run the tests**

Run: `npm test -- --test-name-pattern="maps visible area|damages an element"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/core.js test/core.test.js
git commit -m "feat: add size-based scoring core"
```

### Task 2: Combo, Lifetime Score, and Sword Unlocks

**Files:**
- Modify: `src/core.js`
- Modify: `test/core.test.js`

**Interfaces:**
- Produces: `PageSlashCore.getComboMultiplier(combo): number`
- Produces: `PageSlashCore.unlockSwords(lifetimeScore): string[]`
- Produces: `PageSlashCore.normalizeCombo(eventLike): Combo`
- Produces: `PageSlashCore.comboMatches(eventLike, combo): boolean`
- Produces: `PageSlashCore.formatCombo(combo): string`

- [ ] **Step 1: Add failing combo and unlock tests**

```javascript
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
  assert.deepEqual(Core.unlockSwords(22000), ['iron', 'thunder', 'frost', 'crimson', 'meteor', 'void']);
});

test('normalizes and formats key combinations', () => {
  const combo = Core.normalizeCombo({ key: 'S', code: 'KeyS', altKey: true, shiftKey: true });
  assert.equal(Core.formatCombo(combo), 'Alt + Shift + S');
  assert.equal(Core.comboMatches({ key: 's', code: 'KeyS', altKey: true, shiftKey: true }, combo), true);
  assert.equal(Core.normalizeCombo({ key: 's', code: 'KeyS' }), null);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- --test-name-pattern="increases combo|unlocks swords|normalizes"`

Expected: FAIL because combo and unlock APIs do not exist.

- [ ] **Step 3: Implement combo and unlock behavior**

```javascript
const SWORDS = [
  { id: 'iron', name: '铁刃', threshold: 0, color: '#e8f2ff', trail: '#94a3b8', tone: 520 },
  { id: 'thunder', name: '雷光', threshold: 800, color: '#fff7a8', trail: '#38bdf8', tone: 680 },
  { id: 'frost', name: '霜锋', threshold: 2500, color: '#e0fbff', trail: '#67e8f9', tone: 760 },
  { id: 'crimson', name: '赤霄', threshold: 6000, color: '#ffe0d8', trail: '#fb7185', tone: 420 },
  { id: 'meteor', name: '星陨', threshold: 12000, color: '#fff1c7', trail: '#f59e0b', tone: 340 },
  { id: 'void', name: '无相', threshold: 22000, color: '#ffffff', trail: '#a78bfa', tone: 260 }
];

function getComboMultiplier(combo) {
  return Math.min(3.5, 1 + Math.max(0, combo - 1) * 0.15);
}

function unlockSwords(lifetimeScore) {
  return SWORDS.filter((sword) => lifetimeScore >= sword.threshold).map((sword) => sword.id);
}

function normalizeCombo(eventLike) {
  const key = String(eventLike.key || '').toLowerCase();
  const hasModifier = eventLike.ctrlKey || eventLike.altKey || eventLike.shiftKey || eventLike.metaKey;
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
  return Boolean(combo)
    && String(eventLike.key).toLowerCase() === combo.key
    && String(eventLike.code) === combo.code
    && Boolean(eventLike.ctrlKey) === combo.ctrl
    && Boolean(eventLike.altKey) === combo.alt
    && Boolean(eventLike.shiftKey) === combo.shift
    && Boolean(eventLike.metaKey) === combo.meta;
}

function formatCombo(combo) {
  if (!combo) return '未设置';
  const keys = [];
  if (combo.ctrl) keys.push('Ctrl');
  if (combo.alt) keys.push('Alt');
  if (combo.shift) keys.push('Shift');
  if (combo.meta) keys.push('Meta');
  keys.push(combo.key.toUpperCase());
  return keys.join(' + ');
}
```

Also update `registerHit` to reset combo beyond 1500 ms and multiply score:

```javascript
const tier = getElementTier(Math.max(1, Number(area) || 1));
const key = String(Math.round(area));
const target = targetState || state.targets.get(key) || { hp: tier.hp, baseScore: tier.baseScore };
if (!targetState) state.targets.set(key, target);
const withinCombo = now - state.lastHitAt <= 1500;
state.combo = withinCombo ? state.combo + 1 : 1;
state.lastHitAt = now;
const multiplier = getComboMultiplier(state.combo);
target.hp = Math.max(0, target.hp - 1);
const broken = target.hp === 0;
const score = Math.round(
  (tier.baseScore / tier.hp + (broken ? tier.baseScore * 0.25 : 0)) * multiplier
);
```

- [ ] **Step 4: Re-run all core tests**

Run: `npm test`

Expected: PASS with 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core.js test/core.test.js
git commit -m "feat: add combo and sword progression"
```

### Task 3: DOM Hit-Testing Helpers

**Files:**
- Create: `src/dom.js`
- Create: `test/dom.test.js`

**Interfaces:**
- Produces: `PageSlashDom.getVisibleArea(element, viewport)`.
- Produces: `PageSlashDom.isEligibleElement(element, viewport, excluded)`.
- Produces: `PageSlashDom.chooseTarget(elements, viewport, excluded)`.
- Produces: `PageSlashDom.buildSlashSamples(center, angle, length, count)`.

- [ ] **Step 1: Write failing DOM helper tests**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const Dom = require('../src/dom.js');

function fakeElement(tagName, rect, depth = 0) {
  let parent = null;
  for (let i = 0; i < depth; i += 1) {
    parent = { parentElement: parent, getBoundingClientRect: () => rect };
  }
  return {
    tagName,
    parentElement: parent,
    getBoundingClientRect: () => rect,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } }
  };
}

test('clips visible area to the viewport', () => {
  const element = fakeElement('DIV', { left: -20, top: 0, right: 80, bottom: 100, width: 100, height: 100 });
  assert.equal(Dom.getVisibleArea(element, { width: 100, height: 100 }), 8000);
});

test('rejects html and body but accepts normal nested elements', () => {
  assert.equal(Dom.isEligibleElement(fakeElement('BODY', { left: 0, top: 0, right: 100, bottom: 100 }), { width: 100, height: 100 }, new Set()), false);
  assert.equal(Dom.isEligibleElement(fakeElement('DIV', { left: 5, top: 5, right: 50, bottom: 50 }, 2), { width: 100, height: 100 }, new Set()), true);
});

test('selects the deepest eligible candidate and builds a centered blade path', () => {
  const parent = fakeElement('DIV', { left: 0, top: 0, right: 100, bottom: 100 }, 0);
  const child = fakeElement('SPAN', { left: 20, top: 20, right: 80, bottom: 80 }, 1);
  assert.equal(Dom.chooseTarget([parent, child], { width: 100, height: 100 }, new Set()), child);
  assert.deepEqual(Dom.buildSlashSamples({ x: 50, y: 50 }, 0, 100, 2), [
    { x: 0, y: 50 },
    { x: 100, y: 50 }
  ]);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- --test-name-pattern="clips visible|rejects html|selects the deepest"`

Expected: FAIL because `src/dom.js` does not exist.

- [ ] **Step 3: Implement the DOM helpers**

```javascript
const EXCLUDED_TAGS = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD']);

function getVisibleArea(element, viewport) {
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.right);
  const bottom = Math.min(viewport.height, rect.bottom);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function isEligibleElement(element, viewport, excluded) {
  if (!element || excluded?.has(element) || EXCLUDED_TAGS.has(element.tagName)) return false;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.05) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  return getVisibleArea(element, viewport) >= 16;
}

function getDepth(element) {
  let depth = 0;
  for (let node = element; node; node = node.parentElement) depth += 1;
  return depth;
}

function chooseTarget(elements, viewport, excluded) {
  const candidates = elements.filter((element) => isEligibleElement(element, viewport, excluded));
  candidates.sort((a, b) => getDepth(b) - getDepth(a) || getVisibleArea(a, viewport) - getVisibleArea(b, viewport));
  return candidates[0] || null;
}

function buildSlashSamples(center, angle, length, count) {
  const dx = Math.cos(angle) * length / 2;
  const dy = Math.sin(angle) * length / 2;
  const start = { x: center.x - dx, y: center.y - dy };
  const end = { x: center.x + dx, y: center.y + dy };
  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? 0.5 : index / (count - 1);
    return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
  });
}

const api = { getVisibleArea, isEligibleElement, chooseTarget, buildSlashSamples };
globalThis.PageSlashDom = api;
if (typeof module === 'object' && module.exports) module.exports = api;
```

- [ ] **Step 4: Re-run DOM tests and the full suite**

Run: `npm test`

Expected: PASS with 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/dom.js test/dom.test.js
git commit -m "feat: add DOM hit-testing helpers"
```

### Task 4: Manifest, Overlay Shell, Popup, and Options

**Files:**
- Create: `manifest.json`
- Create: `src/overlay.css`
- Create: `popup/popup.html`
- Create: `popup/popup.css`
- Create: `popup/popup.js`
- Create: `options/options.html`
- Create: `options/options.css`
- Create: `options/options.js`
- Create: `tools/generate-icons.ps1`
- Create: `assets/icons/icon16.png`
- Create: `assets/icons/icon32.png`
- Create: `assets/icons/icon48.png`
- Create: `assets/icons/icon128.png`

**Interfaces:**
- Consumes: `PageSlashCore`, `PageSlashDom`.
- Produces messaging actions: `PAGE_SLASH_GET_STATE`, `PAGE_SLASH_TOGGLE`, `PAGE_SLASH_SETTINGS`, `PAGE_SLASH_STATE_CHANGED`.
- Produces storage keys: `lifetimeScore`, `customCombo`, `selectedSword`, `soundEnabled`.

- [ ] **Step 1: Create the manifest**

```json
{
  "manifest_version": 3,
  "name": "斩页 Page Slash",
  "version": "0.1.0",
  "description": "把网页元素当作目标，用鼠标剑刃斩击并累计得分。",
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["<all_urls>"],
  "action": { "default_popup": "popup/popup.html" },
  "options_ui": { "page": "options/options.html", "open_in_tab": true },
  "icons": {
    "16": "assets/icons/icon16.png",
    "32": "assets/icons/icon32.png",
    "48": "assets/icons/icon48.png",
    "128": "assets/icons/icon128.png"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/core.js", "src/dom.js", "src/content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["src/overlay.css"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

- [ ] **Step 2: Add the popup and option pages using the interfaces above**

`popup.js` must:

```javascript
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function requestState() {
  const tab = await getActiveTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_SLASH_GET_STATE' });
  } catch {
    return null;
  }
}
```

`options.js` uses this behavior:

```javascript
const recorder = document.querySelector('#combo-recorder');
const status = document.querySelector('#combo-status');

recorder.addEventListener('keydown', async (event) => {
  event.preventDefault();
  const combo = PageSlashCore.normalizeCombo(event);
  if (!combo) {
    status.textContent = '至少需要一个修饰键和一个主键';
    return;
  }
  await chrome.storage.local.set({ customCombo: combo });
  status.textContent = `已保存：${PageSlashCore.formatCombo(combo)}`;
});

async function loadCombo() {
  const { customCombo } = await chrome.storage.local.get('customCombo');
  const combo = customCombo || { key: 's', code: 'KeyS', ctrl: false, alt: true, shift: true, meta: false };
  status.textContent = `当前：${PageSlashCore.formatCombo(combo)}`;
}

loadCombo();
```

- [ ] **Step 3: Add the Shadow DOM CSS**

The stylesheet must define:

```css
:host {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  contain: layout style paint;
}

.slash-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.hud {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  gap: 16px;
  padding: 10px 14px;
  color: #f8fafc;
  background: rgb(5 10 20 / 78%);
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 8px;
  font: 600 14px/1 system-ui, sans-serif;
}
```

- [ ] **Step 4: Generate extension icons deterministically**

Create `tools/generate-icons.ps1`:

```powershell
Add-Type -AssemblyName System.Drawing
$root = Join-Path $PSScriptRoot '..\assets\icons'
New-Item -ItemType Directory -Force -Path $root | Out-Null
foreach ($size in 16, 32, 48, 128) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(12, 18, 30))
  $blade = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($size * 0.24, $size * 0.78),
    [System.Drawing.PointF]::new($size * 0.68, $size * 0.20),
    [System.Drawing.PointF]::new($size * 0.78, $size * 0.26),
    [System.Drawing.PointF]::new($size * 0.34, $size * 0.84)
  )
  $graphics.FillPolygon((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 232, 242, 255))), $blade)
  $trailPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 56, 189, 248), [Math]::Max(1, $size / 16))
  $graphics.DrawLine($trailPen, $size * 0.18, $size * 0.88, $size * 0.82, $size * 0.12)
  $path = Join-Path $root "icon$size.png"
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $trailPen.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
```

Run:

```powershell
pwsh -NoProfile -File tools/generate-icons.ps1
```

Expected dimensions: `16x16`, `32x32`, `48x48`, and `128x128`.

- [ ] **Step 5: Verify the unpacked extension loads**

Open `chrome://extensions`, enable Developer mode, choose “Load unpacked”, and select the repository root.

Expected: no manifest errors; popup and options pages open.

- [ ] **Step 6: Commit**

```bash
git add manifest.json src/overlay.css popup options tools assets/icons
git commit -m "feat: add extension shell and settings"
```

### Task 5: Mode Toggle, Sword Cursor, and Slash Rendering

**Files:**
- Create: `src/content.js`
- Modify: `test/manual/fixture.html`

**Interfaces:**
- Consumes: `PageSlashCore`, `PageSlashDom`, storage keys, and Shadow DOM stylesheet.
- Produces: `SlashApp.enterMode(): Promise<void>`
- Produces: `SlashApp.exitMode(): void`
- Produces: `SlashApp.slashAt(point, angle): void`

- [ ] **Step 1: Create the manual fixture before writing behavior**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>斩页测试场</title>
    <link rel="stylesheet" href="./fixture.css">
  </head>
  <body>
    <main>
      <h1>斩页测试场</h1>
      <button id="small">小按钮</button>
      <section id="medium">中等卡片</section>
      <div id="large">大型区域</div>
      <a id="link" href="https://example.com">不应被误触的链接</a>
      <div id="dynamic"></div>
    </main>
    <script src="./fixture.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement pointer and keyboard state**

```javascript
function handleKeydown(event) {
  if (!Core.comboMatches(event, settings.customCombo)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  modeActive ? exitMode() : enterMode();
}

function handlePointerMove(event) {
  const now = performance.now();
  pointerHistory.push({ x: event.clientX, y: event.clientY, time: now });
  pointerHistory = pointerHistory.filter((point) => now - point.time <= 100);
  cursorX = event.clientX;
  cursorY = event.clientY;
}

function getSlashAngle() {
  const first = pointerHistory[0];
  const last = pointerHistory.at(-1);
  if (!first || !last || Math.hypot(last.x - first.x, last.y - first.y) < 12) return Math.PI / 4;
  return Math.atan2(last.y - first.y, last.x - first.x);
}
```

- [ ] **Step 3: Create the Shadow DOM and Canvas render loop**

Use `host.attachShadow({ mode: 'closed' })`, append a link to `chrome.runtime.getURL('src/overlay.css')`, a Canvas, HUD, top status, and sword cursor. Use one `requestAnimationFrame` function that clears, draws the current sword trail and alive particles, then requests the next frame.

- [ ] **Step 4: Implement enter and exit**

`enterMode` loads settings, creates the Shadow host, registers capture-phase `keydown`, `mousemove`, `mousedown`, `click`, `auxclick`, and `contextmenu` listeners, and hides the native cursor. `exitMode` restores target elements, removes the host, cancels animation, clears listeners, and restores the native cursor.

- [ ] **Step 5: Implement click slashing**

On primary pointer down:

```javascript
if (event.button === 0) {
  event.preventDefault();
  event.stopImmediatePropagation();
  ensureAudio();
  slashAt({ x: event.clientX, y: event.clientY }, getSlashAngle());
}
```

On context menu in mode:

```javascript
event.preventDefault();
event.stopImmediatePropagation();
exitMode();
```

- [ ] **Step 6: Manually verify the mode shell**

Load the fixture in Chrome with the extension enabled. Toggle with `Alt+Shift+S`, move the pointer to verify the sword cursor, click to verify the blade trail, and right-click to exit.

- [ ] **Step 7: Commit**

```bash
git add src/content.js test/manual
git commit -m "feat: add slash mode and sword cursor"
```

### Task 6: Hit Detection, Damage, Destruction, and Restoration

**Files:**
- Modify: `src/content.js`
- Modify: `src/overlay.css`
- Modify: `test/manual/fixture.html`
- Modify: `test/manual/fixture.js`

**Interfaces:**
- Consumes: `PageSlashCore.registerHit`, `PageSlashCore.getElementTier`, `PageSlashDom.*`.
- Produces: `SlashApp.hitTargets(point, angle): void`
- Produces: `SlashApp.restoreBrokenElements(): void`

- [ ] **Step 1: Add fixture cases for nested and dynamically inserted elements**

Add CSS classes for small, medium, large, transparent, hidden, and removed elements. In `fixture.js`, append a new card every 2 seconds so dynamic hit testing can be exercised without observers.

- [ ] **Step 2: Implement target resolution**

```javascript
function hitTargets(point, angle) {
  if (performance.now() - lastSlashAt < 90) return;
  lastSlashAt = performance.now();
  const samples = Dom.buildSlashSamples(point, angle, 220, 14);
  const targets = new Map();
  for (const sample of samples) {
    const stack = document.elementsFromPoint(sample.x, sample.y);
    const target = Dom.chooseTarget(stack, { width: innerWidth, height: innerHeight }, excludedElements);
    if (target && !targets.has(target)) targets.set(target, target);
  }
  for (const target of targets.values()) damageTarget(target);
}
```

- [ ] **Step 3: Implement damage and score**

```javascript
function damageTarget(element) {
  const area = Dom.getVisibleArea(element, { width: innerWidth, height: innerHeight });
  const existing = elementStates.get(element);
  const state = existing || { hp: Core.getElementTier(area).hp, baseScore: Core.getElementTier(area).baseScore };
  elementStates.set(element, state);
  const result = Core.registerHit(gameState, area, performance.now(), state);
  updateHud();
  spawnHitEffects(element, result.hit);
  if (state.hp <= 0) breakElement(element);
}
```

`elementStates` must be a `WeakMap<Element, { hp, baseScore }>`; no identifier is written onto the page element.

- [ ] **Step 4: Implement break, restore, and URL reset**

Before hiding an element, capture `element.getAttribute('style')` in a `WeakMap`. Add it to a `Set`, animate opacity and scale for 180 ms, then set `visibility: hidden` and `pointer-events: none`.

On `exitMode`, `popstate`, `hashchange`, or URL change detected by a 1-second comparison timer, restore every live element’s original `style` attribute, reset `pageScore` and target state, and update the HUD. Catch `SecurityError` and continue.

- [ ] **Step 5: Add particles, sparks, shards, sound, and reduced motion**

Cap active particles at 240. When `matchMedia('(prefers-reduced-motion: reduce)').matches` is true, draw no shake and use at most 12 particles per event.

- [ ] **Step 6: Manually verify all hit cases**

In the fixture verify: small objects break in one hit; medium objects require two; large objects require more; nested children win over their parents; links do not navigate; hidden elements cannot be hit; dynamic elements work; right-click and refresh restore every hidden element.

- [ ] **Step 7: Commit**

```bash
git add src/content.js src/overlay.css test/manual
git commit -m "feat: add hit detection and element destruction"
```

### Task 7: Popup State, Sword Selection, and Final Verification

**Files:**
- Modify: `popup/popup.js`
- Modify: `popup/popup.css`
- Modify: `src/content.js`
- Create: `test/manual/checklist.md`

**Interfaces:**
- Consumes: all extension messages and storage keys.
- Produces: working end-to-end extension with no uncommitted generated assets.

- [ ] **Step 1: Connect popup score and mode updates**

When the popup opens, request `PAGE_SLASH_GET_STATE`; display the page score, lifetime score, current mode, and sound state. Subscribe to `PAGE_SLASH_STATE_CHANGED` only while the popup is open.

- [ ] **Step 2: Connect sword selection**

Render all six swords. Locked swords show the threshold and cannot be selected. Selecting an unlocked sword writes `selectedSword`, sends `PAGE_SLASH_SETTINGS`, and updates the popup preview.

- [ ] **Step 3: Run automated verification**

Run: `npm test`

Expected: all core and DOM tests pass with no warnings.

- [ ] **Step 4: Run extension verification**

Load the unpacked extension in Chrome and execute `test/manual/checklist.md`.

Expected:

- Mode toggles on `Alt+Shift+S`.
- Right-click exits.
- Links and buttons are not activated by slashes.
- Small, large, nested, and dynamic targets behave correctly.
- Page score resets after reload or URL change.
- Lifetime score persists and unlocks swords at thresholds.
- All six swords change cursor, trail, sparks, and sound.
- Exit and refresh restore hidden elements.
- No console errors on three different ordinary websites.

- [ ] **Step 5: Commit**

```bash
git add popup src/content.js test/manual/checklist.md
git commit -m "feat: complete page slash extension"
```

### Task 8: Documentation and Release Check

**Files:**
- Modify: `README.md`
- Create: `docs/manual-testing.md`

**Interfaces:**
- Produces: installation and testing instructions for a new developer.

- [ ] **Step 1: Update README**

Document installation, `Alt+Shift+S`, right-click exit, scoring, lifetime progression, sword unlocks, supported pages, platform restrictions, and the absence of a leaderboard in phase one.

- [ ] **Step 2: Add manual testing instructions**

Document how to load the unpacked extension, open `test/manual/fixture.html`, run each game action, and verify restoration and storage behavior.

- [ ] **Step 3: Run final checks**

Run: `npm test`

Run: `git status --short`

Expected: tests pass and only documentation files are modified.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/manual-testing.md
git commit -m "docs: add extension usage and testing guide"
```
