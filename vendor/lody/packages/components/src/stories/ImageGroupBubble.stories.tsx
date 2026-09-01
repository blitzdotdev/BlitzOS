import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { authTokenAtom } from '@/atoms/runtime';
import { ImageGroupBubble, type ImageBubbleAlign } from '@/components/ai-gui/view';

const STORY_WORKSPACE_ID = 'workspace-storybook' as WorkspaceId;
const STORY_SESSION_ID = 'session-storybook' as SessionId;
const STORY_AUTH_TOKEN = 'storybook-token';

const buildStorySvg = (label: string, from: string, to: string): string => `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" fill="none">
    <defs>
      <linearGradient id="bg" x1="96" y1="48" x2="1184" y2="672" gradientUnits="userSpaceOnUse">
        <stop stop-color="${from}" />
        <stop offset="1" stop-color="${to}" />
      </linearGradient>
    </defs>
    <rect width="1280" height="720" rx="48" fill="url(#bg)" />
    <rect x="72" y="72" width="1136" height="576" rx="36" fill="rgba(255,255,255,0.16)" />
    <rect x="120" y="132" width="420" height="40" rx="20" fill="rgba(255,255,255,0.45)" />
    <rect x="120" y="208" width="760" height="28" rx="14" fill="rgba(255,255,255,0.35)" />
    <rect x="120" y="260" width="520" height="28" rx="14" fill="rgba(255,255,255,0.28)" />
    <rect x="120" y="360" width="320" height="180" rx="24" fill="rgba(255,255,255,0.25)" />
    <rect x="480" y="360" width="320" height="180" rx="24" fill="rgba(255,255,255,0.2)" />
    <rect x="840" y="360" width="248" height="180" rx="24" fill="rgba(255,255,255,0.16)" />
    <text
      x="120"
      y="606"
      fill="white"
      font-family="ui-sans-serif, system-ui, sans-serif"
      font-size="54"
      font-weight="700"
    >
      ${label}
    </text>
  </svg>
`;

const storySvgByImageId = new Map<string, string>([
  ['img-1', buildStorySvg('Landing Page', '#0f766e', '#0f172a')],
  ['img-2', buildStorySvg('Settings Modal', '#b45309', '#7c2d12')],
  ['img-3', buildStorySvg('Table View', '#2563eb', '#312e81')],
  ['img-4', buildStorySvg('Mobile Layout', '#be185d', '#701a75')],
]);

const fallbackStorySvg = buildStorySvg('Image Preview', '#475569', '#0f172a');

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const getStoryImageIdFromRequest = (input: RequestInfo | URL): string | null => {
  const decoded = decodeURIComponent(getRequestUrl(input));
  const match = decoded.match(/\/api\/session-images\/[^/]+\/([^/?]+)/);
  return match?.[1] ?? null;
};

const installStoryImageFetchMock = (): void => {
  const marker = '__lodyImageGroupStoryFetchMockInstalled__';
  const globalRecord = globalThis as typeof globalThis & Record<string, unknown>;
  if (globalRecord[marker]) {
    return;
  }

  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (!originalFetch) {
    return;
  }

  globalRecord[marker] = true;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const imageId = getStoryImageIdFromRequest(input);
    if (!imageId) {
      return await originalFetch(input, init);
    }

    const svgMarkup = storySvgByImageId.get(imageId) ?? fallbackStorySvg;
    return new Response(new Blob([svgMarkup], { type: 'image/svg+xml' }), {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  };
};

installStoryImageFetchMock();

const storyImages = [
  {
    imageId: 'img-1',
    mimeType: 'image/png',
    fileName: 'landing-page.png',
    sizeBytes: 180_000,
    width: 1280,
    height: 720,
  },
  {
    imageId: 'img-2',
    mimeType: 'image/png',
    fileName: 'settings-modal.png',
    sizeBytes: 164_000,
    width: 1280,
    height: 720,
  },
  {
    imageId: 'img-3',
    mimeType: 'image/png',
    fileName: 'table-view.png',
    sizeBytes: 152_000,
    width: 1280,
    height: 720,
  },
  {
    imageId: 'img-4',
    mimeType: 'image/png',
    fileName: 'mobile-layout.png',
    sizeBytes: 141_000,
    width: 1280,
    height: 720,
  },
] as const;

type StoryPreviewProps = {
  align: ImageBubbleAlign;
  imageCount: 1 | 2 | 3 | 4;
  speaker: 'assistant' | 'user';
};

const createStoryStore = () => {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, STORY_WORKSPACE_ID);
  store.set(authTokenAtom, STORY_AUTH_TOKEN);
  return store;
};

function StoryPreview({ align, imageCount, speaker }: StoryPreviewProps) {
  const store = useMemo(() => createStoryStore(), []);
  const content = {
    type: 'image_group' as const,
    images: storyImages.slice(0, imageCount),
  };
  const bubbleTone =
    speaker === 'user'
      ? 'border-primary/20 bg-primary/10 dark:border-primary/30 dark:bg-primary/20'
      : 'border-border/70 bg-card';

  return (
    <Provider store={store}>
      <div className="mx-auto flex w-full max-w-4xl justify-center p-6">
        <div className="w-full max-w-[42rem] rounded-[28px] border border-dashed border-border/70 bg-muted/20 p-5">
          <div className={`flex w-full ${speaker === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`w-full max-w-[34rem] rounded-[24px] border p-4 shadow-xs ${bubbleTone}`}
            >
              <ImageGroupBubble
                content={content}
                sessionId={STORY_SESSION_ID}
                messageId="storybook-image-group"
                itemIndex={0}
                align={align}
              />
            </div>
          </div>
        </div>
      </div>
    </Provider>
  );
}

const meta = {
  title: 'AI/ImageGroupBubble',
  component: StoryPreview,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    align: 'start',
    imageCount: 1,
    speaker: 'assistant',
  },
} satisfies Meta<typeof StoryPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AssistantSingle: Story = {};

export const UserSingle: Story = {
  args: {
    align: 'end',
    speaker: 'user',
  },
};

export const TwoImageGrid: Story = {
  args: {
    imageCount: 2,
  },
};

export const ThreeImageGrid: Story = {
  args: {
    align: 'end',
    imageCount: 3,
    speaker: 'user',
  },
};

export const FourImageGrid: Story = {
  args: {
    imageCount: 4,
  },
};
