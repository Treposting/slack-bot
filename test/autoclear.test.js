const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

// Simulate Slack's virtualised message list: only a window of the newest
// messages is in the DOM, scrolling up loads older ones (prepended at the top,
// since Slack shows oldest at top / newest at bottom), and deleting a message
// removes just that node. This lets autoClear be exercised end to end.
function buildVirtualDom(messages, { windowSize = 3 } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <button data-qa="user-button" aria-label="User menu: Me" data-member-id="U_ME"></button>
      <div class="c-virtual_list__scroll_container" id="scroller"></div>
    </body></html>`,
    { url: 'https://app.slack.com/client/T1/C1', pretendToBeVisual: true }
  );
  const { document } = dom.window;
  const M = messages.slice(); // M[0] oldest … M[last] newest
  const scroller = document.getElementById('scroller');
  let oldestLoaded = Math.max(0, M.length - windowSize);
  let top = 0;

  Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', {
    get: () => scroller.children.length * 40,
    configurable: true,
  });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v) => {
      let clamped = Math.max(0, Math.min(v, scroller.scrollHeight));
      // Reaching the top loads an older message; the prepended content grows
      // above the viewport, so the scroll position is pushed back down off 0.
      if (clamped <= 0 && oldestLoaded > 0) {
        oldestLoaded -= 1;
        scroller.insertBefore(nodeFor(M[oldestLoaded]), scroller.firstChild);
        clamped = 40;
      }
      top = clamped;
    },
    configurable: true,
  });

  function nodeFor(m) {
    const el = document.createElement('div');
    el.setAttribute('data-qa', 'message_container');
    el.setAttribute('data-item-key', m.id);
    el.innerHTML =
      `<a data-qa="message_sender_name" data-message-sender="${m.author}">name</a>` +
      `<span class="c-timestamp" data-ts="${m.id}"></span>` +
      `<div data-qa="message-text">${m.text || ''}</div>` +
      `<button data-qa="more_message_actions">⋯</button>`;
    return el;
  }

  for (let i = oldestLoaded; i < M.length; i++) scroller.appendChild(nodeFor(M[i]));

  // Delegated menu → delete → confirm that removes just the clicked message.
  document.addEventListener('click', (e) => {
    const more = e.target.closest && e.target.closest('[data-qa="more_message_actions"]');
    if (!more) return;
    const row = more.closest('[data-qa="message_container"]');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.innerHTML = '<button data-qa="delete_message">Delete message…</button>';
    menu.querySelector('button').addEventListener('click', () => {
      menu.remove();
      const dlg = document.createElement('div');
      dlg.setAttribute('role', 'dialog');
      dlg.innerHTML = '<button data-qa="dialog_go">Delete</button>';
      dlg.querySelector('button').addEventListener('click', () => {
        row.remove();
        dlg.remove();
      });
      document.body.appendChild(dlg);
    });
    document.body.appendChild(menu);
  });

  dom.window.MouseEvent = dom.window.MouseEvent;
  top = scroller.scrollHeight; // start at the bottom, like a real chat
  return dom;
}

function loadUI() {
  delete require.cache[require.resolve('../extension/slack-ui')];
  global.window = undefined;
  return require('../extension/slack-ui');
}

const mk = (id, mine, text) => ({ id: `${id}.000`, author: mine ? 'U_ME' : 'U_OTHER', text });

test('autoClear walks to the top and deletes only my messages', async () => {
  const msgs = [
    mk(1000, true, 'oldest mine'),
    mk(1001, false, 'theirs'),
    mk(1002, true, 'mine 2'),
    mk(1003, true, 'mine 3'),
    mk(1004, false, 'theirs 2'),
    mk(1005, true, 'mine 4'),
    mk(1006, true, 'newest mine'),
  ];
  const dom = buildVirtualDom(msgs, { windowSize: 2 });
  global.MouseEvent = dom.window.MouseEvent;
  const UI = loadUI();

  const res = await UI.autoClear(dom.window.document, { gap: 0, scrollPause: 0 });

  assert.strictEqual(res.failed, 0);
  assert.strictEqual(res.total, 5); // the five U_ME messages
  assert.strictEqual(res.reachedTop, true);
  const left = [...dom.window.document.querySelectorAll('[data-qa="message_container"]')];
  assert.deepStrictEqual(left.map((n) => n.getAttribute('data-item-key')), ['1001.000', '1004.000']);
});

test('autoClear stops promptly when asked', async () => {
  const msgs = Array.from({ length: 10 }, (_, i) => mk(2000 + i, true, `m${i}`));
  const dom = buildVirtualDom(msgs, { windowSize: 3 });
  global.MouseEvent = dom.window.MouseEvent;
  const UI = loadUI();

  let calls = 0;
  const res = await UI.autoClear(dom.window.document, {
    gap: 0,
    scrollPause: 0,
    shouldStop: () => ++calls > 2, // stop after the first couple of deletes
  });
  assert.ok(res.total < 10, `expected to stop early, deleted ${res.total}`);
  assert.ok(dom.window.document.querySelectorAll('[data-qa="message_container"]').length > 0);
});

test('getScroller and firstMessageId read the list', () => {
  const dom = buildVirtualDom([mk(1, true, 'a'), mk(2, true, 'b')], { windowSize: 2 });
  const UI = loadUI();
  assert.ok(UI.getScroller(dom.window.document));
  assert.strictEqual(UI.firstMessageId(dom.window.document), '1.000');
});
