// Clicking the toolbar button tells the Slack tab to toggle the cleaner panel.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id && tab.url && tab.url.startsWith('https://app.slack.com/')) {
    chrome.tabs.sendMessage(tab.id, { type: 'slack-cleaner:toggle' }).catch(() => {});
  }
});
