import { getIpcServices, onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';
import type {
  TerminalChannel,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalSnapshot,
  TerminalTitleEvent,
  Unsubscribe,
} from './terminal-channel';

export class ElectronTerminalChannel implements TerminalChannel {
  list(sessionId: string): Promise<TerminalSnapshot[]> {
    return getIpcServices()!.terminal.list(sessionId);
  }

  open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    return getIpcServices()!.terminal.open(params);
  }

  attach(terminalId: string, cols: number, rows: number): void {
    sendIpc('terminal.attach', { terminalId, cols, rows });
  }

  input(terminalId: string, data: string): void {
    sendIpc('terminal.input', { terminalId, data });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    sendIpc('terminal.resize', { terminalId, cols, rows });
  }

  close(terminalId: string): void {
    sendIpc('terminal.close', { terminalId });
  }

  closeSession(sessionId: string): void {
    sendIpc('terminal.closeSession', { sessionId });
  }

  async readClipboardText(): Promise<string> {
    return await getIpcServices()!.terminal.readClipboardText();
  }

  writeClipboardText(text: string): void {
    void getIpcServices()!.terminal.writeClipboardText(text);
  }

  onData(handler: (event: TerminalDataEvent) => void): Unsubscribe {
    return onIpcEvent('terminal.event', (event) => {
      if (event.type === 'data') handler(event);
    });
  }

  onExit(handler: (event: TerminalExitEvent) => void): Unsubscribe {
    return onIpcEvent('terminal.event', (event) => {
      if (event.type === 'exit') handler(event);
    });
  }

  onTitle(handler: (event: TerminalTitleEvent) => void): Unsubscribe {
    return onIpcEvent('terminal.event', (event) => {
      if (event.type === 'title') handler(event);
    });
  }
}

export function createElectronTerminalChannel(): ElectronTerminalChannel | null {
  return getIpcServices() ? new ElectronTerminalChannel() : null;
}
