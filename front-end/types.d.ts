type Statistics = { cpuUsage: number, memoryUsage: number, storageData: number }

type StationData = { 
  totalStorage: number, 
  cpuModel: string, 
  totalMemoryGB: number 
}

type ThemeSource = "dark" | "light" | "system";

type UpdateCheckStatus = "update-available" | "up-to-date" | "error";

type UpdateCheckErrorCode =
  | "offline"
  | "rate-limited"
  | "no-release"
  | "unexpected";

type UpdateCheckResult = {
  status: UpdateCheckStatus;
  /** Version this build reports (package.json version, synced at release time). */
  currentVersion: string;
  /** Latest published tag, normalised without the leading "v". */
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  /** Markdown release notes, truncated. */
  releaseNotes: string | null;
  publishedAt: string | null;
  /** Set only when status === "error"; `message` is the raw cause for logs. */
  error: { code: UpdateCheckErrorCode; message: string } | null;
  checkedAt: string;
};

type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  changeView: View;
  sendFrameAction: FrameWindowAction;
  selectFolder: string | null;
  focusWindow: void;
  setNativeTheme: void;
  openExternalUrl: boolean;
  checkForUpdate: UpdateCheckResult;
  openReleasePage: boolean;
};

// Channels whose renderer -> main invoke carries an argument.
type EventRequestMapping = {
  setNativeTheme: ThemeSource;
  openExternalUrl: string;
  /** true forces a network call, bypassing the main-process cache. */
  checkForUpdate: boolean;
  openReleasePage: string;
};

type UnsubscribeFunction = () => void;

interface Window {
  electron: {
    /** Where the bundled backend is actually listening — see APP_CONFIG.API_URL. */
    apiBaseUrl?: string,
    subscribeStatistics: (callback: (statistics: Statistics) => void) => UnsubscribeFunction,
    getStaticData: () => Promise<StationData>,
    selectFolder?: () => Promise<string | null>,
    focusWindow?: () => Promise<void>,
    setNativeTheme?: (theme: ThemeSource) => Promise<void>,
    openExternalUrl?: (url: string) => Promise<boolean>,
    checkForUpdate?: (force: boolean) => Promise<UpdateCheckResult>,
    openReleasePage?: (url: string) => Promise<boolean>,
  }
}