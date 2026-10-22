const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
contextBridge.exposeInMainWorld("hub", {
  switchDesktop: (uid, client) => invoke("hub:switch-desktop", uid, client),
  restartDesktop: (client) => invoke("hub:restart-desktop", client),
  saveDesktop: (client) => invoke("hub:save-desktop", client),
  load: () => invoke("hub:load"),
  refresh: () => invoke("hub:refresh"),
  reorderAccounts: (uids) => invoke("hub:account-order", uids),
  startModelTests: (items) => invoke("hub:model-tests-start", items),
  cancelModelTests: () => invoke("hub:model-tests-cancel"),
  conversations: () => invoke("hub:conversations"),
  usage: (start, end) => invoke("hub:usage", start, end),
  exportUsage: (start, end, client, uids, search) =>
    invoke("hub:usage-export", start, end, client, uids, search),
  backups: () => invoke("hub:backups"),
  importAccounts: () => invoke("hub:import"),
  exportAccounts: (uids) => invoke("hub:export-accounts", uids),
  createBackup: (client) => invoke("hub:backup-create", client),
  verifyBackup: (id) => invoke("hub:backup-verify", id),
  openBackup: (id) => invoke("hub:backup-open", id),
  restoreBackup: (id) => invoke("hub:backup-restore", id),
  extras: (uid) => invoke("hub:extras", uid),
  action: (uid, action, arg) => invoke("hub:action", uid, action, arg),
  open: (name) => invoke("hub:open", name),
  settings: () => invoke("hub:settings"),
  chooseExecutable: (key) => invoke("hub:choose-exe", key),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("hub:state", listener);
    return () => ipcRenderer.removeListener("hub:state", listener);
  },
});
