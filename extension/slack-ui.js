// Everything that knows about Slack's web DOM lives here. The selectors are
// grouped at the top because Slack changes its markup from time to time; if
// scanning or deleting stops working, this is the place to adjust.
(function (root) {
  const SEL = {
    message: '[data-qa="message_container"]',
    virtualItem: '[data-qa="virtual-list-item"]',
    senderName: '[data-qa="message_sender_name"]',
    senderButton: '[data-message-sender]',
    text: '[data-qa="message-text"]',
    ts: '.c-timestamp',
    moreActions: '[data-qa="more_message_actions"]',
    menu: '[data-qa="menu_items"], [role="menu"]',
    deleteItem: '[data-qa="delete_message"]',
    confirmDialog: '[data-qa="dialog"], .c-sk-modal, [role="dialog"]',
    // The currently signed-in member, from the account switcher / avatar button.
    selfButton: '[data-qa="user-button"], [data-qa="current_user_button"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Query Slack's own DOM only, never anything inside our injected panel.
  function slackQuery(doc, selector) {
    for (const node of doc.querySelectorAll(selector)) {
      if (!node.closest('#slack-cleaner')) return node;
    }
    return null;
  }

  // Who is signed in. Returns { id, name } best-effort; name may be empty.
  function readSelf(doc = document) {
    const btn = doc.querySelector(SEL.selfButton);
    const label = btn?.getAttribute('aria-label') || btn?.getAttribute('data-qa-username') || '';
    // aria-label is usually "User menu: <name>" or just the name.
    const name = label.replace(/^[^:]*:\s*/, '').trim();
    const id = btn?.getAttribute('data-member-id') || doc.body?.getAttribute('data-member-id') || '';
    return { id, name };
  }

  // Pull the stable message id (the channel/ts pair Slack puts on the node).
  function messageId(el) {
    return (
      el.getAttribute('data-item-key') ||
      el.getAttribute('id') ||
      el.querySelector('[id^="message-list_"]')?.getAttribute('id') ||
      el.querySelector(SEL.ts)?.getAttribute('data-ts') ||
      ''
    );
  }

  // Extract a plain record from one message element. Pure DOM reads, so it can
  // be exercised in tests with a constructed element.
  function parseMessage(el, self) {
    const senderEl = el.querySelector(SEL.senderName) || el.querySelector(SEL.senderButton);
    const author = (senderEl?.textContent || '').trim();
    const authorId =
      senderEl?.getAttribute('data-message-sender') ||
      senderEl?.getAttribute('data-member-id') ||
      '';
    const text = (el.querySelector(SEL.text)?.textContent || '').trim();
    const ts = el.querySelector(SEL.ts)?.getAttribute('data-ts') || '';

    // A message is "mine" when its author matches the signed-in member by id,
    // or by name when ids aren't exposed. Grouped (consecutive) messages omit
    // the sender, so they inherit from the previous message in scanMessages.
    let isMine = null;
    if (author || authorId) {
      isMine =
        (self.id && authorId && authorId === self.id) ||
        (self.name && author && author === self.name) ||
        false;
    }
    return { id: messageId(el), author, authorId, text, ts, isMine };
  }

  // Walk the rendered message list top to bottom. Slack virtualises the list,
  // so this only sees what's currently scrolled into view.
  function scanMessages(doc = document) {
    const self = readSelf(doc);
    const els = [...doc.querySelectorAll(SEL.message)];
    const out = [];
    let lastAuthor = null;
    let lastMine = false;
    for (const el of els) {
      const rec = parseMessage(el, self);
      if (rec.isMine === null) {
        // Grouped message with no repeated sender: belongs to the one above.
        rec.author = lastAuthor;
        rec.isMine = lastMine;
      } else {
        lastAuthor = rec.author;
        lastMine = rec.isMine;
      }
      if (!rec.id) continue;
      rec.node = el;
      out.push(rec);
    }
    return { self, messages: out };
  }

  function findByText(container, selector, text) {
    for (const node of container.querySelectorAll(selector)) {
      if ((node.textContent || '').trim().toLowerCase().startsWith(text.toLowerCase())) return node;
    }
    return null;
  }

  async function waitFor(fn, { timeout = 4000, interval = 60 } = {}) {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }

  // Delete one message by driving the same menu a person would use:
  // hover -> "More actions" -> "Delete message…" -> confirm. Never assumes
  // success: it waits for the row to actually leave the DOM.
  async function deleteViaMenu(node, doc = document) {
    if (!doc.contains(node)) return { ok: true, note: 'already gone' };

    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const more = node.querySelector(SEL.moreActions);
    if (!more) return { ok: false, error: 'no_actions_menu' };
    more.click();

    const menu = await waitFor(() => slackQuery(doc, SEL.menu));
    if (!menu) return { ok: false, error: 'menu_did_not_open' };

    const del =
      menu.querySelector(SEL.deleteItem) ||
      findByText(menu, '[role="menuitem"], button, a', 'delete');
    if (!del) {
      doc.body.click(); // close the menu
      return { ok: false, error: 'no_delete_option' };
    }
    del.click();

    const dialog = await waitFor(() => slackQuery(doc, SEL.confirmDialog));
    if (!dialog) return { ok: false, error: 'confirm_did_not_open' };
    const confirm =
      dialog.querySelector('[data-qa="dialog_go"]') ||
      findByText(dialog, 'button', 'delete');
    if (!confirm) return { ok: false, error: 'no_confirm_button' };
    confirm.click();

    const gone = await waitFor(() => !doc.contains(node));
    return gone ? { ok: true } : { ok: false, error: 'still_present' };
  }

  const api = { SEL, readSelf, parseMessage, scanMessages, deleteViaMenu, messageId, sleep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SlackCleanerUI = api;
})(typeof window !== 'undefined' ? window : null);
