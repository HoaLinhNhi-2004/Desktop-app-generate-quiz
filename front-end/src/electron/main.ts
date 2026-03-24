import { app, BrowserWindow, dialog, globalShortcut, Menu } from "electron";
import { ipcMainHandle, isDev } from "./util.js";
import { getStationData, pollResource } from "./resourceManager.js";
import { getPreloadPath, getUIPath } from "./pathResolver.js";
import { killBackend, startBackend } from "./backendManager.js";
import type { ChildProcess } from "node:child_process";

let backendProcess: ChildProcess | null = null;

app.on("ready", async () => {
  if (!isDev()) {
    backendProcess = await startBackend();
    if (!backendProcess) {
      console.error("Failed to start backend; UI may show connection errors.");
    }
  }

  Menu.setApplicationMenu(null);

  const mainWindow = new BrowserWindow({
    title: "Generate Quiz",
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  if (isDev()) {
    mainWindow.loadURL("http://localhost:5123");
  } else {
    mainWindow.loadFile(getUIPath());
  }

  pollResource(mainWindow);

  ipcMainHandle("getStaticData", () => {
    return getStationData();
  });

  // Native folder picker for Smart Import
  ipcMainHandle("selectFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Select folder to import",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // DevTools, reload, hard reload shortcuts
  globalShortcut.register("F12", () => {
    mainWindow.webContents.toggleDevTools();
  });
  globalShortcut.register("F5", () => {
    mainWindow.webContents.reload();
  });
  globalShortcut.register("CommandOrControl+Shift+R", () => {
    mainWindow.webContents.reloadIgnoringCache();
  });
});

app.on("before-quit", () => {
  killBackend(backendProcess);
});
