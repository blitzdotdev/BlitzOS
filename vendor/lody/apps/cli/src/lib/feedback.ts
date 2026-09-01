import { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { api } from '@lody/cloud-api';
import { LODY_AUTH_URL } from '@/utils/const';

export const MAX_AGENT_FEEDBACK_LENGTH = 4_000;

export type AgentFeedbackSource = 'cli' | 'mcp';

export type AgentFeedbackSystemInfo = {
  cliVersion: string;
  platform: string;
  arch: string;
};

const OBVIOUS_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}/,
  /\b(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,}/i,
] as const;

const FeedbackSubmissionResultSchema = z.object({
  ok: z.literal(true),
  feedbackId: z.string().min(1),
});

export function collectAgentFeedbackSystemInfo(cliVersion: string): AgentFeedbackSystemInfo {
  return {
    cliVersion,
    platform: process.platform,
    arch: process.arch,
  };
}

export function assertAgentFeedbackHasNoObviousSecret(feedback: string): void {
  if (OBVIOUS_SECRET_PATTERNS.some((pattern) => pattern.test(feedback))) {
    throw new Error(
      'Feedback appears to contain a secret. Remove credentials and submit only the product suggestion.'
    );
  }
}

export async function submitAgentFeedback(args: {
  cliToken: string;
  source: AgentFeedbackSource;
  feedback: string;
  cliVersion: string;
}): Promise<{ ok: true; feedbackId: string }> {
  const feedback = args.feedback.trim();
  if (!feedback) {
    throw new Error('Feedback is required.');
  }
  if (feedback.length > MAX_AGENT_FEEDBACK_LENGTH) {
    throw new Error(`Feedback must be at most ${MAX_AGENT_FEEDBACK_LENGTH} characters.`);
  }
  assertAgentFeedbackHasNoObviousSecret(feedback);
  if (!LODY_AUTH_URL) {
    throw new Error('LODY_AUTH_URL is not configured.');
  }

  const client = new ConvexHttpClient(LODY_AUTH_URL);
  const raw = await client.mutation(api.agentFeedback.submitFromCli, {
    cliToken: args.cliToken,
    source: args.source,
    feedback,
    systemInfo: collectAgentFeedbackSystemInfo(args.cliVersion),
  });
  return FeedbackSubmissionResultSchema.parse(raw);
}
