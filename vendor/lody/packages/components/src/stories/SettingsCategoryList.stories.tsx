import type { Meta, StoryObj } from '@storybook/react';
import {
  SettingsCategoryList,
  SettingsCategoryGrid,
} from '@/components/settings/settings-category-list';
import { MemoryRouter } from 'react-router-dom';

/**
 * SettingsCategoryList 组件的 Storybook 故事
 * 展示设置分类列表组件，用于移动端首页导航
 */
const meta = {
  title: 'Settings/SettingsCategoryList',
  component: SettingsCategoryList,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof SettingsCategoryList>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 移动端列表视图
 * 默认的移动端垂直列表布局
 */
export const Mobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

/**
 * 平板端视图
 * 在平板尺寸下的显示效果
 */
export const Tablet: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'tablet',
    },
  },
};

/**
 * 暗色主题移动端
 * 在暗色主题下的移动端显示效果
 */
export const DarkModeMobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
    backgrounds: {
      default: 'dark',
    },
  },
  decorators: [
    (Story) => (
      <div className="dark">
        <Story />
      </div>
    ),
  ],
};

/**
 * 网格布局组件的 Storybook 故事
 * 展示桌面端网格布局版本
 */
const gridMeta = {
  title: 'Settings/SettingsCategoryGrid',
  component: SettingsCategoryGrid,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof SettingsCategoryGrid>;

export const GridLayout: StoryObj<typeof gridMeta> = {
  render: () => <SettingsCategoryGrid />,
};

/**
 * 桌面端网格布局
 * 2列网格布局，适合较大屏幕
 */
export const DesktopGrid: StoryObj<typeof gridMeta> = {
  render: () => <SettingsCategoryGrid />,
  parameters: {
    viewport: {
      defaultViewport: 'responsive',
    },
  },
};

/**
 * 暗色主题网格布局
 * 在暗色主题下的网格布局效果
 */
export const DarkModeGrid: StoryObj<typeof gridMeta> = {
  render: () => <SettingsCategoryGrid />,
  parameters: {
    backgrounds: {
      default: 'dark',
    },
  },
  decorators: [
    (Story) => (
      <div className="dark">
        <Story />
      </div>
    ),
  ],
};

/**
 * 响应式布局测试
 * 展示从移动端到桌面端的响应式变化
 */
export const ResponsiveTest: Story = {
  render: () => (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-semibold mb-4">Mobile Layout (List)</h3>
        <div className="border rounded-lg overflow-hidden" style={{ width: '375px' }}>
          <SettingsCategoryList />
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Desktop Layout (Grid)</h3>
        <div className="border rounded-lg overflow-hidden" style={{ width: '800px' }}>
          <SettingsCategoryGrid />
        </div>
      </div>
    </div>
  ),
  parameters: {
    layout: 'padded',
  },
};
