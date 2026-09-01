import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import { MobileFileViewerDrawer } from '@/components/mobile/mobile-file-viewer-drawer';
import { SessionFileErrorState } from '@/components/sessions/session-file-error-state';

function MobileFileViewerDrawerStory({ error }: { readonly error?: string }) {
  const [open, setOpen] = useState(true);
  const filePath = 'docs/README.md';

  return (
    <main className="h-dvh bg-background">
      <MobileFileViewerDrawer
        open={open}
        onOpenChange={setOpen}
        filePath={filePath}
        onCopyPath={fn()}
        onCopyMarkdown={fn()}
      >
        {error ? (
          <SessionFileErrorState message={error} />
        ) : (
          <pre className="h-full overflow-auto p-4 font-mono text-xs leading-5 text-foreground">
            {'# Project documentation\n\nLong-press to select this Markdown source.\n'}
          </pre>
        )}
      </MobileFileViewerDrawer>
    </main>
  );
}

const meta = {
  title: 'Mobile/MobileFileViewerDrawer',
  component: MobileFileViewerDrawerStory,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof MobileFileViewerDrawerStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FileContent: Story = {
  args: {},
};

export const OutsideWorkspaceError: Story = {
  args: {
    error: 'Path escapes workspace root.',
  },
};
