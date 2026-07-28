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
};

// Channels whose renderer -> main invoke carries an argument.
type EventRequestMapping = {
  setNativeTheme: ThemeSource;
};

type UnsubscribeFunction = () => void;

interface Window {
  electron: {
    subscribeStatistics: (callback: (statistics: Statistics) => void) => UnsubscribeFunction,
    getStaticData: () => Promise<StationData>,
    selectFolder?: () => Promise<string | null>,
    focusWindow?: () => Promise<void>,
    setNativeTheme?: (theme: ThemeSource) => Promise<void>,
  }
}