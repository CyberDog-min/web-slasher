(function createDynamicFixture() {
  'use strict';

  const dynamicRoot = document.querySelector('#dynamic');
  let cardNumber = 0;

  function appendCard() {
    cardNumber += 1;

    const card = document.createElement('article');
    card.className = 'dynamic-card';

    const title = document.createElement('strong');
    title.textContent = `动态卡片 ${cardNumber}`;

    const copy = document.createElement('span');
    copy.textContent = '命中时即时读取，不需要页面观察器。';

    card.append(title, copy);
    dynamicRoot.prepend(card);

    while (dynamicRoot.children.length > 8) {
      dynamicRoot.lastElementChild.remove();
    }
  }

  appendCard();
  window.setInterval(appendCard, 2000);
})();
