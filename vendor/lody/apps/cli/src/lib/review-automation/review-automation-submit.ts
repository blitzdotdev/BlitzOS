import type { ReviewFinding, ReviewRun, ReviewSubmission } from '@lody/shared';

/**
 * Folds one reviewer submission into a run.
 *
 * Kept pure so the convergence rules are testable without a daemon: the round
 * counter, the resolution transitions, and the round-2 restriction are the whole
 * reason the loop terminates, and they are much easier to get wrong than to test.
 */

export type ApplyReviewSubmissionResult = {
  run: ReviewRun;
  /** Suggestions dropped because a re-check round may not raise new ones. */
  droppedSuggestions: number;
};

/**
 * Ids are sequential over the run, not keyed by round.
 *
 * Round-keyed ids collided: a CI spot check deliberately does not bump the round,
 * so a blocking regression raised during one would reuse a round-1 id and
 * overwrite that finding in the map.
 */
const nextFindingId = (existing: readonly ReviewFinding[], offset: number): string =>
  `f${existing.length + offset + 1}`;

export const applyReviewSubmission = (
  run: ReviewRun,
  submission: ReviewSubmission
): ApplyReviewSubmissionResult => {
  const byId = new Map(run.findings.map((finding) => [finding.id, finding]));

  for (const update of submission.resolutions ?? []) {
    const existing = byId.get(update.findingId);
    if (!existing) {
      continue;
    }
    byId.set(update.findingId, {
      ...existing,
      resolution: update.state,
      ...(update.note ? { resolutionNote: update.note } : {}),
    });
  }

  const isRecheck = run.round > 1;
  let droppedSuggestions = 0;
  const incoming: ReviewFinding[] = [];

  (submission.findings ?? []).forEach((finding) => {
    // A re-check that may raise fresh opinions never converges: the author fixes
    // what was listed, the reviewer lists new things, and the budget is spent
    // without either side being wrong. Only a blocking regression gets through.
    if (isRecheck && finding.severity !== 'blocking') {
      droppedSuggestions += 1;
      return;
    }
    incoming.push({
      id: nextFindingId(run.findings, incoming.length),
      file: finding.file,
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      ...(finding.failureScenario ? { failureScenario: finding.failureScenario } : {}),
      resolution: 'open',
      raisedInRound: run.round,
    });
  });

  return {
    run: {
      ...run,
      findings: [...byId.values(), ...incoming],
      verdict: submission.verdict,
      submittedRound: run.round,
    },
    droppedSuggestions,
  };
};
