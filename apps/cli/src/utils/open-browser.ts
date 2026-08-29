import { exec } from 'child_process';

function buildCommand(url: string): string {
  const quotedUrl = `"${url.replace(/"/g, '\\"')}"`;
  switch (process.platform) {
    case 'darwin':
      return `open ${quotedUrl}`;
    case 'win32':
      // Use cmd to ensure the built-in START command is available.
      return `cmd /c start "" ${quotedUrl.replace(/&/g, '^&')}`;
    default:
      return `xdg-open ${quotedUrl}`;
  }
}

export async function openBrowser(url: string): Promise<void> {
  const command = buildCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = exec(command, { windowsHide: true }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });

    child.on('error', reject);
  });
}
