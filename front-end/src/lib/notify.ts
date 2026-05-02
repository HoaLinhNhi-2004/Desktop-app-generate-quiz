import { toast } from "sonner";

interface NotifyOptions {
  description?: string;
  duration?: number;
  /** Called when the user clicks the OS notification (and toast). Use it to navigate to a specific screen. */
  onClick?: () => void;
}

// Eagerly request permission at module load so it's granted by the time the first job finishes.
// Electron's default session auto-grants; in a browser the user is prompted once.
if (
  typeof Notification !== "undefined" &&
  Notification.permission === "default"
) {
  void Notification.requestPermission().catch(() => {});
}

function focusElectronWindow(): void {
  // Electron exposes focusWindow via preload; falls through silently in the browser dev server.
  void window.electron?.focusWindow?.().catch(() => {});
  try {
    window.focus();
  } catch {
    // ignore
  }
}

function fireOSNotification(
  title: string,
  body?: string,
  onClick?: () => void,
): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const notification = new Notification(
      title,
      body ? { body, silent: false } : { silent: false },
    );
    notification.onclick = () => {
      focusElectronWindow();
      onClick?.();
      notification.close();
    };
  } catch (err) {
    // Electron may reject if the window is closing or the renderer is unloading
    console.warn("OS notification failed:", err);
  }
}

export function notifySuccess(title: string, opts?: NotifyOptions): void {
  toast.success(title, {
    description: opts?.description,
    duration: opts?.duration,
  });
}

export function notifyError(title: string, opts?: NotifyOptions): void {
  toast.error(title, {
    description: opts?.description,
    duration: opts?.duration,
  });
}

export function notifyInfo(title: string, opts?: NotifyOptions): void {
  toast.info(title, {
    description: opts?.description,
    duration: opts?.duration,
  });
}

/** Long-running job completed successfully — toast + OS notification (always fires regardless of focus). */
export function notifyJobDone(title: string, opts?: NotifyOptions): void {
  toast.success(title, {
    description: opts?.description,
    duration: opts?.duration ?? 6000,
  });
  fireOSNotification(title, opts?.description, opts?.onClick);
}

/** Long-running job failed — toast + OS notification (always fires regardless of focus). */
export function notifyJobFailed(title: string, opts?: NotifyOptions): void {
  toast.error(title, {
    description: opts?.description,
    duration: opts?.duration ?? 8000,
  });
  fireOSNotification(title, opts?.description, opts?.onClick);
}
