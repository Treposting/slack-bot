# Slack Cleaner

A Chrome extension for deleting **your own** Slack messages, using the Slack account you're already signed in to in the browser. No new Slack app, no token to copy, nothing for a workspace admin to approve.

Open any conversation, thread or DM in Slack, click the extension button, pick the messages you want gone, and it deletes them the same way Slack's own client does when you delete by hand (a `chat.delete` call), after you confirm.

## How it works (and why it's safe)

The extension runs only on `app.slack.com`, inside the tab you've already signed in to. For each message you select it sends the same `chat.delete` request Slack's web client sends when you delete a message yourself, using the session that tab already has (read from Slack's own `localStorage`). The token is only ever sent back to your workspace's Slack API; it is never stored, logged or sent anywhere else. If the session can't be read, it falls back to clicking Slack's message menu → **Delete message…** → confirm.

- Only messages Slack shows as yours are listed, and only in the conversation you have open.
- Nothing is deleted until you select messages and confirm a warning dialog.
- Deletes are paced (about one per 1.2s) so Slack doesn't rate-limit you.
- If a message can't be removed (some workspaces block it), it's skipped and shown in the panel.
- Deletion uses Slack's real delete, so **it cannot be undone.**

## Install

The extension isn't on the Chrome Web Store; load it unpacked:

1. Download the latest `slack-cleaner-vX.Y.Z.zip` from [Releases](https://github.com/Treposting/slack-bot/releases/latest) and unzip it (or clone this repo and use the `extension/` folder).
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped `slack-cleaner` folder.
5. The Slack Cleaner button appears in your toolbar (pin it if you like).

Keep the folder somewhere permanent; Chrome loads the extension from it. To update, replace the folder with a newer release and click ↻ on the extension.

## Use it

1. Go to <https://app.slack.com> and open the channel, thread or DM you want to clean up.
2. Click the **Slack Cleaner** toolbar button. A panel opens on the right.
3. **Pick messages** tab: lists your messages that are currently on screen. Slack only loads messages as you scroll, so to reach older ones, scroll up in the conversation and click the rescan (↻) button. Tick the messages to delete (or the select-all box), optionally filter by text, then click **Delete** and confirm.
4. **Clear everything** tab: deletes every message of yours in the conversation, starting at the newest and scrolling up to the top. Press **Stop** at any time.
5. A progress bar shows how it's going; anything that couldn't be deleted is listed underneath.

### Tips

- Work one conversation at a time. Switching conversations? Click **Rescan**.
- For a long history, scroll + Rescan in chunks rather than loading everything at once.
- The toolbar button toggles the panel open and closed.

## Limitations

- Only acts on messages Slack has rendered (what you've scrolled through), not your entire history at once.
- Slack's web layout changes occasionally; if scanning or deleting stops working, the selectors are all grouped at the top of [`extension/slack-ui.js`](extension/slack-ui.js) for a quick fix.
- Some workspaces disable message deletion for members; those will report `cant_delete_message` (or `no_delete_option` in menu mode).

## Development

```bash
npm install   # installs jsdom, used only for tests
npm test
```

Tests cover the selection logic ([`extension/selection.js`](extension/selection.js)) and the Slack DOM reading / delete flow ([`extension/slack-ui.js`](extension/slack-ui.js)) against a simulated Slack page, so they never touch a real workspace.

### Layout

| File | What it does |
| --- | --- |
| `extension/manifest.json` | MV3 manifest; content scripts run on `app.slack.com` |
| `extension/background.js` | Toolbar button → tells the tab to toggle the panel |
| `extension/content.js` | The in-page panel and the delete orchestration |
| `extension/slack-ui.js` | Reading Slack's DOM and deleting via `chat.delete` (all selectors here) |
| `extension/selection.js` | Pure selection/filter state (no DOM) |
| `extension/panel.css` | Panel styling (light and dark themes) |
| `extension/logo.svg` | Source for the logo; `icon16/48/128.png` are rendered from it |
