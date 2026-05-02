import { createContext, useContext, type ReactNode } from "react";
import { useSmartImport } from "./hooks";

type SmartImportContextValue = ReturnType<typeof useSmartImport>;

const SmartImportContext = createContext<SmartImportContextValue | null>(null);

export function SmartImportProvider({ children }: { children: ReactNode }) {
  const value = useSmartImport();
  return (
    <SmartImportContext.Provider value={value}>
      {children}
    </SmartImportContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSmartImportContext(): SmartImportContextValue {
  const ctx = useContext(SmartImportContext);
  if (!ctx) {
    throw new Error(
      "useSmartImportContext must be used within <SmartImportProvider>",
    );
  }
  return ctx;
}
