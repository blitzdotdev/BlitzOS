import { describe, expect, it } from 'vitest';
import {
  buildSteerRequestMeta,
  findActiveSteerConfigMismatch,
  parseAcknowledgedSteerCapability,
} from '../src/agent/acknowledged-steer';

describe('acknowledged steer protocol', () => {
  it('normalizes Core request and prompt steering capabilities', () => {
    const request = parseAcknowledgedSteerCapability({
      lody: {
        steering: {
          version: 1,
          transport: 'request',
          upstreamTurn: 'same',
          configPolicy: 'active',
        },
      },
    });
    const prompt = parseAcknowledgedSteerCapability({
      lody: {
        steering: {
          version: 1,
          transport: 'prompt',
          upstreamTurn: 'handoff',
          configPolicy: 'apply',
        },
      },
    });

    expect(request).toMatchObject({
      requestMethod: '_lody/session/steer',
      appliedNotificationMethod: 'lody/session/steer_applied',
      upstreamTurn: 'same',
      configPolicy: 'active',
    });
    expect(prompt).toMatchObject({
      promptMetaNamespace: 'lody',
      upstreamTurn: 'handoff',
      configPolicy: 'apply',
    });
    expect(buildSteerRequestMeta(request!, 'steer-1')).toBeUndefined();
    expect(buildSteerRequestMeta(prompt!, 'steer-2')).toEqual({
      lody: { steer: { id: 'steer-2' } },
    });
  });

  it('fails closed when requested configuration differs from the active Codex turn', () => {
    const options = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: 'gpt-5.4',
        options: [],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select' as const,
        currentValue: 'default',
        options: [],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning',
        type: 'select' as const,
        currentValue: 'high',
        options: [],
      },
    ];

    expect(
      findActiveSteerConfigMismatch(
        {
          modelId: 'gpt-5.4',
          modeId: 'default',
          configOptionValues: { reasoning_effort: 'high' },
        },
        options,
        'gpt-5.4'
      )
    ).toBeNull();
    expect(
      findActiveSteerConfigMismatch(
        {
          modelId: 'gpt-5.3',
          modeId: 'plan',
          configOptionValues: { reasoning_effort: 'medium' },
        },
        options,
        'gpt-5.4'
      )
    ).toContain('model requested gpt-5.3');
  });
});
