export const PREVIEW_GUIDANCE =
  "To show a running app in the Blitz preview, start your dev server listening on an IPv4 loopback or wildcard address (127.0.0.1 or 0.0.0.0), NOT IPv6-only (::1). "
  + "Use any TCP port in 1024-65535 except 7443-7446 and 17445. Within a few seconds the port appears in the workspace preview sidebar and is served at /workspaces/<workspace-id>/webapp/7445/preview/<port>/. "
  + "Do not attempt to reach that URL yourself from inside the box; the platform injects an auth token the browser has and the box does not. Just start the server and tell the user the port. "
  + "To surface a PUBLIC link you created (for example a blitz.dev app you deployed), run: blitz preview add <url> --title \"<name>\". It appears in the workspace preview sidebar. Only https *.blitz.dev links open inline in the preview; any other link opens in a new browser tab. Remove one with: blitz preview rm <url>.";
