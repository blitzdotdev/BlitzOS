import { promises as fs } from 'node:fs';

const ALLOWED_PLACEHOLDER_ENTRIES = new Set([
  '.DS_Store',
  '.gitignore',
  '.gitkeep',
  'Thumbs.db',
  'desktop.ini',
]);

export async function prepareExportOutputDir(outputDir: string): Promise<void> {
  try {
    const stats = await fs.stat(outputDir);
    if (!stats.isDirectory()) {
      throw new Error(`Output path exists and is not a directory: ${outputDir}`);
    }

    const entries = await fs.readdir(outputDir);
    const blockingEntries = entries.filter((entry) => !ALLOWED_PLACEHOLDER_ENTRIES.has(entry));
    if (blockingEntries.length > 0) {
      throw new Error(
        `Output directory is not empty: ${outputDir} (found: ${blockingEntries.join(', ')})`
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      await fs.mkdir(outputDir, { recursive: true });
      return;
    }
    throw error;
  }
}
