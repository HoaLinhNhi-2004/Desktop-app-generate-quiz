import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { SpeechRate } from "@/lib/use-speech";

interface A11yState {
  ttsEnabled: boolean;
  setTtsEnabled: (v: boolean) => void;
  ttsRate: SpeechRate;
  setTtsRate: (r: SpeechRate) => void;
  highContrast: boolean;
  setHighContrast: (v: boolean) => void;
}

const STORAGE_KEY = "quizgen-a11y";

interface PersistedShape {
  ttsEnabled: boolean;
  ttsRate: SpeechRate;
  highContrast: boolean;
}

const DEFAULT_STATE: PersistedShape = {
  ttsEnabled: true,
  ttsRate: "normal",
  highContrast: false,
};

function loadInitial(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    return {
      ttsEnabled: parsed.ttsEnabled ?? DEFAULT_STATE.ttsEnabled,
      ttsRate: parsed.ttsRate ?? DEFAULT_STATE.ttsRate,
      highContrast: parsed.highContrast ?? DEFAULT_STATE.highContrast,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

const A11yContext = createContext<A11yState | undefined>(undefined);

export function A11yProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PersistedShape>(loadInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable */
    }
  }, [state]);

  useEffect(() => {
    const root = document.documentElement;
    if (state.highContrast) root.classList.add("high-contrast");
    else root.classList.remove("high-contrast");
  }, [state.highContrast]);

  const setTtsEnabled = useCallback(
    (v: boolean) => setState((s) => ({ ...s, ttsEnabled: v })),
    [],
  );
  const setTtsRate = useCallback(
    (r: SpeechRate) => setState((s) => ({ ...s, ttsRate: r })),
    [],
  );
  const setHighContrast = useCallback(
    (v: boolean) => setState((s) => ({ ...s, highContrast: v })),
    [],
  );

  return (
    <A11yContext.Provider
      value={{
        ttsEnabled: state.ttsEnabled,
        setTtsEnabled,
        ttsRate: state.ttsRate,
        setTtsRate,
        highContrast: state.highContrast,
        setHighContrast,
      }}
    >
      {children}
    </A11yContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useA11y(): A11yState {
  const ctx = useContext(A11yContext);
  if (!ctx) throw new Error("useA11y must be used within A11yProvider");
  return ctx;
}
