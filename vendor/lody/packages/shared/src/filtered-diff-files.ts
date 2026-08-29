const FILTERED_DIFF_EXACT_NAMES = new Set([
  // JavaScript / Node
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'shrinkwrap.json',
  // Rust
  'Cargo.lock',
  // Ruby
  'Gemfile.lock',
  // Python
  'poetry.lock',
  'Pipfile.lock',
  'pdm.lock',
  'uv.lock',
  // PHP
  'composer.lock',
  // Go
  'go.sum',
  // Nix
  'flake.lock',
  // Dart / Flutter
  'pubspec.lock',
  // iOS / Swift
  'Podfile.lock',
  'Package.resolved',
  // Elixir
  'mix.lock',
  // .NET
  'packages.lock.json',
  // Java / Kotlin
  'gradle.lockfile',
]);

const FILTERED_DIFF_EXTENSIONS = ['.lock', '.min.js', '.min.css', '.map'];

export function isFilteredDiffFile(filePath: string): boolean {
  const basename = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  if (FILTERED_DIFF_EXACT_NAMES.has(basename)) return true;
  return FILTERED_DIFF_EXTENSIONS.some((ext) => basename.endsWith(ext));
}
