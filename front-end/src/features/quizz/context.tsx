import { createContext, useContext, type ReactNode } from "react";
import { useQuizStream } from "./hooks";
import type { QuizStreamContextValue } from "./hooks";

const QuizStreamContext = createContext<QuizStreamContextValue | null>(null);

export function QuizStreamProvider({ children }: { children: ReactNode }) {
  const value = useQuizStream();
  return (
    <QuizStreamContext.Provider value={value}>
      {children}
    </QuizStreamContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useQuizStreamContext(): QuizStreamContextValue {
  const ctx = useContext(QuizStreamContext);
  if (!ctx) {
    throw new Error(
      "useQuizStreamContext must be used within <QuizStreamProvider>",
    );
  }
  return ctx;
}
