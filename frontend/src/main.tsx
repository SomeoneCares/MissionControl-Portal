import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css"; // base tokens + reset first, so component styles can override
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
