/** Google serves an account photo in whatever shape the URL's size directive
 * asks for. Without the `-c` (crop) suffix a tall original stays tall, and a
 * tall bitmap inside a round avatar reads as a mis-crop. Ask Google for the
 * centered square instead; every avatar on the page is round.
 * Non-Google URLs pass through untouched. */
export function squareAvatarUrl(avatarUrl: string): string {
  let host = "";
  try {
    host = new URL(avatarUrl).hostname;
  } catch {
    return avatarUrl;
  }
  if (!host.endsWith(".googleusercontent.com")) return avatarUrl;
  if (/=s\d+(?:-c)?$/u.test(avatarUrl)) return avatarUrl.replace(/=s(\d+)(?:-c)?$/u, "=s$1-c");
  return `${avatarUrl}=s128-c`;
}
