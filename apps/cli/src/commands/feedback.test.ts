import { describe, expect, it } from 'vitest';
import { feedbackCommand, resolveFeedbackText } from './feedback';

describe('resolveFeedbackText', () => {
  it('accepts positional feedback or stdin', () => {
    expect(
      resolveFeedbackText({
        feedbackParts: ['make', 'errors', 'actionable'],
        useStdin: false,
      })
    ).toBe('make errors actionable');
    expect(
      resolveFeedbackText({
        feedbackParts: [],
        useStdin: true,
        stdinText: '  make errors actionable\n',
      })
    ).toBe('make errors actionable');
  });

  it('rejects mixed or missing input', () => {
    expect(() =>
      resolveFeedbackText({
        feedbackParts: ['argument'],
        useStdin: true,
        stdinText: 'stdin',
      })
    ).toThrow('not both');
    expect(() =>
      resolveFeedbackText({
        feedbackParts: [],
        useStdin: false,
      })
    ).toThrow('Feedback is required');
  });

  it('preserves option-like tokens after positional feedback begins', () => {
    expect(
      feedbackCommand.parseOptions([
        'The',
        '--wait',
        'flag',
        'and',
        '--json',
        'output',
        'are',
        'confusing',
      ]).operands
    ).toEqual(['The', '--wait', 'flag', 'and', '--json', 'output', 'are', 'confusing']);
  });
});
