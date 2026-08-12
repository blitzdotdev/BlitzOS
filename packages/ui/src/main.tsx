import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StandaloneCockpit } from "./StandaloneCockpit.js";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing root element");

createRoot(root).render(
  <StrictMode>
    <StandaloneCockpit controlPlaneBaseUrl={import.meta.env.VITE_CONTROL_PLANE_URL} />
  </StrictMode>,
);
