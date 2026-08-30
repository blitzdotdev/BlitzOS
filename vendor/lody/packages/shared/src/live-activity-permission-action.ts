import type { MessageContent } from './ai';

export type LiveActivityPermissionAction = 'allow' | 'reject';

type ToolCallContent = Extract<MessageContent, { type: 'tool_call' }>;
type PermissionInfo = NonNullable<ToolCallContent['permissionRequest']>;
type PermissionOption = PermissionInfo['options'][number];

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isFallbackAllowOption(option: PermissionOption): boolean {
  const optionId = normalizeText(option.optionId);
  const name = normalizeText(option.name);
  return (
    optionId.includes('allow') ||
    optionId.includes('approve') ||
    name.includes('allow') ||
    name.includes('approve') ||
    name.includes('允许')
  );
}

function isRejectOption(option: PermissionOption): boolean {
  const kind = normalizeText(option.kind);
  if (kind.startsWith('deny') || kind.startsWith('reject')) return true;

  const optionId = normalizeText(option.optionId);
  const name = normalizeText(option.name);
  return (
    optionId.includes('deny') ||
    optionId.includes('reject') ||
    optionId.includes('refuse') ||
    name.includes('deny') ||
    name.includes('reject') ||
    name.includes('refuse') ||
    name.includes('拒绝')
  );
}

export function selectPermissionOptionId(
  options: readonly PermissionOption[],
  action: LiveActivityPermissionAction
): string | null {
  if (action === 'allow') {
    return (
      options.find((option) => normalizeText(option.kind) === 'allow_always')?.optionId ??
      options.find((option) => normalizeText(option.kind) === 'allow_once')?.optionId ??
      options.find(isFallbackAllowOption)?.optionId ??
      null
    );
  }

  return options.find(isRejectOption)?.optionId ?? null;
}
