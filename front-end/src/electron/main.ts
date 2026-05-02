import { app, BrowserWindow, dialog, globalShortcut, Menu, session } from "electron";
import { ipcMainHandle, isDev } from "./util.js";
import { getStationData, pollResource } from "./resourceManager.js";
import { getPreloadPath, getUIPath } from "./pathResolver.js";
import { killBackend, startBackend } from "./backendManager.js";
import type { ChildProcess } from "node:child_process";

let backendProcess: ChildProcess | null = null;

function buildContentSecurityPolicy(): string {
  // Backend runs on http://localhost:5000 in both dev and packaged builds.
  // Dev additionally needs Vite HMR over ws://localhost:5123 plus
  // 'unsafe-eval'/'unsafe-inline' for the Vite client and React Fast Refresh.
  const apiOrigin = "http://localhost:5000";
  if (isDev()) {
    return [
      `default-src 'self' ${apiOrigin} http://localhost:5123 ws://localhost:5123`,
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' http://localhost:5123",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ${apiOrigin} http://localhost:5123 ws://localhost:5123`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; ");
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Tailwind v4 + shadcn ship some inline style attributes; allow inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}`,
    // pdf.js loads its worker from a blob: URL.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

app.on("ready", async () => {
  if (!isDev()) {
    backendProcess = await startBackend();
    if (!backendProcess) {
      console.error("Failed to start backend; UI may show connection errors.");
    }
  }

  Menu.setApplicationMenu(null);

  const csp = buildContentSecurityPolicy();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  const mainWindow = new BrowserWindow({
    title: "Generate Quiz",
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
