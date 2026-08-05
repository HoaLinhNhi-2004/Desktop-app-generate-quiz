import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  nativeTheme,
  session,
  shell,
} from "electron";
import path from "node:path";
import { ipcMainHandle, ipcMainHandleWithArg, isDev } from "./util.js";
import { getStationData, pollResource } from "./resourceManager.js";
import { getAssetsPath, getPreloadPath, getUIPath } from "./pathResolver.js";
import { killBackend, startBackend } from "./backendManager.js";
import { checkForUpdate, isAllowedReleaseUrl } from "./updateChecker.js";
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

// The renderer may only hand the OS URLs that point back at the bundled
// backend — the OAuth consent screens and the Drive picker are served from
// there and then redirect onwards themselves. Anything else would turn this
// channel into "open any link the page asks for".
function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

// Matches --background in src/ui/index.css for the .light / .dark roots, so the
// native frame and the pre-paint window fill stay in step with the React theme.
const WINDOW_BACKGROUND = { light: "#ffffff", dark: "#0a0a0a" } as const;

function currentBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors
    ? WINDOW_BACKGROUND.dark
    : WINDOW_BACKGROUND.light;
}

app.on("ready", async () => {
  if (process.platform === "win32") {
    // Required so OS toast notifications show the app's name + icon instead of "electron.exe".
    app.setAppUserModelId("com.hoanglong.web-quizz");
  }

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
    icon: path.join(getAssetsPath(), "trayIcon.png"),
    autoHideMenuBar: true,
    backgroundColor: currentBackgroundColor(),
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

  // The renderer owns the theme (localStorage `quizgen-theme`); mirror it onto
  // nativeTheme so Windows repaints the title bar light/dark to match.
  ipcMainHandleWithArg("setNativeTheme", (theme) => {
    nativeTheme.themeSource = theme;
    mainWindow.setBackgroundColor(currentBackgroundColor());
  });

  nativeTheme.on("updated", () => {
    mainWindow.setBackgroundColor(currentBackgroundColor());
  });

  // OAuth consent and the Google Picker must run in the system browser: Google
  // rejects embedded webviews, and their scripts would violate our CSP.
  ipcMainHandleWithArg("openExternalUrl", async (url) => {
    if (!isAllowedExternalUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  // Update checks live here, not in the renderer: api.github.com is outside the
  // renderer's connect-src allowlist.
  ipcMainHandleWithArg("checkForUpdate", (force) => checkForUpdate(force));

  ipcMainHandleWithArg("openReleasePage", async (url) => {
    if (!isAllowedReleaseUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  // Focus + restore the main window — invoked when the user clicks an OS notification.
  ipcMainHandle("focusWindow", () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
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
