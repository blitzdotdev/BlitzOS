import preset from '@lody/configs/tailwind-preset';

const streamdownContent = [
  './node_modules/streamdown/dist/**/*.js',
  './node_modules/@streamdown/*/dist/**/*.js',
  '../../node_modules/.pnpm/streamdown*/node_modules/streamdown/dist/**/*.js',
  '../../node_modules/.pnpm/@streamdown+*/node_modules/@streamdown/*/dist/**/*.js',
];

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/components/src/**/*.{js,ts,jsx,tsx}',
    ...streamdownContent,
  ],
};
