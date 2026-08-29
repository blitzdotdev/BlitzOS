const preset = require('@lody/configs/tailwind-preset')

const streamdownContent = [
  '../../packages/components/node_modules/streamdown/dist/**/*.js',
  '../../packages/components/node_modules/@streamdown/*/dist/**/*.js',
  '../../node_modules/.pnpm/streamdown*/node_modules/streamdown/dist/**/*.js',
  '../../node_modules/.pnpm/@streamdown+*/node_modules/@streamdown/*/dist/**/*.js'
]

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  darkMode: ['class'],
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/components/src/**/*.{js,ts,jsx,tsx}',
    ...streamdownContent
  ]
}
