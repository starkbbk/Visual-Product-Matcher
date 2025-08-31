import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root")!;
const Root = () => <App />;

// Disable StrictMode in DEV so effects don't run twice (Chrome stutters)
// Keep it in PROD if you want — it doesn’t render in production anyway.
ReactDOM.createRoot(root).render(
  import.meta.env.DEV ? <Root /> : <React.StrictMode><Root /></React.StrictMode>
);