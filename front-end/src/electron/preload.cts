const electron = require("electron");

electron.contextBridge.exposeInMainWorld("electron", {
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
