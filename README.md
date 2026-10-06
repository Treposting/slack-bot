# Slack Cleaner

A small web app for finding and deleting **your own** Slack messages.

Pick a channel, private channel, group DM or DM, choose a date range, and the app lists every message you wrote there (optionally including your thread replies). Select the ones you want gone, confirm by typing `DELETE`, and watch them disappear with a progress bar.

- Only your own messages are ever listed or deleted.
- Nothing is deleted without the confirmation step.
- Your token lives only in the server's memory and is gone when you sign out or stop the app.
- Rate limits from Slack are handled automatically (it waits and retries).
- `DRY_RUN=1` lets you click through the whole flow without deleting anything.

## Why a user token?

Slack only lets a person delete their own messages with a **user token** (`xoxp-…`). A bot token (`xoxb-…`) can only delete messages the bot itself posted, so this app asks for user scopes, not bot scopes.

## 1. Create the Slack app (one time)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Pick your workspace and paste the contents of [`slack-app-manifest.yml`](slack-app-manifest.yml).
3. Click **Create**, then **Install to Workspace** and approve.
4. Open **OAuth & Permissions** and copy the **User OAuth Token** (starts with `xoxp-`).

If your workspace requires admin approval for apps, an admin will need to approve it first.

## 2. Run it

Requires Node.js 20.6 or newer.

```bash
npm install
npm start            # http://localhost:3000
```

Open <http://localhost:3000> and paste your `xoxp-` token.

To try it safely first:

```bash
npm run start:dry    # same UI, but nothing is actually deleted
```

### Optional settings

Copy `.env.example` to `.env`, fill in what you need, and run `npm run start:env`. `.env` is git-ignored.

| Variable | What it does |
| --- | --- |
| `SLACK_USER_TOKEN` | Skip the sign-in screen and use this token |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Show a **Sign in with Slack** button instead of pasting a token |
| `BASE_URL` | Public URL of the app, used for the OAuth redirect (default `http://localhost:3000`) |
| `DRY_RUN` | `1` to simulate deletes |
| `PORT`, `HOST` | Where to listen (default `127.0.0.1:3000`) |

For **Sign in with Slack**, the redirect URL `<BASE_URL>/auth/slack/callback` must be listed under **OAuth & Permissions → Redirect URLs** (the manifest already adds the localhost one). Slack may require HTTPS for redirect URLs that aren't localhost.

## Scopes used

| Scope | Why |
| --- | --- |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | List the conversations you're in |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Read messages to find yours |
| `chat:write` | Delete your messages (`chat.delete`) |
| `users:read` | Show names for direct messages |

## Development

```bash
npm test
```

Tests run against a fake Slack API, so they never touch a real workspace.

## Notes and limits

- The app is meant to run on your own machine. It binds to `127.0.0.1` by default; don't expose it publicly without adding real authentication.
- A search returns up to 1000 of your messages per channel. Narrow the date range to see more.
- Slack limits `chat.delete` to roughly 50 calls a minute, so large clean-ups take a while.
- Some workspaces block members from deleting their own messages; those deletes will show `cant_delete_message`.
