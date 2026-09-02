type Statistics = { cpuUsage: number, memoryUsage: number, storageData: number }

type StationData = { 
  totalStorage: number, 
  cpuModel: string, 
  totalMemoryGB: number 
}

type ThemeSource = "dark" | "light" | "system";

type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  changeView: View;
  sendFrameAction: FrameWindowAction;
  selectFolder: string | null;
  focusWindow: void;
  setNativeTheme: void;
  openExternalUrl: boolean;
};

// Channels whose renderer -> main invoke carries an argument.
type EventRequestMapping = {
  setNativeTheme: ThemeSource;
  openExternalUrl: string;
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
  }
}