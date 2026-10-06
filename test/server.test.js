const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// A fake Slack Web API, so tests never touch a real workspace.
const ME = 'U_ME';
const store = {
  C1: [
    { ts: '1700000300.000100', user: ME, text: 'mine, latest' },
    { ts: '1700000200.000100', user: 'U_OTHER', text: 'someone else', reply_count: 2 },
    { ts: '1700000100.000100', user: ME, text: 'mine, oldest' },
  ],
  replies: {
    '1700000200.000100': [
      { ts: '1700000200.000100', user: 'U_OTHER', text: 'someone else' },
      { ts: '1700000250.000100', user: ME, text: 'my thread reply', thread_ts: '1700000200.000100' },
      { ts: '1700000260.000100', user: 'U_OTHER', text: 'their reply', thread_ts: '1700000200.000100' },
    ],
  },
};
const deleted = [];
let rateLimitOnce = true;

function fakeSlack(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    const method = req.url.replace('/api/', '');
    const send = (data) => res.end(JSON.stringify(data));
    if (req.headers.authorization !== 'Bearer xoxp-good') return send({ ok: false, error: 'invalid_auth' });
    switch (method) {
      case 'auth.test':
        return send({ ok: true, user_id: ME, user: 'nahid', team: 'Test Team', team_id: 'T1' });
      case 'users.conversations':
        return send({ ok: true, channels: [
          { id: 'C1', name: 'general', is_private: false },
          { id: 'D1', is_im: true, user: 'U_OTHER' },
        ] });
      case 'users.info':
        return send({ ok: true, user: { name: 'other', profile: { display_name: 'Other Person' } } });
      case 'conversations.history': {
        const msgs = store.C1.filter((m) =>
          (!params.oldest || Number(m.ts) >= Number(params.oldest)) &&
          (!params.latest || Number(m.ts) <= Number(params.latest)));
        return send({ ok: true, messages: msgs, has_more: false });
      }
      case 'conversations.replies':
        return send({ ok: true, messages: store.replies[params.ts] || [], has_more: false });
      case 'chat.delete':
        if (rateLimitOnce) {
          rateLimitOnce = false;
          res.statusCode = 429;
          res.setHeader('Retry-After', '0');
          return send({ ok: false, error: 'ratelimited' });
        }
        if (params.ts === 'bad') return send({ ok: false, error: 'cant_delete_message' });
        deleted.push(params.ts);
        return send({ ok: true });
      default:
        return send({ ok: false, error: 'unknown_method' });
    }
  });
}

let slackServer, appServer, base;

before(async () => {
  slackServer = http.createServer(fakeSlack).listen(0);
  await new Promise((r) => slackServer.once('listening', r));
  process.env.SLACK_API_BASE = `http://127.0.0.1:${slackServer.address().port}/api`;
  delete require.cache[require.resolve('../src/slack')];
  delete require.cache[require.resolve('../src/server')];
  const { createApp } = require('../src/server');
  appServer = createApp({}).listen(0);
  await new Promise((r) => appServer.once('listening', r));
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => {
  appServer.close();
  slackServer.close();
});

let cookie = '';
async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, data: await res.json() };
}

test('rejects requests before sign-in', async () => {
  const { status } = await req('/api/channels');
  assert.strictEqual(status, 401);
});

test('rejects bot tokens and bad tokens', async () => {
  assert.strictEqual((await req('/api/token', { method: 'POST', body: { token: 'xoxb-bot' } })).status, 400);
  assert.strictEqual((await req('/api/token', { method: 'POST', body: { token: 'xoxp-wrong' } })).status, 400);
});

test('signs in with a user token', async () => {
  const { status, data } = await req('/api/token', { method: 'POST', body: { token: 'xoxp-good' } });
  assert.strictEqual(status, 200);
  assert.strictEqual(data.me.userId, ME);
  assert.ok(cookie.startsWith('sid='));
});

test('lists channels with DM names resolved', async () => {
  const { data } = await req('/api/channels');
  assert.deepStrictEqual(data.channels.map((c) => [c.kind, c.name]), [['dm', 'Other Person'], ['public', 'general']]);
});

test('returns only my messages, newest first', async () => {
  const { data } = await req('/api/messages?channel=C1');
  assert.deepStrictEqual(data.messages.map((m) => m.text), ['mine, latest', 'mine, oldest']);
});

test('includes my thread replies when asked', async () => {
  const { data } = await req('/api/messages?channel=C1&threads=1');
  assert.deepStrictEqual(data.messages.map((m) => m.text), ['mine, latest', 'my thread reply', 'mine, oldest']);
  assert.strictEqual(data.messages[1].threadTs, '1700000200.000100');
});

test('deletes messages, retrying after a rate limit and reporting failures', async () => {
  const { data } = await req('/api/delete', {
    method: 'POST',
    body: { channel: 'C1', timestamps: ['1700000300.000100', 'bad'] },
  });
  assert.deepStrictEqual(data.results, [
    { ts: '1700000300.000100', ok: true },
    { ts: 'bad', ok: false, error: 'cant_delete_message' },
  ]);
  assert.deepStrictEqual(deleted, ['1700000300.000100']);
});

test('caps batch size', async () => {
  const { status } = await req('/api/delete', {
    method: 'POST',
    body: { channel: 'C1', timestamps: Array.from({ length: 51 }, (_, i) => String(i)) },
  });
  assert.strictEqual(status, 400);
});

test('dry run never calls chat.delete', async () => {
  const { createApp } = require('../src/server');
  const dry = createApp({ DRY_RUN: '1', SLACK_USER_TOKEN: 'xoxp-good' }).listen(0);
  await new Promise((r) => dry.once('listening', r));
  const before = deleted.length;
  const res = await fetch(`http://127.0.0.1:${dry.address().port}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'C1', timestamps: ['1700000100.000100'] }),
  }).then((r) => r.json());
  dry.close();
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(deleted.length, before);
});
