import { test } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import * as UI from '../src/slack-ui.ts';

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

function message(senderId: string, senderName: string, ts: string, text: string, showSender: boolean) {
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

test('readSelf pulls the signed-in member from the user button', () => {
  const { window } = buildDom();
  const self = UI.readSelf(window.document);
  assert.strictEqual(self.id, 'U_ME');
  assert.strictEqual(self.name, 'Nahid Hassan');
});

test('scanMessages flags mine, inherits author for grouped messages', () => {
  const { window } = buildDom();
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
  const { document } = window;

  const node = document.querySelector('[data-qa="message_container"]')!;
  // Wire up a fake Slack menu + confirm dialog that actually removes the node.
  document.querySelector('[data-qa="more_message_actions"]')!.addEventListener('click', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.innerHTML = '<button data-qa="delete_message">Delete message…</button>';
    menu.querySelector('button')!.addEventListener('click', () => {
      const dlg = document.createElement('div');
      dlg.setAttribute('role', 'dialog');
      dlg.innerHTML = '<button data-qa="dialog_go">Delete</button>';
      dlg.querySelector('button')!.addEventListener('click', () => node.remove());
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
  const node = window.document.querySelector('[data-qa="message_container"]')!;
  node.querySelector('[data-qa="more_message_actions"]')!.remove();
  const res = await UI.deleteViaMenu(node, window.document);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'no_actions_menu');
});

// A page whose localStorage holds the web client's session, the way Slack's
// own client keeps it, and whose message row carries the archive link.
function buildSessionDom() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-qa="message_container" data-item-key="1791298979.714889">
      <a data-qa="message_sender_name" data-message-sender="U_ME">Me</a>
      <a class="c-timestamp" data-ts="1791298979.714889"
         href="https://acme.slack.com/archives/D09Q8BVA9N0/p1791298979714889"></a>
      <div data-qa="message-text">bye</div>
    </div>
  </body></html>`, { url: 'https://app.slack.com/client/T07446WQEJD/D09Q8BVA9N0' });
  dom.window.localStorage.setItem('localConfig_v2', JSON.stringify({
    teams: { T07446WQEJD: { id: 'T07446WQEJD', token: 'xoxc-test', url: 'https://acme.slack.com/', user_id: 'U_ME' } },
  }));
  return dom;
}

interface FakeResponse {
  status?: number;
  retryAfter?: string;
  body: { ok: boolean; error?: string; channel?: string; ts?: string };
}

function fakeFetch(responses: FakeResponse[]) {
  const calls: { url: string; fields: Record<string, unknown>; credentials?: RequestCredentials }[] = [];
  const fn: UI.FetchLike = async (url, init) => {
    calls.push({ url, fields: Object.fromEntries((init.body as FormData).entries()), credentials: init.credentials });
    const r = responses.shift()!;
    return { status: r.status || 200, headers: { get: () => r.retryAfter }, json: async () => r.body };
  };
  return Object.assign(fn, { calls });
}

test('readSession and messageRef find what chat.delete needs', () => {
  const { window } = buildSessionDom();
  const s = UI.readSession(window.document);
  assert.deepStrictEqual(s, { token: 'xoxc-test', apiBase: 'https://acme.slack.com/', userId: 'U_ME', teamId: 'T07446WQEJD' });
  const node = window.document.querySelector('[data-qa="message_container"]')!;
  assert.deepStrictEqual(UI.messageRef(node, window.document), { channel: 'D09Q8BVA9N0', ts: '1791298979.714889' });
});

test('deleteViaApi posts chat.delete like the Slack client', async () => {
  const { window } = buildSessionDom();
  const node = window.document.querySelector('[data-qa="message_container"]')!;
  const fetchImpl = fakeFetch([{ body: { ok: true, channel: 'D09Q8BVA9N0', ts: '1791298979.714889' } }]);
  const res = await UI.deleteViaApi(node, window.document, { fetchImpl });
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(fetchImpl.calls[0].url, 'https://acme.slack.com/api/chat.delete');
  assert.strictEqual(fetchImpl.calls[0].credentials, 'include');
  assert.deepStrictEqual(fetchImpl.calls[0].fields, { token: 'xoxc-test', channel: 'D09Q8BVA9N0', ts: '1791298979.714889' });
});

test('deleteViaApi retries on ratelimited and surfaces Slack errors', async () => {
  const { window } = buildSessionDom();
  const node = window.document.querySelector('[data-qa="message_container"]')!;
  const fetchImpl = fakeFetch([
    { status: 429, retryAfter: '0.01', body: { ok: false, error: 'ratelimited' } },
    { body: { ok: false, error: 'cant_delete_message' } },
  ]);
  const res = await UI.deleteViaApi(node, window.document, { fetchImpl });
  assert.deepStrictEqual(res, { ok: false, error: 'cant_delete_message' });
  assert.strictEqual(fetchImpl.calls.length, 2);
});

test('deleteViaApi treats "Failed to fetch" as done once the row disappears', async () => {
  const { window } = buildSessionDom();
  const node = window.document.querySelector('[data-qa="message_container"]')!;
  const fetchImpl: UI.FetchLike = async () => {
    setTimeout(() => node.remove(), 50); // Slack removes the row after deleting
    throw new TypeError('Failed to fetch');
  };
  const res = await UI.deleteViaApi(node, window.document, { fetchImpl });
  assert.deepStrictEqual(res, { ok: true, note: 'confirmed by UI' });
});
