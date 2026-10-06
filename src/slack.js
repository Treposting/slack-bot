// Thin client for the Slack Web API, acting as the signed-in user (xoxp- token).

const API_BASE = process.env.SLACK_API_BASE || 'https://slack.com/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SlackError extends Error {
  constructor(method, code) {
    super(`${method} failed: ${code}`);
    this.code = code;
  }
}

async function call(token, method, params = {}, { maxRetries = 5 } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body,
    });
    // Slack rate limits are per method; honour Retry-After and try again.
    if (res.status === 429 && attempt < maxRetries) {
      const wait = Number(res.headers.get('retry-after') || 1);
      await sleep(wait * 1000);
      continue;
    }
    const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
    if (!data.ok) throw new SlackError(method, data.error || `http_${res.status}`);
    return data;
  }
}

async function whoAmI(token) {
  const auth = await call(token, 'auth.test');
  return { userId: auth.user_id, user: auth.user, team: auth.team, teamId: auth.team_id, url: auth.url };
}

async function listConversations(token) {
  const channels = [];
  let cursor;
  do {
    const page = await call(token, 'users.conversations', {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    channels.push(...page.channels);
    cursor = page.response_metadata?.next_cursor;
  } while (cursor);

  // DMs only carry the other person's user id; resolve it to a name.
  const userIds = [...new Set(channels.filter((c) => c.is_im).map((c) => c.user))];
  const names = new Map();
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const { user } = await call(token, 'users.info', { user: id });
        names.set(id, user.profile?.display_name || user.real_name || user.name);
      } catch {
        names.set(id, id);
      }
    })
  );

  return channels
    .map((c) => ({
      id: c.id,
      kind: c.is_im ? 'dm' : c.is_mpim ? 'group' : c.is_private ? 'private' : 'public',
      name: c.is_im ? names.get(c.user) : c.is_mpim ? (c.purpose?.value || c.name) : c.name,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || String(a.name).localeCompare(String(b.name)));
}

// Collect the signed-in user's own messages in a channel between two unix timestamps.
async function listMyMessages(token, { channel, userId, oldest, latest, includeThreads, limit = 1000 }) {
  const mine = [];
  const threadParents = [];
  let cursor;
  let truncated = false;

  do {
    const page = await call(token, 'conversations.history', {
      channel, oldest, latest, inclusive: true, limit: 200, cursor,
    });
    for (const m of page.messages) {
      if (m.user === userId) mine.push(m);
      if (includeThreads && m.reply_count > 0) threadParents.push(m.ts);
    }
    cursor = page.has_more ? page.response_metadata?.next_cursor : undefined;
    if (mine.length >= limit) { truncated = Boolean(cursor); break; }
  } while (cursor);

  for (const ts of threadParents) {
    if (mine.length >= limit) { truncated = true; break; }
    let rcursor;
    do {
      const page = await call(token, 'conversations.replies', { channel, ts, limit: 200, cursor: rcursor });
      for (const m of page.messages) {
        // The first entry is the parent, which the history pass already saw.
        if (m.ts !== ts && m.user === userId) mine.push(m);
      }
      rcursor = page.has_more ? page.response_metadata?.next_cursor : undefined;
    } while (rcursor);
  }

  const messages = mine
    .slice(0, limit)
    .map((m) => ({
      ts: m.ts,
      text: m.text || '',
      threadTs: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
      replyCount: m.reply_count || 0,
      files: (m.files || []).map((f) => f.name || f.title).filter(Boolean),
      edited: Boolean(m.edited),
    }))
    .sort((a, b) => Number(b.ts) - Number(a.ts));

  return { messages, truncated };
}

async function deleteMessage(token, channel, ts) {
  await call(token, 'chat.delete', { channel, ts });
}

module.exports = { call, whoAmI, listConversations, listMyMessages, deleteMessage, SlackError };
