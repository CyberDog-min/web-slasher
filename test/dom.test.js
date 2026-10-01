const test = require('node:test');
const assert = require('node:assert/strict');
const Dom = require('../src/dom.js');

function fakeElement(tagName, rect, depth = 0) {
  let parent = null;
  for (let index = 0; index < depth; index += 1) {
    parent = {
      parentElement: parent,
      getBoundingClientRect: () => rect
    };
  }

  return {
    tagName,
    parentElement: parent,
    getBoundingClientRect: () => rect,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          pointerEvents: 'auto'
        })
      }
    }
  };
}

test('clips visible area to the viewport', () => {
  const element = fakeElement('DIV', {
    left: -20,
    top: 0,
    right: 80,
    bottom: 100,
    width: 100,
    height: 100
  });

  assert.equal(Dom.getVisibleArea(element, { width: 100, height: 100 }), 8000);
});

test('rejects html and body but accepts normal nested elements', () => {
  const viewport = { width: 100, height: 100 };
  const body = fakeElement('BODY', {
    left: 0,
    top: 0,
    right: 100,
    bottom: 100
  });
  const nested = fakeElement('DIV', {
    left: 5,
    top: 5,
    right: 50,
    bottom: 50
  }, 2);

  assert.equal(Dom.isEligibleElement(body, viewport, new Set()), false);
  assert.equal(Dom.isEligibleElement(nested, viewport, new Set()), true);
});

test('selects the deepest eligible candidate and builds a centered blade path', () => {
  const viewport = { width: 100, height: 100 };
  const parent = fakeElement('DIV', {
    left: 0,
    top: 0,
    right: 100,
    bottom: 100
  });
  const child = fakeElement('SPAN', {
    left: 20,
    top: 20,
    right: 80,
    bottom: 80
  }, 1);

  assert.equal(Dom.chooseTarget([parent, child], viewport, new Set()), child);
  assert.deepEqual(Dom.buildSlashSamples({ x: 50, y: 50 }, 0, 100, 2), [
    { x: 0, y: 50 },
    { x: 100, y: 50 }
  ]);
});
