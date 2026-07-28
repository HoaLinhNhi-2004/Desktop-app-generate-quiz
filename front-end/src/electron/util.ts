import { ipcMain, type WebFrameMain } from "electron";
import { pathToFileURL } from "url";
import { getUIPath } from "./pathResolver.js";

export function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}

export function ipcMainHandle<Key extends keyof EventPayloadMapping>(
  key: Key,
  handler: () => EventPayloadMapping[Key] | Promise<EventPayloadMapping[Key]>,
) {
  ipcMain.handle(key, (event) => {
    validateEventFrame(event.senderFrame!);
    return handler();
  });
}

export function ipcMainHandleWithArg<
  Key extends keyof EventRequestMapping & keyof EventPayloadMapping,
>(
  key: Key,
  handler: (
    payload: EventRequestMapping[Key],
  ) => EventPayloadMapping[Key] | Promise<EventPayloadMapping[Key]>,
) {
  ipcMain.handle(key, (event, payload: EventRequestMapping[Key]) => {
    validateEventFrame(event.senderFrame!);
    return handler(payload);
  });
}

export function ipcWebContentsSend<Key extends keyof EventPayloadMapping>(
  key: Key,
  webContents: Electron.WebContents,
  payload: EventPayloadMapping[Key],
) {
  webContents.send(key, payload);
}

export function validateEventFrame(frame: WebFrameMain) {
  if (isDev() && new URL(frame.url).host === "localhost:5123") {
    return;
  }
  if (frame.url !== pathToFileURL(getUIPath()).toString()) {
    throw new Error("Malicious event");
  }
}
