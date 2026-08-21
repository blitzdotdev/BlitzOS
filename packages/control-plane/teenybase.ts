import type { DatabaseSettings } from "teenybase";

const config = {
  appName: "Blitz Control Plane",
  appUrl: "$APP_URL",
  // Empty, not "$JWT_SECRET_MAIN": teenybase only mints or verifies its own
  // JWTs from table auth extensions, and `tables` is empty here — the control
  // plane authenticates with opaque session cookies in core/sessions.ts. The
  // key itself stays because databaseSettingsSchema requires the string, and
  // $Database parses these settings on every request.
  jwtSecret: "",
  tables: [],
} satisfies DatabaseSettings;

export default config;
