import type { DatabaseSettings } from "teenybase";

const config = {
  appName: "Blitz Control Plane",
  appUrl: "https://blitz-control-plane.blitzapp.workers.dev",
  jwtSecret: "$JWT_SECRET_MAIN",
  tables: [],
} satisfies DatabaseSettings;

export default config;
