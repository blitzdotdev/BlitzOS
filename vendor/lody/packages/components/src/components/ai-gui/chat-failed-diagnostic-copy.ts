import type { ChatFailedCode } from '@lody/shared';

export type ChatFailedDiagnosticCopy = {
  titleKey: string;
  title: string;
  actionKey: string;
  action: string;
};

export function getChatFailedDiagnosticCopy(
  code: ChatFailedCode | undefined
): ChatFailedDiagnosticCopy | null {
  if (code !== 'git_executable_not_found') {
    return null;
  }

  return {
    titleKey: 'sessions.systemNotices.chatFailed.gitExecutableNotFound',
    title: 'Git executable was not found on the target machine',
    actionKey: 'sessions.systemNotices.chatFailed.gitExecutableNotFoundAction',
    action:
      'Install Git for Windows or add git.exe to PATH, fully restart Lody/CLI, verify “git --version” in a new terminal, then try again.',
  };
}
