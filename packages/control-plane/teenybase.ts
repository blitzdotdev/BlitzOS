import type { DatabaseSettings } from "teenybase";

const config = {
  appName: "Blitz Control Plane",
  appUrl: "$APP_URL",
  jwtSecret: "$JWT_SECRET_MAIN",
  tables: [],
} satisfies DatabaseSettings;

export default config;
