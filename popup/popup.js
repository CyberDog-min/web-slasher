(function initPopup() {
  'use strict';

  const Core = globalThis.PageSlashCore;
  const DEFAULTS = {
    lifetimeScore: 0,
    customCombo: {
      key: 's',
      code: 'KeyS',
      ctrl: false,
      alt: true,
      shift: true,
      meta: false
    },
    selectedSword: 'iron',
    soundEnabled: true
  };

  const elements = {
    modeToggle: document.querySelector('#mode-toggle'),
    pageScore: document.querySelector('#page-score'),
    lifetimeScore: document.querySelector('#lifetime-score'),
    progressLabel: document.querySelector('#progress-label'),
    progressFill: document.querySelector('#progress-fill'),
    swordList: document.querySelector('#sword-list'),
    soundToggle: document.querySelector('#sound-toggle'),
    soundLabel: document.querySelector('#sound-label'),
    openOptions: document.querySelector('#open-options'),
    pageNote: document.querySelector('#page-note')
  };

  let activeTab = null;
  let contentState = null;
  let settings = { ...DEFAULTS };

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function requestState() {
    if (!activeTab?.id) return null;
    try {
      return await chrome.tabs.sendMessage(activeTab.id, {
        type: 'PAGE_SLASH_GET_STATE'
      });
    } catch {
      return null;
    }
  }

  async function sendToPage(message) {
    if (!activeTab?.id) return false;
    try {
      await chrome.tabs.sendMessage(activeTab.id, message);
      return true;
    } catch {
      return false;
    }
  }

  function getSelectedSword(swords) {
    return swords.find((sword) => sword.id === settings.selectedSword) || swords[0];
  }

  function getNextSwordIndex(swords, lifetimeScore) {
    return swords.findIndex((sword) => sword.threshold > lifetimeScore);
  }

  function renderSwords(lifetimeScore, selectedSwordId) {
    const swords = Core.getSwords();
    elements.swordList.replaceChildren();

    for (const sword of swords) {
      const unlocked = lifetimeScore >= sword.threshold;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sword-card';
      button.disabled = !unlocked;
      button.setAttribute('aria-pressed', String(sword.id === selectedSwordId));
      button.style.setProperty('--sword-color', sword.color);
      button.style.setProperty('--sword-trail', sword.trail);
      button.dataset.swordId = sword.id;
      button.title = unlocked ? `选择${sword.name}` : `历史总分 ${sword.threshold} 解锁`;

      const mark = document.createElement('span');
      mark.className = 'sword-mark';
      mark.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('span');
      copy.className = 'sword-copy';

      const name = document.createElement('strong');
      name.textContent = sword.name;

      const status = document.createElement('small');
      status.textContent = unlocked ? '已解锁' : `${sword.threshold} 分解锁`;

      copy.append(name, status);
      button.append(mark, copy);
      elements.swordList.append(button);
    }
  }

  function renderState() {
    const swords = Core.getSwords();
    const lifetimeScore = Number(
      contentState?.lifetimeScore ?? settings.lifetimeScore
    ) || 0;
    const selectedSwordId = contentState?.selectedSword || settings.selectedSword;
    const selectedSword = getSelectedSword(swords);
    const nextSwordIndex = getNextSwordIndex(swords, lifetimeScore);
    const nextSword = nextSwordIndex >= 0 ? swords[nextSwordIndex] : null;
    const modeActive = Boolean(contentState?.active);

    elements.pageScore.textContent = contentState
      ? String(contentState.pageScore || 0)
      : '--';
    elements.lifetimeScore.textContent = String(lifetimeScore);
    elements.modeToggle.textContent = modeActive ? '退出模式' : '进入模式';
    elements.modeToggle.setAttribute('aria-pressed', String(modeActive));
    elements.modeToggle.disabled = !activeTab?.id || !contentState;
    elements.pageNote.hidden = Boolean(contentState);

    if (nextSword) {
      const previousThreshold = nextSwordIndex > 0
        ? swords[nextSwordIndex - 1].threshold
        : 0;
      const span = Math.max(1, nextSword.threshold - previousThreshold);
      const progress = Math.max(0, lifetimeScore - previousThreshold);
      const percentage = Math.min(100, Math.round(progress / span * 100));
      elements.progressLabel.textContent = `${nextSword.name} · ${lifetimeScore} / ${nextSword.threshold}`;
      elements.progressFill.style.width = `${percentage}%`;
    } else {
      elements.progressLabel.textContent = '全剑已解锁';
      elements.progressFill.style.width = '100%';
    }

    elements.soundToggle.setAttribute('aria-pressed', String(settings.soundEnabled));
    elements.soundLabel.textContent = settings.soundEnabled ? '音效开启' : '音效关闭';

    renderSwords(lifetimeScore, selectedSwordId);
  }

  async function refreshState() {
    contentState = await requestState();
    if (contentState) {
      settings = {
        ...settings,
        selectedSword: contentState.selectedSword || settings.selectedSword,
        soundEnabled: contentState.soundEnabled ?? settings.soundEnabled,
        lifetimeScore: contentState.lifetimeScore ?? settings.lifetimeScore
      };
    }
    renderState();
  }

  elements.modeToggle.addEventListener('click', async () => {
    await sendToPage({ type: 'PAGE_SLASH_TOGGLE' });
    await refreshState();
  });

  elements.swordList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-sword-id]');
    if (!button || button.disabled) return;

    settings.selectedSword = button.dataset.swordId;
    await chrome.storage.local.set({ selectedSword: settings.selectedSword });
    await sendToPage({
      type: 'PAGE_SLASH_SETTINGS',
      settings: { selectedSword: settings.selectedSword }
    });
    await refreshState();
  });

  elements.soundToggle.addEventListener('click', async () => {
    settings.soundEnabled = !settings.soundEnabled;
    await chrome.storage.local.set({ soundEnabled: settings.soundEnabled });
    await sendToPage({
      type: 'PAGE_SLASH_SETTINGS',
      settings: { soundEnabled: settings.soundEnabled }
    });
    await refreshState();
  });

  elements.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'PAGE_SLASH_STATE_CHANGED') return;
    if (sender.tab?.id && activeTab?.id && sender.tab.id !== activeTab.id) return;
    contentState = message.state;
    renderState();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }
    renderState();
  });

  async function initialize() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
    activeTab = await getActiveTab();
    await refreshState();
  }

  initialize();
})();
