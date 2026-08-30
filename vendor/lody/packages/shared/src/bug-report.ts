export const BUG_REPORT_LOG_PATH_PREFIX = '/bug-report-logs/workspaces/';

export const buildBugReportLogObjectKey = (workspaceId: string, logId: string): string =>
  `bug-reports/${workspaceId}/${logId}.log`;

export const buildBugReportLogPath = (workspaceId: string, logId: string): string =>
  `${BUG_REPORT_LOG_PATH_PREFIX}${encodeURIComponent(workspaceId)}/${encodeURIComponent(logId)}`;

export const parseBugReportLogPath = (
  pathname: string
): { workspaceId: string; logId: string } | null => {
  if (!pathname.startsWith(BUG_REPORT_LOG_PATH_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(BUG_REPORT_LOG_PATH_PREFIX.length);
  const segments = rest.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }
  try {
    const workspaceId = decodeURIComponent(segments[0] ?? '');
    const logId = decodeURIComponent(segments[1] ?? '');
    if (!workspaceId || !logId) {
      return null;
    }
    return { workspaceId, logId };
  } catch {
    return null;
  }
};
