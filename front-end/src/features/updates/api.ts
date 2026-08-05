import type { UpdateInfo } from "./types";

/** False on the Vite dev server opened in a plain browser — there is no preload bridge there. */
export function isUpdateCheckSupported(): boolean {
  return typeof window.electron?.checkForUpdate === "function";
}

export async function checkForUpdateApi(force: boolean): Promise<UpdateInfo> {
  const check = window.electron?.checkForUpdate;
  if (!check) throw new Error("Update check requires the desktop app");
  return check(force);
}

/** Opens the release page in the system browser; false when the main process refused the URL. */
export async function openReleasePageApi(url: string): Promise<boolean> {
  const open = window.electron?.openReleasePage;
  if (!open) return false;
  return open(url);
}
