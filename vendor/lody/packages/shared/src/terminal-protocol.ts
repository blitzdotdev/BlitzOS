import { z } from 'zod';

export const TerminalDimensionsSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const TerminalSnapshotSchema = z.object({
  terminalId: z.string().min(1),
  title: z.string(),
  cwd: z.string().optional(),
});

export const TERMINAL_MAX_PER_SESSION = 8;

// Fallback dimensions used when a terminal is opened before xterm has measured the
// viewport; the real size is corrected on the first fit() after mount.
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;

export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;

const RequestIdSchema = z.string().min(1).optional();

export const TerminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('list'),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal('open'),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
    cols: TerminalDimensionsSchema.shape.cols,
    rows: TerminalDimensionsSchema.shape.rows,
  }),
  z.object({
    type: z.literal('attach'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
    cols: TerminalDimensionsSchema.shape.cols,
    rows: TerminalDimensionsSchema.shape.rows,
  }),
  z.object({
    type: z.literal('input'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
    data: z.string(),
  }),
  z.object({
    type: z.literal('resize'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
    cols: TerminalDimensionsSchema.shape.cols,
    rows: TerminalDimensionsSchema.shape.rows,
  }),
  z.object({
    type: z.literal('close'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
  }),
  z.object({
    type: z.literal('close_session'),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
  }),
]);

export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

export const TerminalServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('terminals'),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
    terminals: z.array(TerminalSnapshotSchema),
  }),
  z.object({
    type: z.literal('opened'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('data'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
    data: z.string(),
    replay: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('title'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
    title: z.string(),
  }),
  z.object({
    type: z.literal('exit'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1),
    exitCode: z.number().int(),
    signal: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    requestId: RequestIdSchema,
    terminalId: z.string().min(1).optional(),
    code: z.string().min(1),
    message: z.string(),
  }),
]);

export type TerminalServerEvent = z.infer<typeof TerminalServerEventSchema>;

export type TerminalDataEvent = Extract<TerminalServerEvent, { type: 'data' }>;
export type TerminalExitEvent = Extract<TerminalServerEvent, { type: 'exit' }>;
export type TerminalTitleEvent = Extract<TerminalServerEvent, { type: 'title' }>;

export interface TerminalOpenParams {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalOpenResult {
  terminalId: string;
  cwd?: string;
}
