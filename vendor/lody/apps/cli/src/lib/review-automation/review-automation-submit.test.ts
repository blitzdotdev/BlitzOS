import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_POLICY,
  ReviewSubmissionSchema,
  type ReviewFinding,
  type ReviewRun,
  type ReviewRunId,
  type SessionId,
} from '@lody/shared';
import { applyReviewSubmission } from './review-automation-submit';

const run = (overrides: Partial<ReviewRun> = {}): ReviewRun => ({
  id: 'run-1' as ReviewRunId,
  sessionId: 'session-1' as SessionId,
  policy: DEFAULT_REVIEW_POLICY,
  state: 'reviewing',
  round: 1,
  ciFixUsed: 0,
  conflictUsed: 0,
  findings: [],
  events: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const existingFinding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'r1-1',
  file: 'src/a.ts',
  severity: 'blocking',
  title: 'Unhandled null',
  detail: 'The result can be null.',
  failureScenario: 'A missing row returns null and the caller dereferences it.',
  resolution: 'open',
  raisedInRound: 1,
  ...overrides,
});

describe('applyReviewSubmission', () => {
  it('assigns sequential ids to new findings', () => {
    const result = applyReviewSubmission(run(), {
      verdict: 'request_changes',
      findings: [
        {
          file: 'src/a.ts',
          severity: 'blocking',
          title: 'Unhandled null',
          detail: 'x',
          failureScenario: 'y',
        },
        { file: 'src/b.ts', severity: 'suggestion', title: 'Naming', detail: 'z' },
      ],
    });
    expect(result.run.findings.map((finding) => finding.id)).toEqual(['f1', 'f2']);
    expect(result.run.submittedRound).toBe(1);
    expect(result.run.verdict).toBe('request_changes');
  });

  it('applies resolutions to existing findings without losing them', () => {
    const result = applyReviewSubmission(run({ round: 2, findings: [existingFinding()] }), {
      verdict: 'approve',
      resolutions: [{ findingId: 'r1-1', state: 'resolved', note: 'fixed in abc123' }],
    });
    expect(result.run.findings).toHaveLength(1);
    expect(result.run.findings[0]).toMatchObject({
      id: 'r1-1',
      resolution: 'resolved',
      resolutionNote: 'fixed in abc123',
    });
  });

  it('drops new suggestions on a re-check round so the loop can converge', () => {
    const result = applyReviewSubmission(run({ round: 2, findings: [existingFinding()] }), {
      verdict: 'request_changes',
      findings: [{ file: 'src/c.ts', severity: 'suggestion', title: 'Style', detail: 'nit' }],
    });
    expect(result.droppedSuggestions).toBe(1);
    expect(result.run.findings).toHaveLength(1);
  });

  it('still accepts a blocking regression on a re-check round', () => {
    const result = applyReviewSubmission(run({ round: 2, findings: [existingFinding()] }), {
      verdict: 'request_changes',
      findings: [
        {
          file: 'src/c.ts',
          severity: 'blocking',
          title: 'New crash',
          detail: 'introduced by the fix',
          failureScenario: 'Calling with an empty list now throws.',
        },
      ],
    });
    expect(result.droppedSuggestions).toBe(0);
    expect(result.run.findings).toHaveLength(2);
    expect(result.run.findings[1]).toMatchObject({ id: 'f2', severity: 'blocking' });
  });

  it('gives a regression raised during a CI spot check a fresh id', () => {
    // A spot check deliberately does not bump the round, so round-keyed ids
    // collided with the first round's findings and overwrote them.
    const result = applyReviewSubmission(run({ round: 1, findings: [existingFinding()] }), {
      verdict: 'request_changes',
      findings: [
        {
          file: 'src/c.ts',
          severity: 'blocking',
          title: 'Regression from the CI fix',
          detail: 'x',
          failureScenario: 'y',
        },
      ],
    });
    expect(result.run.findings).toHaveLength(2);
    const ids = result.run.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ignores resolutions for findings that do not exist', () => {
    const result = applyReviewSubmission(run({ findings: [existingFinding()] }), {
      verdict: 'approve',
      resolutions: [{ findingId: 'does-not-exist', state: 'resolved' }],
    });
    expect(result.run.findings).toHaveLength(1);
    expect(result.run.findings[0]?.resolution).toBe('open');
  });
});

describe('ReviewSubmissionSchema', () => {
  it('rejects a blocking finding with no failure scenario', () => {
    // The whole point of the requirement: an LLM asked for an opinion will always
    // produce one, and demanding the concrete failure is what separates a defect
    // from a plausible-sounding remark.
    const parsed = ReviewSubmissionSchema.safeParse({
      verdict: 'request_changes',
      findings: [{ file: 'a.ts', severity: 'blocking', title: 'Looks wrong', detail: 'hmm' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a suggestion with no failure scenario', () => {
    const parsed = ReviewSubmissionSchema.safeParse({
      verdict: 'approve',
      findings: [{ file: 'a.ts', severity: 'suggestion', title: 'Naming', detail: 'nit' }],
    });
    expect(parsed.success).toBe(true);
  });
});
