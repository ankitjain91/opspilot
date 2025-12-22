import React from "react";
import ReactDOM from "react-dom/client";
// Initialize logger early to capture all console output
import "./utils/logger";
import App from "./App";

import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
