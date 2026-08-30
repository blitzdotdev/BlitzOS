import { Command } from 'commander';
import { version as cliVersion } from '@/pkg';
import {
  getAuthContextOrThrow,
  printJson,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { submitAgentFeedback } from '@/lib/feedback';

type FeedbackCommandOptions = Pick<CommonCommandOptions, 'json' | 'debug'>;

type FeedbackOptions = FeedbackCommandOptions & { stdin?: boolean };

async function readFeedbackStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('--stdin requires piped input.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function resolveFeedbackText(args: {
  feedbackParts: string[];
  useStdin: boolean;
  stdinText?: string;
}): string {
  if (args.useStdin && args.feedbackParts.length > 0) {
    throw new Error('Pass feedback either as arguments or through --stdin, not both.');
  }
  const feedback = (args.useStdin ? args.stdinText : args.feedbackParts.join(' '))?.trim();
  if (!feedback) {
    throw new Error('Feedback is required.');
  }
  return feedback;
}

export const feedbackCommand = new Command('feedback')
  .passThroughOptions()
  .description('Send product feedback with account identity and basic CLI/OS information')
  .argument(
    '[feedback...]',
    'Suggestion or problem report; options precede text; use -- before text beginning with -; omit sensitive data'
  )
  .option('--stdin', 'Read feedback from stdin instead of command arguments')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (feedbackParts: string[], options: FeedbackOptions) => {
    await runOneShotCommand('feedback', options, async () => {
      const auth = getAuthContextOrThrow('feedback');
      const feedback = resolveFeedbackText({
        feedbackParts,
        useStdin: options.stdin === true,
        ...(options.stdin === true ? { stdinText: await readFeedbackStdin() } : {}),
      });
      const result = await submitAgentFeedback({
        cliToken: auth.token,
        source: 'cli',
        feedback,
        cliVersion,
      });

      if (options.json) {
        printJson(result);
        return;
      }
      console.log(`Feedback submitted (${result.feedbackId}). Thank you.`);
    });
  });
