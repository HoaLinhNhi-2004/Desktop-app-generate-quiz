const electron = require("electron");

// Synchronous on purpose: the renderer reads this while its config module is
// evaluating, before any request goes out. The port is only ever not 5000 when
// something else already owns 5000 on the user's machine.
const apiBaseUrl: string =
  electron.ipcRenderer.sendSync("apiBaseUrl") || "http://localhost:5000";

electron.contextBridge.exposeInMainWorld("electron", {
  apiBaseUrl,
  subscribeStatistics: (callback) =>
    ipcOn("statistics", (stats) => {
      callback(stats);
    }),
  getStaticData: () => ipcInvoke("getStaticData"),
  selectFolder: () => ipcInvoke("selectFolder"),
  focusWindow: () => ipcInvoke("focusWindow"),
  setNativeTheme: (theme) => ipcInvokeWithArg("setNativeTheme", theme),
  openExternalUrl: (url) => ipcInvokeWithArg("openExternalUrl", url),
} satisfies Window["electron"]);

function ipcInvoke<Key extends keyof EventPayloadMapping>(
  key: Key,
): Promise<EventPayloadMapping[Key]> {
  return electron.ipcRenderer.invoke(key);
}

function ipcInvokeWithArg<
  Key extends keyof EventRequestMapping & keyof EventPayloadMapping,
>(
  key: Key,
  payload: EventRequestMapping[Key],
): Promise<EventPayloadMapping[Key]> {
  return electron.ipcRenderer.invoke(key, payload);
}

function ipcOn<Key extends keyof EventPayloadMapping>(
  key: Key,
  callback: (payload: EventPayloadMapping[Key]) => void,
) {
  const cb = (
    _: Electron.IpcRendererEvent,
    payload: EventPayloadMapping[Key],
  ) => {
    callback(payload);
  };
  electron.ipcRenderer.on(key, cb);
  return () => electron.ipcRenderer.off(key, cb);
}
