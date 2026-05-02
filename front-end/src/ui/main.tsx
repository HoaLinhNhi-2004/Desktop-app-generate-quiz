import React, { StrictMode } from "react";
import ReactDOM, { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import AppProvider from "@/config/app-provider";
import { ThemeProvider } from "@/config/theme-provider";
import { A11yProvider } from "@/config/a11y-provider";
import "@/config/i18n";
import "./index.css";
import App from "./App.tsx";

if (import.meta.env.DEV) {
  import("@axe-core/react").then(({ default: axe }) => {
    axe(React, ReactDOM, 1000);
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <A11yProvider>
        <AppProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </AppProvider>
      </A11yProvider>
    </ThemeProvider>
  </StrictMode>,
);
