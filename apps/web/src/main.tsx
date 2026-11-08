import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme } from "./panel/prefs";
import { initPanelPwa } from "./panel/pwa";
import "./styles.css";
import "./panel/panel.css";

// Тема выбрана заранее — красим до первого кадра, чтобы не мигало.
applyTheme();
initPanelPwa();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
