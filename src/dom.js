(function initPageSlashDom(globalScope) {
  'use strict';

  const EXCLUDED_TAGS = new Set([
    'HTML',
    'BODY',
    'SCRIPT',
    'STYLE',
    'META',
    'LINK',
    'HEAD'
  ]);

  function getVisibleArea(element, viewport) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return 0;

    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewport.width, rect.right);
    const bottom = Math.min(viewport.height, rect.bottom);

    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  function isEligibleElement(element, viewport, excluded = new Set()) {
    if (!element || excluded.has(element) || EXCLUDED_TAGS.has(element.tagName)) {
      return false;
    }

    const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    if (Number.parseFloat(style.opacity) <= 0.05 || style.pointerEvents === 'none') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const width = Number.isFinite(rect.width) ? rect.width : rect.right - rect.left;
    const height = Number.isFinite(rect.height) ? rect.height : rect.bottom - rect.top;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width < 4 || height < 4) return false;

    return getVisibleArea(element, viewport) >= 16;
  }

  function getDepth(element) {
    let depth = 0;
    for (let node = element; node; node = node.parentElement) {
      depth += 1;
    }
    return depth;
  }

  function chooseTarget(elements, viewport, excluded = new Set()) {
    const candidates = elements.filter((element) => (
      isEligibleElement(element, viewport, excluded)
    ));

    candidates.sort((first, second) => (
      getDepth(second) - getDepth(first)
      || getVisibleArea(first, viewport) - getVisibleArea(second, viewport)
    ));

    return candidates[0] || null;
  }

  function buildSlashSamples(center, angle, length, count) {
    if (!Number.isFinite(count) || count <= 0) return [];

    const halfX = Math.cos(angle) * length / 2;
    const halfY = Math.sin(angle) * length / 2;
    const start = { x: center.x - halfX, y: center.y - halfY };
    const end = { x: center.x + halfX, y: center.y + halfY };

    return Array.from({ length: count }, (_, index) => {
      const ratio = count === 1 ? 0.5 : index / (count - 1);
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio
      };
    });
  }

  const api = Object.freeze({
    getVisibleArea,
    isEligibleElement,
    chooseTarget,
    buildSlashSamples
  });

  globalScope.PageSlashDom = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
