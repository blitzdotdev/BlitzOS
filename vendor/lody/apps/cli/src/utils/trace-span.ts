import { performance } from 'perf_hooks';
import { formatErrorMessage } from './format-error';
import type { Logger } from './logger';

type TraceField = string | number | boolean | null | undefined;
type TraceFields = Record<string, TraceField>;

const formatTraceValue = (value: Exclude<TraceField, null | undefined>): string => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value)) : String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
};

const formatTraceFields = (fields?: TraceFields): string => {
  if (!fields) {
    return '';
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${key}=${formatTraceValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
};

export type TraceSpan = {
  end: (fields?: TraceFields) => void;
  fail: (error: unknown, fields?: TraceFields) => void;
};

export const startTraceSpan = (logger: Logger, name: string, fields?: TraceFields): TraceSpan => {
  const startedAtMs = performance.now();
  let closed = false;
  logger.debug(`[trace-span] start name=${name}${formatTraceFields(fields)}`);

  return {
    end: (endFields) => {
      if (closed) {
        return;
      }
      closed = true;
      logger.debug(
        `[trace-span] end name=${name} status=ok durationMs=${Math.round(
          performance.now() - startedAtMs
        )}${formatTraceFields({ ...fields, ...endFields })}`
      );
    },
    fail: (error, endFields) => {
      if (closed) {
        return;
      }
      closed = true;
      logger.debug(
        `[trace-span] end name=${name} status=error durationMs=${Math.round(
          performance.now() - startedAtMs
        )}${formatTraceFields({
          ...fields,
          ...endFields,
          error: formatErrorMessage(error),
        })}`
      );
    },
  };
};

export const traceAsync = async <T>(
  logger: Logger,
  name: string,
  fields: TraceFields | undefined,
  run: () => Promise<T>
): Promise<T> => {
  const span = startTraceSpan(logger, name, fields);
  try {
    const result = await run();
    span.end();
    return result;
  } catch (error) {
    span.fail(error);
    throw error;
  }
};
