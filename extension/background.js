chrome.action.onClicked.addListener(async (tab) => {
  const url = new URL(chrome.runtime.getURL("app.html"));
  if (tab.url) url.searchParams.set("source", tab.url);
  await chrome.tabs.create({ url: url.href });
});
