import type { MessageContent } from '@lody/shared';

type AssistantMessageRenderSeed = {
  content: MessageContent;
  itemIndex: number;
};

export type AssistantMessageRenderItem = AssistantMessageRenderSeed & {
  displayIndex: number;
};

export const isSubagentTaskItem = (item: MessageContent): boolean => item.type === 'subagent_task';

const isHiddenCompletedActivity = (item: MessageContent): boolean =>
  item.type === 'tool_call' &&
  item.activityKind === 'codex_retry' &&
  item.status !== 'pending' &&
  item.status !== 'in_progress';

const withDisplayIndexes = (
  items: readonly AssistantMessageRenderSeed[]
): AssistantMessageRenderItem[] =>
  items.map((item, displayIndex) => ({
    ...item,
    displayIndex,
  }));

export const buildAssistantMessageRenderItems = (
  items: readonly MessageContent[]
): AssistantMessageRenderItem[] => {
  const visibleItems = items.flatMap((content, itemIndex) =>
    isSubagentTaskItem(content) || isHiddenCompletedActivity(content)
      ? []
      : [{ content, itemIndex }]
  );

  if (!visibleItems.some((item) => item.content.type === 'proposed_plan')) {
    return withDisplayIndexes(visibleItems);
  }

  const before: AssistantMessageRenderSeed[] = [];
  const plans: AssistantMessageRenderSeed[] = [];
  for (const item of visibleItems) {
    if (item.content.type === 'proposed_plan') {
      plans.push(item);
    } else {
      before.push(item);
    }
  }

  return withDisplayIndexes([...before, ...plans]);
};
