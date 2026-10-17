// Toolbar button: on a neshan.org/maps tab it opens/closes the panel; anywhere else it
// opens neshan.org/maps with the panel open.
const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener(async (tab) => {
  try {
    await api.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
    return;
  } catch {
    // no content script there: not a neshan.org/maps page
  }
  await api.storage.local.set({ openPanel: true });
  await api.tabs.create({ url: 'https://neshan.org/maps' });
});
