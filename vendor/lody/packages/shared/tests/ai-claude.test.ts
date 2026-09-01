import { describe, expect, it } from 'vitest';

import { getStaticBuiltinAcpCapabilities } from '../src/ai';

describe('builtin Claude shared contract', () => {
  it('uses the exact Fable option value exposed by the Claude ACP runtime', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'claude');

    expect(capabilities?.models).toContainEqual({
      modelId: 'claude-fable-5[1m]',
      name: 'Fable',
      description: 'Claude Fable 5 with 1M context',
    });
    expect(
      capabilities?.configOptions
        .find((option) => option.id === 'model')
        ?.options.find((option) => option.name === 'Fable')?.value
    ).toBe('claude-fable-5[1m]');
  });
});
