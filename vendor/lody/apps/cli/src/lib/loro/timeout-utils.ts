export const readTimeoutEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> => {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};
