// In the desktop app the main process picks the backend's port — normally 5000,
// but an ephemeral one when something else already holds it — and hands the URL
// to the preload script. The browser dev build has no preload and falls through
// to VITE_API_URL / the default.
const electronApiUrl =
  typeof window !== "undefined" ? window.electron?.apiBaseUrl : undefined;

export const APP_CONFIG = {
  API_URL: electronApiUrl || import.meta.env.VITE_API_URL || "http://localhost:5000",
} as const;
