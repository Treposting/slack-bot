const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

// Build a Slack-like page so the DOM-reading logic can be exercised without a
// real workspace. The markup mirrors the selectors in extension/slack-ui.js.
function buildDom({ withSender = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button data-qa="user-button" aria-label="User menu: Nahid Hassan" data-member-id="U_ME"></button>
    <div id="list">
      ${message('U_ME', 'Nahid Hassan', '1700000300.000100', 'my first message', withSender)}
      ${message('U_ME', 'Nahid Hassan', '1700000250.000100', 'grouped reply', false)}
      ${message('U_OTHER', 'Sara Khan', '1700000200.000100', 'their message', true)}
    </div>
  </body></html>`, { url: 'https://app.slack.com/client/T1/C1' });
  return dom;
}

function message(senderId, senderName, ts, text, showSender) {
  const sender = showSender
    ? `<a data-qa="message_sender_name" data-message-sender="${senderId}">${senderName}</a>`
    : '';
  return `<div data-qa="message_container" data-item-key="${ts}">
    ${sender}
    <span class="c-timestamp" data-ts="${ts}"></span>
    <div data-qa="message-text">${text}</div>
    <button data-qa="more_message_actions" aria-label="More actions"></button>
  </div>`;
}

function loadUI(window) {
  // Re-require the module against this window's globals.
  const path = require.resolve('../extension/slack-ui');
  delete require.cache[path];
  global.window = undefined;
  const mod = require('../extension/slack-ui');
  return mod;
}

test('readSelf pulls the signed-in member from the user button', () => {
  const { window } = buildDom();
  const UI = loadUI();
  const self = UI.readSelf(window.document);
  assert.strictEqual(self.id, 'U_ME');
  assert.strictEqual(self.name, 'Nahid Hassan');
});

test('scanMessages flags mine, inherits author for grouped messages', () => {
  const { window } = buildDom();
  const UI = loadUI();
  const { messages } = UI.scanMessages(window.document);
  assert.deepStrictEqual(
    messages.map((m) => ({ text: m.text, mine: m.isMine })),
    [
      { text: 'my first message', mine: true },
      { text: 'grouped reply', mine: true }, // inherited U_ME from the row above
      { text: 'their message', mine: false },
    ]
  );
});

test('deleteViaMenu drives the menu and resolves when the row is removed', async () => {
  const { window } = buildDom();
  const { document, MouseEvent } = window;
  global.MouseEvent = MouseEvent;
  const UI = loadUI();

  const node = document.querySelector('[data-qa="message_container"]');
  // Wire up a fake Slack menu + confirm dialog that actually removes the node.
  document.querySelector('[data-qa="more_message_actions"]').addEventListener('click', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.innerHTML = '<button data-qa="delete_message">Delete message…</button>';
    menu.querySelector('button').addEventListener('click', () => {
      const dlg = document.createElement('div');
      dlg.setAttribute('role', 'dialog');
      dlg.innerHTML = '<button data-qa="dialog_go">Delete</button>';
      dlg.querySelector('button').addEventListener('click', () => node.remove());
      document.body.appendChild(dlg);
    });
    document.body.appendChild(menu);
  });

  const res = await UI.deleteViaMenu(node, document);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(document.contains(node), false);
});

test('deleteViaMenu reports when the actions menu is missing', async () => {
  const { window } = buildDom();
  global.MouseEvent = window.MouseEvent;
  const UI = loadUI();
  const node = window.document.querySelector('[data-qa="message_container"]');
  node.querySelector('[data-qa="more_message_actions"]').remove();
  const res = await UI.deleteViaMenu(node, window.document);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'no_actions_menu');
});
