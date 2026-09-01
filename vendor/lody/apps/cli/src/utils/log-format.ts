import util from 'node:util';

const MAX_LOG_MESSAGE_CHARS = 6000;
const MAX_LOG_STRING_CHARS = 2000;
const MAX_LOG_ERROR_CHARS = 4000;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_OBJECT_KEYS = 20;
const MAX_LOG_OBJECT_DEPTH = 4;

export function truncateLogText(
  value: string,
  options: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  } = {}
): string {
  const maxChars = options.maxChars ?? MAX_LOG_STRING_CHARS;
  if (value.length <= maxChars) {
    return value;
  }

  const headChars = options.headChars ?? Math.max(200, Math.floor(maxChars * 0.75));
  const tailChars = options.tailChars ?? Math.max(80, maxChars - headChars);
  const safeHeadChars = Math.min(headChars, value.length);
  const safeTailChars = Math.min(tailChars, Math.max(0, value.length - safeHeadChars));
  const omittedChars = Math.max(0, value.length - safeHeadChars - safeTailChars);

  return `${value.slice(0, safeHeadChars)}\n...[truncated ${omittedChars} chars]...\n${value.slice(
    value.length - safeTailChars
  )}`;
}

export function summarizeLogValue(
  value: unknown,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateLogText(value, { maxChars: MAX_LOG_STRING_CHARS });
  }

  if (Buffer.isBuffer(value)) {
    return `<Buffer ${value.length} bytes ${truncateLogText(value.toString('utf8'), {
      maxChars: 600,
      headChars: 420,
      tailChars: 120,
    })}>`;
  }

  if (value instanceof Error) {
    return truncateLogText(value.stack || value.message || value.name, {
      maxChars: MAX_LOG_ERROR_CHARS,
      headChars: 3000,
      tailChars: 700,
    });
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_OBJECT_DEPTH) {
      return `[Array(${value.length})]`;
    }

    const items = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => summarizeLogValue(item, depth + 1, seen));
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_LOG_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  if (value instanceof Map) {
    return {
      type: 'Map',
      size: value.size,
      entries: summarizeLogValue(Array.from(value.entries()), depth + 1, seen),
    };
  }

  if (value instanceof Set) {
    return {
      type: 'Set',
      size: value.size,
      values: summarizeLogValue(Array.from(value.values()), depth + 1, seen),
    };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    try {
      if (depth >= MAX_LOG_OBJECT_DEPTH) {
        return `[${value.constructor?.name || 'Object'}]`;
      }

      const entries = Object.entries(value as Record<string, unknown>);
      const summarized: Record<string, unknown> = {};

      for (const [key, entryValue] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
        summarized[key] = summarizeLogValue(entryValue, depth + 1, seen);
      }

      if (entries.length > MAX_LOG_OBJECT_KEYS) {
        summarized.__truncatedKeys = `+${entries.length - MAX_LOG_OBJECT_KEYS} more keys`;
      }

      return summarized;
    } finally {
      seen.delete(value);
    }
  }

  return String(value);
}

export function formatLogArgs(...args: unknown[]): string {
  const summarizedArgs = args.map((arg) =>
    typeof arg === 'string' ? arg : summarizeLogValue(arg)
  );
  const formatted = util.formatWithOptions(
    {
      colors: false,
      depth: MAX_LOG_OBJECT_DEPTH,
      maxArrayLength: MAX_LOG_ARRAY_ITEMS,
      maxStringLength: MAX_LOG_STRING_CHARS,
      breakLength: 120,
      compact: false,
    },
    ...summarizedArgs
  );

  return truncateLogText(formatted, {
    maxChars: MAX_LOG_MESSAGE_CHARS,
    headChars: 4500,
    tailChars: 900,
  });
}
