import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';

import {
  applyNotificationOnHistory,
  parseSessionNotification,
  type AcpSessionNotification,
  type SessionHistoryInput,
} from '@lody/shared';

type TurnStartMarker = {
  timestamp: string;
  type: 'turnStart';
  turnId: string;
};

type TurnEndMarker = {
  timestamp: string;
  type: 'turnEnd';
  turnId: string;
};

type NotificationLogEntry = {
  timestamp: string;
  notification: AcpSessionNotification;
};

type LogEntry = TurnStartMarker | TurnEndMarker | NotificationLogEntry;

type ParsedTurn = {
  turnId: string;
  startedAt: string;
  endedAt: string | null;
  notifications: AcpSessionNotification[];
};

const usage = () => {
  const cmd =
    'pnpm --filter lody exec tsx scripts/acp-updates-to-session-history.ts --in <input.jsonl> --out <output.json>';
  console.error(
    `Usage:\n  ${cmd}\n\nOptions:\n  --in,  -i   Input JSONL path\n  --out, -o   Output JSON path (omit for stdout)\n  --pretty    Pretty-print JSON\n`
  );
};

const parseArgs = (
  argv: string[]
): { inputPath: string | null; outputPath: string | null; pretty: boolean } => {
  const args = [...argv];
  const readFlagValue = (long: string, short: string): string | null => {
    const longIndex = args.indexOf(long);
    if (longIndex !== -1) return args[longIndex + 1] ?? null;
    const shortIndex = args.indexOf(short);
    if (shortIndex !== -1) return args[shortIndex + 1] ?? null;
    return null;
  };

  const inputPath = readFlagValue('--in', '-i') ?? args[0] ?? null;
  const outputPath = readFlagValue('--out', '-o') ?? args[1] ?? null;
  const pretty = args.includes('--pretty');

  return { inputPath, outputPath, pretty };
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const parseLogEntry = (line: string, lineNumber: number): LogEntry | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON on line ${lineNumber}: ${message}`, { cause: error });
  }

  if (!isObject(value)) {
    throw new Error(`Invalid JSON object on line ${lineNumber}`);
  }

  const timestamp = value.timestamp;
  if (typeof timestamp !== 'string' || timestamp.length === 0) {
    throw new Error(`Missing "timestamp" on line ${lineNumber}`);
  }

  const type = value.type;
  if (type === 'turnStart' || type === 'turnEnd') {
    const turnId = value.turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new Error(`Missing "turnId" for ${type} on line ${lineNumber}`);
    }
    return { timestamp, type, turnId } as TurnStartMarker | TurnEndMarker;
  }

  const notification = value.notification;
  if (notification !== undefined) {
    if (!isObject(notification)) {
      throw new Error(`Invalid "notification" value on line ${lineNumber}`);
    }
    return { timestamp, notification: parseSessionNotification(notification) };
  }

  // Unknown entry shape: ignore for forward-compat.
  return null;
};

const flushTurnToHistory = (turn: ParsedTurn): SessionHistoryInput[] => {
  const history = applyNotificationOnHistory([], turn.notifications, undefined, {
    createId: () => turn.turnId,
    now: () => turn.startedAt,
  });

  if (history.length === 0) return [];

  const endedAtMs = turn.endedAt ? Date.parse(turn.endedAt) : NaN;
  const endedAt = Number.isFinite(endedAtMs) ? endedAtMs : undefined;

  return history.map((entry) => ({
    ...entry,
    finished: true,
    endedAt,
  }));
};

const readTurnsFromJsonl = async (
  inputPath: string
): Promise<{ sessionId: string | null; turns: ParsedTurn[] }> => {
  const stream = createReadStream(inputPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | null = null;
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber += 1;
    const entry = parseLogEntry(line, lineNumber);
    if (!entry) continue;

    if ('type' in entry) {
      if (entry.type === 'turnStart') {
        if (current) {
          turns.push(current);
          console.error(
            `[warn] turnStart encountered before previous turn ended (prev=${current.turnId} next=${entry.turnId})`
          );
        }
        current = {
          turnId: entry.turnId,
          startedAt: entry.timestamp,
          endedAt: null,
          notifications: [],
        };
        continue;
      }

      // turnEnd
      if (!current) {
        console.error(`[warn] turnEnd encountered without active turn (turnId=${entry.turnId})`);
        continue;
      }
      if (current.turnId !== entry.turnId) {
        console.error(
          `[warn] turnEnd turnId mismatch (active=${current.turnId} end=${entry.turnId}); closing active turn`
        );
      }
      current.endedAt = entry.timestamp;
      turns.push(current);
      current = null;
      continue;
    }

    // notification
    const notification = entry.notification;
    if (!sessionId && typeof notification.sessionId === 'string') {
      sessionId = notification.sessionId;
    }
    if (!current) {
      console.error(`[warn] notification outside of turn; ignoring (line=${lineNumber})`);
      continue;
    }
    current.notifications.push(notification);
  }

  if (current) {
    turns.push(current);
    console.error(`[warn] EOF reached with active turn (turnId=${current.turnId})`);
  }

  return { sessionId, turns };
};

const main = async () => {
  const { inputPath, outputPath, pretty } = parseArgs(process.argv.slice(2));
  if (!inputPath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const { sessionId, turns } = await readTurnsFromJsonl(inputPath);

  const history: SessionHistoryInput[] = [];
  for (const turn of turns) {
    history.push(...flushTurnToHistory(turn));
  }

  const output = {
    session: {
      id: sessionId ?? 'unknown',
    },
    history,
  };

  const json = JSON.stringify(output, null, pretty ? 2 : 0);
  if (outputPath) {
    await writeFile(outputPath, json + '\n', { encoding: 'utf8' });
  } else {
    process.stdout.write(json + '\n');
  }
};

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[error] ${message}`);
  process.exitCode = 1;
});
