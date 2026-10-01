(function initOptions() {
  'use strict';

  const Core = globalThis.PageSlashCore;
  const DEFAULT_COMBO = {
    key: 's',
    code: 'KeyS',
    ctrl: false,
    alt: true,
    shift: true,
    meta: false
  };

  const recorder = document.querySelector('#combo-recorder');
  const comboValue = document.querySelector('#combo-value');
  const status = document.querySelector('#combo-status');
  const resetButton = document.querySelector('#reset-combo');

  function renderCombo(combo, message) {
    const formatted = Core.formatCombo(combo);
    comboValue.textContent = formatted;
    status.textContent = message || `当前：${formatted}`;
  }

  async function saveCombo(combo, message) {
    await chrome.storage.local.set({ customCombo: combo });
    renderCombo(combo, message);
  }

  recorder.addEventListener('keydown', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      recorder.blur();
      return;
    }

    const combo = Core.normalizeCombo(event);
    if (!combo) {
      status.textContent = '至少需要一个修饰键和一个主键';
      return;
    }

    await saveCombo(combo, `已保存：${Core.formatCombo(combo)}`);
  });

  resetButton.addEventListener('click', async () => {
    await saveCombo(DEFAULT_COMBO, '已恢复默认快捷键');
  });

  async function loadCombo() {
    const { customCombo } = await chrome.storage.local.get('customCombo');
    renderCombo(customCombo || DEFAULT_COMBO);
  }

  loadCombo();
})();
