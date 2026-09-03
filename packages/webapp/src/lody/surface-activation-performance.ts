/** Low-overhead activation marks consumed by the opt-in keep-alive probe. */

export type LodyActivationPhase =
  | "active-flip-commit"
  | "activity-reveal-commit"
  | "effects-settled"
  | "rail-portal-mount-commit"
  | "address-reconciliation"
  | "identity-revalidation-start"
  | "identity-revalidation-end"
  | "surface-visible-commit"
  | "focus-restore";

export interface LodyActivationMarkDetail {
  navigated?: boolean;
  outcome?: "matched" | "missing" | "failed" | "aborted";
}

export interface LodyActivationMark {
  phase: LodyActivationPhase;
  at: number;
  elapsed: number;
  detail?: LodyActivationMarkDetail;
}

export interface LodyActivationTrace {
  id: number;
  targetKey: string;
  startedAt: number;
  marks: readonly LodyActivationMark[];
}

interface MutableTrace {
  id: number;
  targetKey: string;
  startedAt: number;
  marks: LodyActivationMark[];
  phases: Set<LodyActivationPhase>;
}

let nextTraceId = 1;
let currentTrace: MutableTrace | null = null;

/** Start immediately before the state update that changes the active entry. */
export function beginLodyActivationTrace(targetKey: string, startedAt: number): number {
  const id = nextTraceId;
  nextTraceId += 1;
  currentTrace = { id, targetKey, startedAt, marks: [], phases: new Set() };
  performance.mark(`lody-activation-${id}:activation-call`, { startTime: startedAt });
  return id;
}

/** Record the first occurrence of one phase for the current target activation. */
export function markLodyActivationPhase(
  targetKey: string,
  phase: LodyActivationPhase,
  detail?: LodyActivationMarkDetail,
): void {
  const trace = currentTrace;
  if (trace === null || trace.targetKey !== targetKey || trace.phases.has(phase)) return;
  const at = performance.now();
  trace.phases.add(phase);
  const mark: LodyActivationMark = {
    phase,
    at,
    elapsed: at - trace.startedAt,
  };
  if (detail !== undefined) mark.detail = detail;
  trace.marks.push(mark);
  performance.mark(`lody-activation-${trace.id}:${phase}`, { startTime: at });
}

export function readLodyActivationTrace(id: number): LodyActivationTrace | null {
  const trace = currentTrace;
  if (trace === null || trace.id !== id) return null;
  return {
    id: trace.id,
    targetKey: trace.targetKey,
    startedAt: trace.startedAt,
    marks: trace.marks.map((mark) => ({ ...mark })),
  };
}

export function lodyActivationTraceHasPhase(id: number, phase: LodyActivationPhase): boolean {
  return currentTrace?.id === id && currentTrace.phases.has(phase);
}
