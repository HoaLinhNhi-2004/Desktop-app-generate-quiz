import { Routes, Route } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import {
  SmartImportProvider,
  useSmartImportContext,
} from "@/features/smart-import";
import { FloatingToolbar } from "./components/Header";
import { HomePage } from "./pages/HomePage";
import { QuizPage } from "./pages/QuizPage";
import { FolderDetailPage } from "./pages/FolderDetailPage";
import { EditQuizPage } from "./pages/EditQuizPage";
import { SmartImportWidget } from "./components/SmartImportWidget";

function GlobalSmartImportWidget() {
  const ctx = useSmartImportContext();
  return (
    <SmartImportWidget
      job={ctx.job}
      isMinimized={ctx.isMinimized}
      onMinimize={() => ctx.setIsMinimized(true)}
      onExpand={() => ctx.setIsMinimized(false)}
      onDismiss={ctx.dismiss}
      onPause={ctx.pauseImport}
      onResume={ctx.resumeImport}
      onCancel={ctx.cancelImport}
    />
  );
}

function App() {
  return (
    <SmartImportProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <main className="flex min-h-0 flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/folder/:id" element={<FolderDetailPage />} />
            <Route path="/quiz" element={<QuizPage />} />
            <Route path="/quiz/:id/edit" element={<EditQuizPage />} />
          </Routes>
        </main>
        <FloatingToolbar />
        <GlobalSmartImportWidget />
        <Toaster />
      </div>
    </SmartImportProvider>
  );
}

export default App;
