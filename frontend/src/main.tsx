import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Providers } from "./ui";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root was not found in index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Providers><App /></Providers>
  </React.StrictMode>
);
