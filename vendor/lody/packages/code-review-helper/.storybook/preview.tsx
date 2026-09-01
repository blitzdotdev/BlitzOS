import type { Preview } from '@storybook/react-vite';
import { CodeReviewThemeProvider } from '../src/react/theme-provider';

import '../src/react/styles.css';

const preview: Preview = {
  decorators: [
    (Story) => (
      <CodeReviewThemeProvider>
        <Story />
      </CodeReviewThemeProvider>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
