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
    // The scrollable container holding the message list.
    scroller: '.c-virtual_list__scroll_container, [data-qa="slack_kit_list"], [data-qa="message_pane"] .c-scrollbar__hider',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Query Slack's own DOM only, never anything inside our injected panel.
  function slackQuery(doc, selector) {
    for (const node of doc.querySelectorAll(selector)) {
      if (!node.closest('#slack-cleaner')) return node;
    }
    return null;
  }

  // The web client's own session for the open workspace: the xoxc token, the
  // workspace API base (e.g. https://acme.slack.com/) and the signed-in user id.
  // Slack keeps these in localStorage.localConfig_v2, keyed by team id. The
  // token is only ever sent back to Slack's own API, never stored or shared.
  function readSession(doc = document) {
    try {
      const win = doc.defaultView;
      const cfg = JSON.parse(win.localStorage.getItem('localConfig_v2') || 'null');
      const teams = (cfg && cfg.teams) || {};
      const teamId =
        (win.location.pathname.match(/\/client\/([A-Z0-9]+)/) || [])[1] || cfg?.lastActiveTeamId;
      const team = teams[teamId] || Object.values(teams)[0];
      if (!team || !team.token) return null;
      const apiBase = (team.url || 'https://app.slack.com/').replace(/\/?$/, '/');
      return { token: team.token, apiBase, userId: team.user_id || '', teamId: team.id || teamId };
    } catch {
      return null;
    }
  }

  // Who is signed in. Returns { id, name } best-effort; name may be empty.
  function readSelf(doc = document) {
    const btn = doc.querySelector(SEL.selfButton);
    const label = btn?.getAttribute('aria-label') || btn?.getAttribute('data-qa-username') || '';
    // aria-label is usually "User menu: <name>" or just the name.
    const name = label.replace(/^[^:]*:\s*/, '').trim();
    const id =
      btn?.getAttribute('data-member-id') ||
      doc.body?.getAttribute('data-member-id') ||
      readSession(doc)?.userId ||
      '';
    return { id, name };
  }

  // The channel id and ts chat.delete needs. The timestamp link's href is
  // ".../archives/<channel>/p<ts without the dot>", which works for channels,
  // DMs and threads alike; the URL's channel and the row id are fallbacks.
  function messageRef(el, doc = document) {
    let channel = '';
    let ts = '';
    for (const a of el.querySelectorAll('a[href*="/archives/"]')) {
      const m = a.getAttribute('href').match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
      if (m) {
        channel = m[1];
        ts = `${m[2]}.${m[3]}`;
        break;
      }
    }
    if (!ts) {
      const raw = el.querySelector(SEL.ts)?.getAttribute('data-ts') || messageId(el);
      ts = (raw.match(/\d{10}\.\d{6}/) || [''])[0];
    }
    if (!channel) {
      const path = doc.defaultView?.location?.pathname || '';
      channel = (path.match(/\/client\/[A-Z0-9]+\/([A-Z0-9]+)/) || [])[1] || '';
    }
    return channel && ts ? { channel, ts } : null;
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

  // Delete one message the way Slack's own client does: POST chat.delete with
  // the session token (the request you see in DevTools when you delete by
  // hand). Success is Slack's { ok: true }, not a DOM guess. Rate limits are
  // waited out and retried.
  async function deleteViaApi(node, doc = document, { fetchImpl, session, retries = 3 } = {}) {
    session = session || readSession(doc);
    if (!session) return { ok: false, error: 'no_session' };
    const ref = messageRef(node, doc);
    if (!ref) return { ok: false, error: 'no_message_ref' };
    const doFetch = fetchImpl || doc.defaultView.fetch.bind(doc.defaultView);

    for (let attempt = 0; ; attempt++) {
      const body = new (doc.defaultView.FormData || FormData)();
      body.append('token', session.token);
      body.append('channel', ref.channel);
      body.append('ts', ref.ts);
      let res;
      let data;
      try {
        res = await doFetch(`${session.apiBase}api/chat.delete`, {
          method: 'POST',
          body,
          credentials: 'include',
        });
        data = await res.json();
      } catch (e) {
        // The request usually reaches Slack and the delete happens even when
        // the browser can't read the reply ("Failed to fetch"). Confirm it the
        // way a person would: the row disappears once Slack processes it.
        if (await waitFor(() => !doc.contains(node), { timeout: 5000, interval: 150 })) {
          return { ok: true, note: 'confirmed by UI' };
        }
        return { ok: false, error: `network: ${(e && e.message) || e}` };
      }
      if (data && data.ok) return { ok: true };
      const error = (data && data.error) || `http_${res.status}`;
      if (error === 'message_not_found') return { ok: true, note: 'already gone' };
      if ((error === 'ratelimited' || res.status === 429) && attempt < retries) {
        const wait = Number(res.headers?.get?.('Retry-After')) || 2;
        await sleep(wait * 1000);
        continue;
      }
      return { ok: false, error };
    }
  }

  // Prefer the API (reliable); fall back to clicking through the menu only if
  // the session can't be read.
  async function deleteMessage(node, doc = document, opts = {}) {
    if (readSession(doc)) return deleteViaApi(node, doc, opts);
    return deleteViaMenu(node, doc);
  }

  // The message list's scroll container. Several elements can match; prefer
  // one that actually scrolls.
  function getScroller(doc = document) {
    const all = [...doc.querySelectorAll(SEL.scroller)].filter((n) => !n.closest('#slack-cleaner'));
    return all.find((n) => n.scrollHeight > n.clientHeight + 1) || all[0] || null;
  }

  function firstMessageId(doc = document) {
    const el = doc.querySelector(SEL.message);
    return el ? messageId(el) : null;
  }

  // Jiggle the list at the top so Slack's "load older" trigger fires again:
  // step down a little, then back up, with a wheel event like a real scroll.
  async function nudgeTop(scroller, doc) {
    const win = doc.defaultView;
    scroller.scrollTop = Math.min(120, scroller.scrollHeight);
    await sleep(120);
    scroller.scrollTop = 0;
    if (win && win.WheelEvent) {
      scroller.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    }
  }

  // Clear the signed-in user's messages across a whole conversation: start at
  // the bottom (newest), delete every message of theirs that's rendered, scroll
  // up to load older ones, and repeat until the top is reached or nothing new
  // loads. Slack virtualises the list, so deleting what's on screen and then
  // scrolling is the reliable way to walk the full history.
  async function autoClear(doc = document, opts = {}) {
    const {
      onProgress = () => {},
      shouldStop = () => false,
      deleteOne = (node) => deleteMessage(node, doc),
      gap = 1200,
      scrollPause = 700,
      maxRounds = 600,
      maxIdle = 3, // rounds with no deletes and no new messages before stopping
      loadTimeout = 6000, // how long to wait for Slack to fetch older history at the top
      topRetries = 2, // extra nudges at the top before deciding it's really the start
    } = opts;

    let scroller = getScroller(doc);
    let total = 0;
    let failed = 0;
    let idle = 0;
    const problems = [];
    // An API delete returns before Slack's client removes the row, so remember
    // what's been handled to avoid counting it twice on the next scan.
    const handled = new Set();

    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight; // begin at the newest message
      await sleep(scrollPause);
    }

    for (let round = 0; round < maxRounds; round++) {
      if (shouldStop()) break;

      const { messages } = scanMessages(doc);
      const mine = messages.filter((m) => m.isMine && m.node && doc.contains(m.node) && !handled.has(m.id));
      let deletedThisRound = 0;
      for (const m of mine) {
        if (shouldStop()) break;
        handled.add(m.id);
        let res;
        try {
          res = await deleteOne(m.node);
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) };
        }
        total += 1;
        if (res.ok) deletedThisRound += 1;
        else {
          failed += 1;
          problems.push(`${(m.text || m.id).slice(0, 40)}: ${res.error}`);
        }
        onProgress({ total, failed, phase: 'deleting' });
        await sleep(gap);
      }

      if (shouldStop()) break;
      // Slack can swap the list element (e.g. after a re-render); re-find it.
      if (!scroller || !doc.contains(scroller)) scroller = getScroller(doc);
      if (!scroller) break;

      // Load older messages by scrolling up.
      const prevTop = scroller.scrollTop;
      const prevFirst = firstMessageId(doc);
      const step = Math.max(300, Math.floor(scroller.clientHeight * 0.8));
      scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
      onProgress({ total, failed, phase: 'scrolling' });
      await sleep(scrollPause);

      const scrolled = scroller.scrollTop < prevTop - 1;
      let loadedNew = firstMessageId(doc) !== prevFirst;

      // At the top, Slack fetches older history over the network and shows a
      // spinner first, so a short pause isn't enough. Wait for new rows, and
      // nudge the scroll a couple of times, before deciding it's the start.
      if (!loadedNew && scroller.scrollTop <= 1) {
        onProgress({ total, failed, phase: 'loading' });
        const height = scroller.scrollHeight;
        const changed = () => firstMessageId(doc) !== prevFirst || scroller.scrollHeight !== height;
        for (let i = 0; i <= topRetries && !loadedNew && !shouldStop(); i++) {
          if (i > 0) await nudgeTop(scroller, doc);
          loadedNew = Boolean(await waitFor(changed, { timeout: loadTimeout / (topRetries + 1), interval: 150 }));
        }
      }

      const progressed = deletedThisRound > 0 || scrolled || loadedNew;
      idle = progressed ? 0 : idle + 1;

      if (scroller.scrollTop <= 1 && !loadedNew && deletedThisRound === 0) break; // at the top, nothing left
      if (idle >= maxIdle) break; // stuck (can't scroll, nothing deleting)
    }

    return { total, failed, problems, reachedTop: scroller ? scroller.scrollTop <= 1 : true };
  }

  const api = { SEL, readSession, readSelf, messageRef, deleteViaApi, deleteMessage, parseMessage, scanMessages, deleteViaMenu, messageId, getScroller, firstMessageId, autoClear, sleep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SlackCleanerUI = api;
})(typeof window !== 'undefined' ? window : null);
