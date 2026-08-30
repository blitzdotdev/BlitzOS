import { z } from 'zod';

import type { AgentConfigId, MachineId, ReviewRunId, SessionId, WorkspaceId } from './ids';
import type { SessionPullRequestStateMeta } from './schema';

/**
 * Auto review and merge: a review agent reads the branch, hands blocking
 * findings back to the authoring session, and once nothing blocks it, lets that
 * session open the PR and merges when CI is green.
 *
 * One workspace Flock document carries three kinds of rows, and the split
 * matters:
 *
 * - The **policy** row is workspace-scoped. Review standards and budgets apply
 *   to every machine.
 * - A **reviewer config** row is machine-scoped. It names one concrete agent
 *   config on that machine plus its ACP run options.
 * - A **run** row is per-session and holds findings, the audit trail, and a
 *   frozen copy of both the policy and the selected machine reviewer. Freezing
 *   at authorization time is what keeps a later settings edit from changing
 *   the rules under an in-flight run — the same reason durable Operations
 *   freeze their effective configuration at acceptance (see
 *   `specs/session-orchestration.md`).
 *
 * All rows live on the Loro plane because the CLI reads them headless: a client
 * that closes mid-run must not stall the engine.
 */

/* -------------------------------------------------------------------------- */
/* Policy document                                                            */
/* -------------------------------------------------------------------------- */

export const REVIEW_POLICY_FLOCK_STREAM_SEGMENT = 'rp';

export const getReviewPolicyFlockDocId = (workspaceId: WorkspaceId): string =>
  `${workspaceId}:${REVIEW_POLICY_FLOCK_STREAM_SEGMENT}`;

export const isReviewPolicyFlockDocId = (value: string): boolean => {
  const parts = value.split(':');
  return parts.length === 2 && parts[0] !== '' && parts[1] === REVIEW_POLICY_FLOCK_STREAM_SEGMENT;
};

export const REVIEW_POLICY_ROW_FAMILY = 'policy';

/** One row: the workspace has a single review policy. */
export const REVIEW_POLICY_ROW_KEY: [typeof REVIEW_POLICY_ROW_FAMILY, 'default'] = [
  REVIEW_POLICY_ROW_FAMILY,
  'default',
];

export const getReviewPolicyScanPrefix = (): string[] => [REVIEW_POLICY_ROW_FAMILY];

export const serializeReviewPolicyKey = (key: readonly unknown[]): string => JSON.stringify(key);

/**
 * Where the review agent looks for repository-specific standards. Read from the
 * BASE branch, never the branch under review: the file is ordinary repository
 * content, so taking the branch's copy would let a change under review rewrite
 * the rules it is judged by.
 */
export const REVIEW_STANDARDS_FILENAME = 'REVIEW.md';

/** Consulted when the repository has no `REVIEW.md`. */
export const REVIEW_STANDARDS_FALLBACK_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Paths where an automatic merge is never allowed. `REVIEW.md` is on this list
 * for the same reason it is read from the base branch: a branch that edits the
 * review standards must not be merged by the agent those standards govern.
 */
export const DEFAULT_REVIEW_PROTECTED_PATHS = [
  'REVIEW.md',
  '.github/',
  '.git/',
] as const;

export const ReviewBudgetSchema = z.object({
  /**
   * Reviewer → author hand-backs. Small on purpose: the loop is bounded by the
   * re-check rules (a later round may only re-check, never add suggestions), and
   * a large number here just means a long wait before a human is told it stalled.
   */
  reviewRounds: z.number().int().min(1).max(20),
  /** CI failures the author may be asked to fix. Base-branch churn is not counted. */
  ciFixAttempts: z.number().int().min(0).max(10),
  conflictAttempts: z.number().int().min(0).max(10),
});

export type ReviewBudget = z.infer<typeof ReviewBudgetSchema>;

export const DEFAULT_REVIEW_BUDGET: ReviewBudget = {
  reviewRounds: 4,
  ciFixAttempts: 2,
  conflictAttempts: 2,
};

/**
 * The reviewer frozen into a run.
 *
 * `agentType` remains required for backwards compatibility with already
 * persisted runs and older daemons. New machine reviewer configurations also
 * carry `agentConfigId`, which is the authoritative selector: two configs on
 * one machine may use the same ACP agent type but different credentials,
 * prompts, or runtime setup.
 */
export const ReviewerAgentRefSchema = z.object({
  agentConfigId: z.string().trim().min(1).optional(),
  agentType: z.string().trim().min(1),
  modeId: z.string().optional(),
  modelId: z.string().optional(),
  configOptionValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});

export type ReviewerAgentRef = Omit<z.infer<typeof ReviewerAgentRefSchema>, 'agentConfigId'> & {
  agentConfigId?: AgentConfigId;
};

/* -------------------------------------------------------------------------- */
/* Machine reviewer configuration                                             */
/* -------------------------------------------------------------------------- */

export const REVIEWER_CONFIG_ROW_FAMILY = 'reviewer';

export type ReviewerConfigRowKey = [typeof REVIEWER_CONFIG_ROW_FAMILY, MachineId];

export const reviewerConfigKeys = {
  machine: (machineId: MachineId): ReviewerConfigRowKey => [REVIEWER_CONFIG_ROW_FAMILY, machineId],
};

export const getReviewerConfigScanPrefix = (): string[] => [REVIEWER_CONFIG_ROW_FAMILY];

export const parseReviewerConfigKey = (key: readonly unknown[]): MachineId | undefined => {
  if (key.length !== 2 || key[0] !== REVIEWER_CONFIG_ROW_FAMILY) {
    return undefined;
  }
  const machineId = key[1];
  return typeof machineId === 'string' && machineId.length > 0
    ? (machineId as MachineId)
    : undefined;
};

/**
 * A complete reviewer configuration for one machine.
 *
 * This row deliberately stores an exact `agentConfigId`: unlike workspace
 * review standards, execution credentials and ACP capabilities belong to a
 * machine. A session can only authorize a new review run when its machine has
 * one of these rows and the referenced agent config still exists there.
 */
export const MachineReviewerConfigSchema = z
  .object({
    machineId: z.string().trim().min(1),
    reviewer: ReviewerAgentRefSchema.extend({
      agentConfigId: z.string().trim().min(1),
    }),
    updatedAt: z.number(),
  })
  .strip();

export type MachineReviewerConfig = Omit<
  z.infer<typeof MachineReviewerConfigSchema>,
  'machineId' | 'reviewer'
> & {
  machineId: MachineId;
  reviewer: ReviewerAgentRef & { agentConfigId: AgentConfigId };
};

export const parseMachineReviewerConfig = (value: unknown): MachineReviewerConfig | undefined => {
  const parsed = MachineReviewerConfigSchema.safeParse(value);
  return parsed.success ? (parsed.data as MachineReviewerConfig) : undefined;
};

/**
 * A row is actionable only while its exact agent config still belongs to the
 * same machine and still describes the same ACP agent type. This turns deleting,
 * moving, or replacing an agent config into an explicit setup requirement
 * instead of silently selecting a different reviewer with the same type.
 */
export const isMachineReviewerConfigUsable = (
  config: MachineReviewerConfig | null | undefined,
  machineId: MachineId | null | undefined,
  agentConfigs: readonly {
    id: AgentConfigId;
    machineId: MachineId;
    agentType: string;
  }[]
): config is MachineReviewerConfig =>
  Boolean(
    config &&
    machineId &&
    config.machineId === machineId &&
    agentConfigs.some(
      (agent) =>
        agent.id === config.reviewer.agentConfigId &&
        agent.machineId === machineId &&
        agent.agentType === config.reviewer.agentType
    )
  );

export const ReviewPolicySchema = z
  .object({
    /**
     * Frozen reviewer for a run. The live workspace policy row no longer writes
     * this field; new runs fill it from the reviewed session's machine config.
     * It stays optional so persisted pre-machine-config policies and runs parse.
     */
    reviewer: ReviewerAgentRefSchema.optional(),
    /** Workspace-wide review requirements, additive to `REVIEW.md`. */
    requirements: z.string().max(8000).optional(),
    budget: ReviewBudgetSchema,
    /** Post a summary comment on the PR. Per-finding interaction stays in Lody. */
    postPrComment: z.boolean(),
    protectedPaths: z.array(z.string().trim().min(1)).max(64),
    /**
     * Set by the engine after a human confirms one merge in this workspace.
     * Until then every run stops before merging and asks. The first run is where
     * the reviewer's judgement is unproven, and a merge cannot be taken back.
     */
    mergeConfirmedOnce: z.boolean().optional(),
    updatedAt: z.number(),
  })
  .strip();

export type ReviewPolicy = Omit<z.infer<typeof ReviewPolicySchema>, 'reviewer'> & {
  reviewer?: ReviewerAgentRef;
};

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  budget: DEFAULT_REVIEW_BUDGET,
  postPrComment: true,
  protectedPaths: [...DEFAULT_REVIEW_PROTECTED_PATHS],
  updatedAt: 0,
};

export const parseReviewPolicy = (value: unknown): ReviewPolicy | undefined => {
  const parsed = ReviewPolicySchema.safeParse(value);
  return parsed.success ? (parsed.data as ReviewPolicy) : undefined;
};

/** Falls back to defaults field by field so a partially-written row stays usable. */
export const resolveReviewPolicy = (value: unknown): ReviewPolicy => {
  const parsed = parseReviewPolicy(value);
  if (!parsed) {
    return { ...DEFAULT_REVIEW_POLICY, protectedPaths: [...DEFAULT_REVIEW_PROTECTED_PATHS] };
  }
  return parsed;
};

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export const REVIEW_SEVERITY_VALUES = ['blocking', 'suggestion'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITY_VALUES)[number];

export const REVIEW_RESOLUTION_VALUES = ['open', 'resolved', 'unresolved', 'disputed'] as const;
export type ReviewResolution = (typeof REVIEW_RESOLUTION_VALUES)[number];

/**
 * Explains why `failureScenario` is mandatory for blocking findings: an LLM
 * reviewer asked for an opinion will always produce one, and the cheapest way to
 * separate a real defect from a plausible-sounding one is to require the concrete
 * failure. A finding whose author cannot say what breaks is a suggestion.
 */
export const REVIEW_FAILURE_SCENARIO_REQUIRED_MESSAGE =
  'failureScenario is required for blocking findings: name specific inputs or state and the wrong result they produce. If you cannot write one, use severity "suggestion" instead.';

export const ReviewSubmissionFindingSchema = z
  .object({
    file: z.string().trim().min(1),
    line: z.number().int().positive().optional(),
    severity: z.enum(REVIEW_SEVERITY_VALUES),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(4000),
    failureScenario: z.string().trim().max(2000).optional(),
  })
  .superRefine((finding, ctx) => {
    if (finding.severity === 'blocking' && !finding.failureScenario) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureScenario'],
        message: REVIEW_FAILURE_SCENARIO_REQUIRED_MESSAGE,
      });
    }
  });

export type ReviewSubmissionFinding = z.infer<typeof ReviewSubmissionFindingSchema>;

export const ReviewFindingSchema = z
  .object({
    id: z.string().trim().min(1),
    file: z.string().trim().min(1),
    line: z.number().int().positive().optional(),
    severity: z.enum(REVIEW_SEVERITY_VALUES),
    title: z.string(),
    detail: z.string(),
    failureScenario: z.string().optional(),
    resolution: z.enum(REVIEW_RESOLUTION_VALUES),
    /** Why the reviewer set the current resolution; carries the dispute rationale. */
    resolutionNote: z.string().optional(),
    /** Review round that first raised this finding. */
    raisedInRound: z.number().int().nonnegative(),
    /** Reserved so a second reviewer can be added without migrating findings. */
    reviewerId: z.string().optional(),
  })
  .strip();

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const REVIEW_VERDICT_VALUES = ['approve', 'request_changes'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICT_VALUES)[number];

export const ReviewResolutionUpdateSchema = z.object({
  findingId: z.string().trim().min(1),
  state: z.enum(['resolved', 'unresolved', 'disputed']),
  note: z.string().trim().max(2000).optional(),
});

export type ReviewResolutionUpdate = z.infer<typeof ReviewResolutionUpdateSchema>;

export const ReviewSubmissionSchema = z.object({
  verdict: z.enum(REVIEW_VERDICT_VALUES),
  findings: z.array(ReviewSubmissionFindingSchema).max(100).optional(),
  resolutions: z.array(ReviewResolutionUpdateSchema).max(100).optional(),
  /** One or two sentences for the PR comment and the status bar. */
  summary: z.string().trim().max(2000).optional(),
});

export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

/** A finding still standing in the way of a merge. */
export const isBlockingFinding = (finding: ReviewFinding): boolean =>
  finding.severity === 'blocking' &&
  (finding.resolution === 'open' || finding.resolution === 'unresolved');

/** Any dispute ends the loop: two agents arguing is the expensive failure mode. */
export const hasDisputedFinding = (findings: readonly ReviewFinding[]): boolean =>
  findings.some((finding) => finding.resolution === 'disputed');

/* -------------------------------------------------------------------------- */
/* Run state                                                                  */
/* -------------------------------------------------------------------------- */

export const REVIEW_RUN_STATE_VALUES = [
  'reviewing',
  'fixing',
  'creating_pr',
  'waiting_ci',
  'fixing_ci',
  'resolving_conflict',
  'awaiting_merge_confirmation',
  'merging',
  'merged',
  /** A review-only run finished and reported. Nothing further happens. */
  'reviewed',
  'paused',
  'blocked',
] as const;

export type ReviewRunState = (typeof REVIEW_RUN_STATE_VALUES)[number];

export const REVIEW_RUN_TERMINAL_STATES: readonly ReviewRunState[] = [
  'merged',
  'reviewed',
  'blocked',
];

/**
 * What a run is allowed to do.
 *
 * Both modes are the same engine — a one-shot review is the full loop with the
 * budget spent and no authority — which is what keeps the two features one
 * concept for the user rather than two that behave subtly differently.
 */
export const REVIEW_RUN_MODE_VALUES = ['review_only', 'review_and_merge'] as const;
export type ReviewRunMode = (typeof REVIEW_RUN_MODE_VALUES)[number];

export const isReviewRunTerminal = (state: ReviewRunState): boolean =>
  REVIEW_RUN_TERMINAL_STATES.includes(state);

export const REVIEW_BLOCKED_REASON_VALUES = [
  'budget_exhausted',
  'disputed',
  'protected_path',
  'human_review_pending',
  'diff_changed_after_approval',
  'reviewer_unavailable',
  'merge_failed',
  'error',
] as const;

export type ReviewBlockedReason = (typeof REVIEW_BLOCKED_REASON_VALUES)[number];

/**
 * Compact pointer on `SessionMeta`. The checkbox being on is exactly the
 * presence of this field, and only a human may write it — the same rule that
 * keeps MCP from writing a Task's `agent` reference. Everything that grows
 * (findings, audit trail, frozen policy) lives in the run document instead,
 * because session metadata is synced on every change and paid for by every
 * client rendering a list.
 */
export type SessionAutoReviewMeta = {
  runId: ReviewRunId;
  /** Epoch seconds of authorization. */
  t: number;
};

/**
 * Deliberately carries NO run state.
 *
 * An earlier version mirrored `state` and `round` here, but only the client
 * wrote them — every subsequent transition is authored by the machine into the
 * run row — so they were stale from the first step and quietly wrong for anyone
 * who read them. One source of truth for run state (the run row); this field is
 * authorization plus a pointer, nothing more.
 */
export const SessionAutoReviewMetaSchema = z
  .object({
    runId: z.string().trim().min(1),
    t: z.number(),
  })
  .strip();

/**
 * Runs live as rows in the same workspace Flock document as the policy, keyed by
 * the reviewed session.
 *
 * A dedicated Loro document per run was the other option and was rejected: a new
 * document type needs plane routing (`getPlaneForDocRoom`), and a room that
 * silently resolves to no members stops syncing without erroring. A Flock row
 * needs none of that, and it also gives the engine a cheap enumeration of the
 * active runs — exactly what a scheduler pass wants. Size is not a concern: the
 * transport's per-entry budget is measured in megabytes and findings are capped
 * at 100.
 */
export const REVIEW_RUN_ROW_FAMILY = 'run';

export type ReviewRunRowKey = [typeof REVIEW_RUN_ROW_FAMILY, SessionId];

export const reviewRunKeys = {
  run: (sessionId: SessionId): ReviewRunRowKey => [REVIEW_RUN_ROW_FAMILY, sessionId],
};

export const getReviewRunScanPrefix = (): string[] => [REVIEW_RUN_ROW_FAMILY];

export const parseReviewRunKey = (key: readonly unknown[]): SessionId | undefined => {
  if (key.length !== 2 || key[0] !== REVIEW_RUN_ROW_FAMILY) {
    return undefined;
  }
  const sessionId = key[1];
  return typeof sessionId === 'string' && sessionId.length > 0 ? (sessionId as SessionId) : undefined;
};

export const ReviewRunEventSchema = z.object({
  at: z.number(),
  state: z.enum(REVIEW_RUN_STATE_VALUES),
  /** Human-readable line for the audit timeline. */
  detail: z.string(),
});

export type ReviewRunEvent = z.infer<typeof ReviewRunEventSchema>;

/** Bounded so one long-running branch cannot grow the row without limit. */
export const REVIEW_RUN_MAX_EVENTS = 200;

export const ReviewRunSchema = z
  .object({
    id: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    /** Absent means `review_and_merge`, the original behaviour. */
    mode: z.enum(REVIEW_RUN_MODE_VALUES).optional(),
    /** Reviewer child session; absent until the first round starts. */
    reviewerSessionId: z.string().optional(),
    /** Frozen at authorization so later settings edits cannot change the rules mid-run. */
    policy: ReviewPolicySchema,
    state: z.enum(REVIEW_RUN_STATE_VALUES),
    /** Completed review rounds. */
    round: z.number().int().nonnegative(),
    ciFixUsed: z.number().int().nonnegative(),
    conflictUsed: z.number().int().nonnegative(),
    findings: z.array(ReviewFindingSchema),
    events: z.array(ReviewRunEventSchema),
    blocked: z
      .object({
        reason: z.enum(REVIEW_BLOCKED_REASON_VALUES),
        /** Plain-language handoff: what is stuck, what was tried, what to do next. */
        summary: z.string(),
      })
      .optional(),
    /** Head SHA the reviewer last approved, to detect changes after approval. */
    approvedSha: z.string().optional(),
    /**
     * A human authorized THIS run's merge from the confirmation prompt.
     *
     * Separate from the policy's `mergeConfirmedOnce`, which records that the
     * workspace has been through one confirmed merge and retires the prompt. The
     * per-run grant is what actually lets a waiting run proceed; without it the
     * confirmation state has no exit, because the only writer of the policy flag
     * is the merge it gates.
     */
    mergeConfirmed: z.boolean().optional(),
    /** State to return to when a paused run is resumed. */
    pausedFrom: z.enum(REVIEW_RUN_STATE_VALUES).optional(),
    /**
     * Consecutive failed steps. A step that throws leaves durable state
     * untouched, so without this the same failing action retries on every
     * document change.
     */
    consecutiveFailures: z.number().int().nonnegative().optional(),
    /**
     * The last user turn this engine wrote into the authoring session, and the
     * whole mechanism for noticing a human took over: if the session's
     * `latestUserMsgId` is something else, a person spoke and the run pauses.
     * Seeded at authorization with whatever turn was current, so the user's own
     * opening message is never mistaken for an interruption.
     */
    lastEngineTurnId: z.string().optional(),
    /** Round number the latest reviewer submission answered. */
    submittedRound: z.number().int().nonnegative().optional(),
    /** Verdict from that submission. */
    verdict: z.enum(REVIEW_VERDICT_VALUES).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strip();

export type ReviewRun = Omit<
  z.infer<typeof ReviewRunSchema>,
  'id' | 'sessionId' | 'reviewerSessionId' | 'policy'
> & {
  id: ReviewRunId;
  sessionId: SessionId;
  reviewerSessionId?: SessionId;
  policy: ReviewPolicy;
};

export const parseReviewRun = (value: unknown): ReviewRun | undefined => {
  const parsed = ReviewRunSchema.safeParse(value);
  return parsed.success ? (parsed.data as ReviewRun) : undefined;
};

/** Keeps the audit trail bounded while preserving the most recent history. */
export const appendReviewRunEvent = (
  events: readonly ReviewRunEvent[],
  event: ReviewRunEvent
): ReviewRunEvent[] => [...events, event].slice(-REVIEW_RUN_MAX_EVENTS);

/* -------------------------------------------------------------------------- */
/* Merge gate                                                                 */
/* -------------------------------------------------------------------------- */

export type AutoMergeBlocker =
  | 'no_pr'
  | 'pr_not_open'
  | 'ci_not_green'
  | 'merge_state_not_clean'
  | 'blocking_findings'
  | 'disputed'
  | 'human_review_pending'
  | 'protected_path'
  | 'awaiting_confirmation';

export type AutoMergeInput = {
  prState: SessionPullRequestStateMeta | null | undefined;
  prStatus: 'open' | 'closed' | 'merged' | 'draft' | undefined;
  findings: readonly ReviewFinding[];
  /** Unresolved review threads authored by humans, excluding Lody's own comment. */
  humanReviewPending: boolean;
  /** Changed paths matching the policy's protected list. */
  touchedProtectedPaths: readonly string[];
  /** False until a human has confirmed one merge in this workspace. */
  confirmationSatisfied: boolean;
  /**
   * The machine-side engine observed this exact head with no CI rollup for a
   * full grace window, so the absence is "the repository has no CI" rather
   * than "check suites have not registered yet".
   */
  ciAbsentConfirmed?: boolean;
};

/**
 * Authorization to merge without a human.
 *
 * Deliberately stricter than `deriveSessionPullRequestReadiness`, which treats an
 * ABSENT CI rollup as ready. That is right for lighting up a manual merge button
 * — there may simply be no CI configured — but wrong here: immediately after a
 * push there is a window where no check suite has registered yet and `s` is
 * undefined, so reusing that helper would merge before CI ever ran. Automatic
 * merges require CI to have explicitly reported success, unless the caller
 * proves the absence is real by watching the unchanged head for a grace window
 * (`ciAbsentConfirmed`).
 */
export const evaluateAutoMerge = (input: AutoMergeInput): AutoMergeBlocker[] => {
  const blockers: AutoMergeBlocker[] = [];

  if (!input.prStatus) {
    blockers.push('no_pr');
  } else if (input.prStatus !== 'open') {
    blockers.push('pr_not_open');
  }

  if (input.prState?.s !== 's' && input.ciAbsentConfirmed !== true) {
    blockers.push('ci_not_green');
  }
  if (input.prState?.m !== 'c') {
    blockers.push('merge_state_not_clean');
  }
  if (input.findings.some(isBlockingFinding)) {
    blockers.push('blocking_findings');
  }
  if (hasDisputedFinding(input.findings)) {
    blockers.push('disputed');
  }
  if (input.humanReviewPending) {
    blockers.push('human_review_pending');
  }
  if (input.touchedProtectedPaths.length > 0) {
    blockers.push('protected_path');
  }
  if (!input.confirmationSatisfied) {
    blockers.push('awaiting_confirmation');
  }

  return blockers;
};

export const isPathProtected = (path: string, protectedPaths: readonly string[]): boolean => {
  const normalized = path.replace(/^\.\//, '');
  return protectedPaths.some((entry) => {
    const rule = entry.replace(/^\.\//, '');
    return rule.endsWith('/') ? normalized.startsWith(rule) : normalized === rule;
  });
};

export const findTouchedProtectedPaths = (
  changedPaths: readonly string[],
  protectedPaths: readonly string[]
): string[] => changedPaths.filter((path) => isPathProtected(path, protectedPaths));
