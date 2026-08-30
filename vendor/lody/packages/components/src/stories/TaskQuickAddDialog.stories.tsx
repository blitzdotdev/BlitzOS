import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { userEvent, within } from 'storybook/test';
import type { UnifiedLocalProjectOption } from '@/components/chat/unified-project-selector';
import { TaskQuickAddDialog } from '@/components/tasks/task-quick-add-dialog';

/**
 * 快速捕获弹窗。没有必填项：标题空则取正文首行；标题与正文都空时 Create =
 * 静默收起、什么都不发生。键盘流：标题内 Enter / ↓ 进正文，正文首行 ↑ 回标题，
 * ⌘↵ 创建。项目选择复用 chat landing 的 UnifiedProjectSelector。
 */
const meta = {
  title: 'Tasks/TaskQuickAddDialog',
  component: TaskQuickAddDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    createMore: {
      description: '勾选后创建完停留在弹窗，用于连续记录多条',
      control: 'boolean',
    },
    submitting: { description: '创建中（禁用输入）', control: 'boolean' },
  },
} satisfies Meta<typeof TaskQuickAddDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const LOCAL_PROJECTS: UnifiedLocalProjectOption[] = [
  {
    key: 'm1:p1',
    machineId: 'm1' as never,
    localProjectId: 'p1' as never,
    name: 'lody',
    rootPath: 'MacBook Pro · /Users/me/lody',
  },
  {
    key: 'm1:p2',
    machineId: 'm1' as never,
    localProjectId: 'p2' as never,
    name: 'loro',
    rootPath: 'MacBook Pro · /Users/me/loro',
  },
  {
    key: 'm2:p3',
    machineId: 'm2' as never,
    localProjectId: 'p3' as never,
    name: 'loro-mirror',
    rootPath: 'Linux Box · /home/me/loro-mirror',
  },
  {
    key: 'm1:p4',
    machineId: 'm1' as never,
    localProjectId: 'p4' as never,
    name: 'loro-notes',
    rootPath: 'MacBook Pro · /Users/me/loro-notes',
  },
  {
    key: 'm2:p5',
    machineId: 'm2' as never,
    localProjectId: 'p5' as never,
    name: 'website',
    rootPath: 'Linux Box · /home/me/website',
  },
];

const REPOSITORIES = [
  { fullName: 'loro-dev/lody' },
  { fullName: 'loro-dev/loro' },
  { fullName: 'loro-dev/loro-mirror' },
];

const handlers = {
  onCreateMoreChange: () => {},
  onSubmit: () => {},
  onClose: () => {},
  onAddLocalProject: () => {},
  onConnectGitRepo: () => {},
};

export const Default: Story = {
  args: {
    open: true,
    createMore: false,
    ...handlers,
  },
};

export const CreateMore: Story = {
  args: { ...Default.args, createMore: true },
};

export const Submitting: Story = {
  args: { ...Default.args, submitting: true },
};

/** 属性 chip 行：状态 + 项目。两者都有默认值，创建仍然零必填。 */
export const WithProperties: Story = {
  args: {
    ...Default.args,
    localProjects: LOCAL_PROJECTS,
    repositories: REPOSITORIES,
  },
};

/** 从看板某一列的 + 打开时，状态 chip 直接落在那一列。 */
export const OpenedFromInProgressColumn: Story = {
  args: {
    ...Default.args,
    localProjects: LOCAL_PROJECTS,
    repositories: REPOSITORIES,
    initialStatus: 'in_progress',
  },
};

/**
 * 没有任何项目可选时，项目 chip 整个不出现 —— 一个永远点不出东西的下拉只会
 * 让人以为坏了。
 */
export const NoProjectsAvailable: Story = {
  args: { ...Default.args, localProjects: [], repositories: [] },
};

/**
 * 打开 Project 选择器、输入过滤词。列表里应该只剩 "loro-mirror" 相关项
 * （本地一个、GitHub 一个）——复用 landing page 选择器的原因：项目一多，
 * 纯下拉列表就不可用了。
 */
export const SearchableProjects: Story = {
  args: {
    ...Default.args,
    localProjects: LOCAL_PROJECTS,
    repositories: REPOSITORIES,
  },
  play: async ({ canvasElement }) => {
    // The Dialog itself is Radix-portalled to document.body (as is the
    // dropdown's popover content nested inside it), so nothing in this
    // story is actually a descendant of canvasElement — query the body.
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole('button', { name: /select a project/i }));
    const searchInput = await body.findByPlaceholderText(/search projects/i);
    await userEvent.type(searchInput, 'mirror');
  },
};

/** 可交互：勾选 Create More 后创建不会关闭弹窗。 */
export const Interactive: Story = {
  args: Default.args,
  render: function InteractiveStory(args) {
    const [createMore, setCreateMore] = useState(false);
    const [created, setCreated] = useState<string[]>([]);
    return (
      <div className="flex flex-col gap-3">
        <TaskQuickAddDialog
          {...args}
          open
          createMore={createMore}
          onCreateMoreChange={setCreateMore}
          onSubmit={(input) => setCreated((previous) => [...previous, input.title || input.body])}
          onClose={() => {}}
        />
        <ul className="text-xs text-muted-foreground">
          {created.map((entry, index) => (
            <li key={`${entry}-${index}`}>created: {entry}</li>
          ))}
        </ul>
      </div>
    );
  },
};
