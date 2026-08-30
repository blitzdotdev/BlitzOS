import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { PreviewSelect } from '@/components/settings/preview-select';
import type { PreviewSelectOption } from '@/components/settings/preview-select';

const meta = {
  title: 'Settings/PreviewSelect',
  component: PreviewSelect,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PreviewSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

const simpleOptions: PreviewSelectOption<string>[] = [
  { value: 'option-a', label: 'Option A' },
  { value: 'option-b', label: 'Option B' },
  { value: 'option-c', label: 'Option C' },
];

const themeOptions: PreviewSelectOption<string>[] = [
  {
    value: 'light',
    label: (
      <div className="flex items-center gap-2">
        <Sun className="h-4 w-4" />
        <span>Light</span>
      </div>
    ),
  },
  {
    value: 'dark',
    label: (
      <div className="flex items-center gap-2">
        <Moon className="h-4 w-4" />
        <span>Dark</span>
      </div>
    ),
  },
  {
    value: 'system',
    label: (
      <div className="flex items-center gap-2">
        <Monitor className="h-4 w-4" />
        <span>System</span>
      </div>
    ),
  },
];

export const Basic: Story = {
  args: {
    value: 'option-a',
    options: simpleOptions,
    onPreview: () => {},
    onCommit: () => {},
    onCancel: () => {},
  },
};

export const WithIcons: Story = {
  args: {
    value: 'light',
    options: themeOptions,
    onPreview: () => {},
    onCommit: () => {},
    onCancel: () => {},
    triggerClassName: 'w-[220px]',
  },
};

function InteractiveDemo() {
  const [value, setValue] = useState('light');
  const [previewValue, setPreviewValue] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <PreviewSelect
        value={value}
        options={themeOptions}
        onPreview={(v) => setPreviewValue(v)}
        onCommit={(v) => {
          setValue(v);
          setPreviewValue(null);
        }}
        onCancel={() => setPreviewValue(null)}
        triggerClassName="w-[220px]"
      />
      <div className="text-sm text-muted-foreground">
        <div>Committed: {value}</div>
        {previewValue && <div>Previewing: {previewValue}</div>}
      </div>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <InteractiveDemo />,
  args: {
    value: 'light',
    options: themeOptions,
    onPreview: () => {},
    onCommit: () => {},
    onCancel: () => {},
  },
};
