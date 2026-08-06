import path from "node:path";
import { app } from "electron";
import { isDev } from "./util.js";

const BACKEND_EXE_NAME =
  process.platform === "win32" ? "WebQuizBackend.exe" : "WebQuizBackend";

export function getPreloadPath() {
  return path.join(
    app.getAppPath(),
    isDev() ? "." : "..",
    "dist-electron",
    "preload.cjs",
  );
}

export function getUIPath() {
  return path.join(app.getAppPath(), "/dist-react/index.html");
}

/** Static holding page shown while the bundled backend boots (copied from public/). */
export function getSplashPath() {
  return path.join(app.getAppPath(), "/dist-react/splash.html");
}

export function getAssetsPath() {
  return path.join(app.getAppPath(), isDev() ? "." : "..", "src", "assets");
}

/**
 * Path to the bundled backend folder (PyInstaller onedir) when packaged.
 * extraResources puts "backend" next to electron.exe, so use process.resourcesPath.
 * Returns null in dev (backend is run separately).
 */
export function getBackendDir(): string | null {
  if (isDev()) return null;
  return path.join(process.resourcesPath, "backend");
}

/** Path to WebQuizBackend.exe when packaged; null in dev. */
export function getBackendExePath(): string | null {
  const dir = getBackendDir();
  if (!dir) return null;
  return path.join(dir, BACKEND_EXE_NAME);
}
