import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { TaskBodyEditor } from '@/components/tasks/task-body-editor';

/**
 * 任务描述编辑器（meowdown 所见即所得）。Markdown 仍是存储格式，agent 读写零
 * 转换；启动任务时它就是 agent 收到的 brief。输入期间本地优先，失焦/空闲才提交；
 * 远端编辑通过 `setState(markdown)` 落地，光标会被映射到变更之后而不是掉回开头。
 */
const meta = {
  title: 'Tasks/TaskBodyEditor',
  component: TaskBodyEditor,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[680px] bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskBodyEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const sample = `## Goal

Move session dispatch off the deprecated WS control plane.

- [ ] Audit remaining callers
- [ ] Migrate the retry path
- [ ] Delete the listener

> Keep the old endpoint alive for one release.
`;

export const WithContent: Story = {
  args: {
    value: sample,
    onCommit: () => {},
    onImagePaste: async () => undefined,
    imageAccept: 'image/png,image/jpeg,image/webp,image/gif',
  },
};

/** 空描述是一个入口，不是空白。 */
export const EmptyBody: Story = {
  args: { value: '', onCommit: () => {} },
};

export const WithQuoteAction: Story = {
  args: { value: sample, onCommit: () => {}, onQuoteSelection: () => {} },
};

export const Disabled: Story = {
  args: { value: sample, disabled: true, onCommit: () => {} },
};

/** 可交互：直接在正文里编辑，提交后展示 commit 次数与长度。 */
export const Interactive: Story = {
  args: { value: sample, onCommit: () => {} },
  render: function InteractiveStory() {
    const [value, setValue] = useState(sample);
    const [commits, setCommits] = useState(0);
    return (
      <div className="flex flex-col gap-2">
        <TaskBodyEditor
          value={value}
          onImagePaste={async () => undefined}
          imageAccept="image/png,image/jpeg,image/webp,image/gif"
          onCommit={(next) => {
            setValue(next);
            setCommits((count) => count + 1);
          }}
        />
        <p className="text-xs text-muted-foreground">
          commits: {commits} · length: {value.length}
        </p>
      </div>
    );
  },
};

/**
 * 远端改动落地：点按钮模拟另一台设备改了 body。光标应当被映射过去，而不是
 * 掉回文档开头 —— 这正是当初判断 meowdown 可以安全替换 textarea 的依据。
 * 先把光标放在正文中间，再点按钮。
 */
export const RemoteEditArrives: Story = {
  args: { value: sample, onCommit: () => {} },
  render: function RemoteEditStory() {
    const [value, setValue] = useState(sample);
    return (
      <div className="flex flex-col gap-2">
        <TaskBodyEditor value={value} onCommit={setValue} />
        <button
          type="button"
          className="self-start rounded border px-2 py-1 text-xs"
          onClick={() =>
            setValue((current) => `${current}\n- Added remotely at step ${current.length}\n`)
          }
        >
          Simulate remote edit
        </button>
      </div>
    );
  },
};
