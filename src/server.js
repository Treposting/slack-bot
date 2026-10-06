const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const slack = require('./slack');

const USER_SCOPES = [
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'chat:write', 'users:read',
].join(',');

function createApp(env = process.env) {
  const app = express();
  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const oauthEnabled = Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);
  const baseUrl = env.BASE_URL || `http://localhost:${env.PORT || 3000}`;

  // Tokens live only in this process's memory, keyed by a random cookie.
  const sessions = new Map();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function readCookie(req, name) {
    const match = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
  }

  function startSession(res, data) {
    const id = crypto.randomBytes(24).toString('hex');
    sessions.set(id, data);
    res.setHeader('Set-Cookie', `sid=${id}; HttpOnly; SameSite=Lax; Path=/`);
    return id;
  }

  function getSession(req) {
    const id = readCookie(req, 'sid');
    if (id && sessions.has(id)) return sessions.get(id);
    // A token in the environment signs everyone in, for a single-user local setup.
    if (env.SLACK_USER_TOKEN) return { token: env.SLACK_USER_TOKEN, me: null };
    return null;
  }

  async function requireAuth(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'not_signed_in' });
    try {
      if (!session.me) session.me = await slack.whoAmI(session.token);
      req.session = session;
      next();
    } catch (err) {
      res.status(401).json({ error: err.code || err.message });
    }
  }

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => res.status(400).json({ error: err.code || err.message }));

  app.get('/api/config', (req, res) => {
    res.json({ oauthEnabled, dryRun, envToken: Boolean(env.SLACK_USER_TOKEN) });
  });

  app.post('/api/token', wrap(async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (!token.startsWith('xoxp-')) {
      return res.status(400).json({ error: 'Paste a user token. It starts with xoxp-, not xoxb-.' });
    }
    const me = await slack.whoAmI(token);
    startSession(res, { token, me });
    res.json({ me });
  }));

  app.post('/api/logout', (req, res) => {
    const id = readCookie(req, 'sid');
    if (id) sessions.delete(id);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  if (oauthEnabled) {
    const states = new Set();
    app.get('/auth/slack', (req, res) => {
      const state = crypto.randomBytes(16).toString('hex');
      states.add(state);
      const url = new URL('https://slack.com/oauth/v2/authorize');
      url.searchParams.set('client_id', env.SLACK_CLIENT_ID);
      url.searchParams.set('user_scope', USER_SCOPES);
      url.searchParams.set('redirect_uri', `${baseUrl}/auth/slack/callback`);
      url.searchParams.set('state', state);
      res.redirect(url.toString());
    });

    app.get('/auth/slack/callback', wrap(async (req, res) => {
      if (!states.delete(String(req.query.state))) return res.status(400).send('Invalid OAuth state');
      if (req.query.error) return res.redirect('/?error=' + encodeURIComponent(req.query.error));
      const result = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.SLACK_CLIENT_ID,
          client_secret: env.SLACK_CLIENT_SECRET,
          code: String(req.query.code),
          redirect_uri: `${baseUrl}/auth/slack/callback`,
        }),
      }).then((r) => r.json());
      const token = result.authed_user?.access_token;
      if (!result.ok || !token) return res.redirect('/?error=' + encodeURIComponent(result.error || 'no_user_token'));
      startSession(res, { token, me: await slack.whoAmI(token) });
      res.redirect('/');
    }));
  }

  app.get('/api/me', requireAuth, (req, res) => res.json({ me: req.session.me }));

  app.get('/api/channels', requireAuth, wrap(async (req, res) => {
    res.json({ channels: await slack.listConversations(req.session.token) });
  }));

  app.get('/api/messages', requireAuth, wrap(async (req, res) => {
    const { channel, from, to, threads } = req.query;
    if (!channel) return res.status(400).json({ error: 'channel is required' });
    const oldest = from ? Date.parse(`${from}T00:00:00`) / 1000 : undefined;
    const latest = to ? Date.parse(`${to}T23:59:59.999`) / 1000 : undefined;
    const result = await slack.listMyMessages(req.session.token, {
      channel,
      userId: req.session.me.userId,
      oldest,
      latest,
      includeThreads: threads === '1',
    });
    res.json(result);
  }));

  // Deletes are sent in small batches by the browser so it can show progress.
  app.post('/api/delete', requireAuth, wrap(async (req, res) => {
    const { channel, timestamps } = req.body;
    if (!channel || !Array.isArray(timestamps) || timestamps.length === 0) {
      return res.status(400).json({ error: 'channel and timestamps are required' });
    }
    if (timestamps.length > 50) return res.status(400).json({ error: 'At most 50 messages per request' });

    const results = [];
    for (const ts of timestamps) {
      try {
        if (!dryRun) await slack.deleteMessage(req.session.token, channel, ts);
        results.push({ ts, ok: true });
      } catch (err) {
        results.push({ ts, ok: false, error: err.code || err.message });
      }
    }
    res.json({ results, dryRun });
  }));

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => {
    console.log(`Slack Cleaner running at http://localhost:${port}`);
    if (process.env.DRY_RUN) console.log('DRY_RUN is on: nothing will actually be deleted.');
  });
}

module.exports = { createApp, USER_SCOPES };
