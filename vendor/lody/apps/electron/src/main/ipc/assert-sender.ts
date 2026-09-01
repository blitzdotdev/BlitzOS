import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export function assertMainWindowSender(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
): void {
  const mainWindow = getMainWindow()
  const senderUrl = event.senderFrame?.url
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  let hasAllowedUrl = false
  try {
    const parsedSender = new URL(senderUrl ?? '')
    hasAllowedUrl = devRendererUrl
      ? parsedSender.origin === new URL(devRendererUrl).origin
      : parsedSender.protocol === 'file:' &&
        parsedSender.pathname.endsWith('/out/renderer/index.html')
  } catch {
    hasAllowedUrl = false
  }

  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !hasAllowedUrl
  ) {
    throw new Error('Rejected auth IPC from an untrusted renderer')
  }
}
