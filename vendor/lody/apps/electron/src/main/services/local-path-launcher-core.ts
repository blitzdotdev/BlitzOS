import type {
  LaunchLocalPathInput,
  LaunchLocalPathResult,
  LocalPathCommandSpec
} from '@lody/shared/electron-ipc'

type CommandLaunchInput = Extract<LaunchLocalPathInput, { kind: 'command' }>

export async function launchCommandPathWithFallback(
  input: CommandLaunchInput,
  launchCommand: (command: LocalPathCommandSpec) => Promise<LaunchLocalPathResult>,
  launchUrl: (url: string) => Promise<LaunchLocalPathResult>
): Promise<LaunchLocalPathResult> {
  let lastResult = await launchCommand(input.command)
  if (lastResult.launched) {
    return lastResult
  }

  for (const fallback of input.fallbackCommands ?? []) {
    lastResult = await launchCommand(fallback)
    if (lastResult.launched) {
      return lastResult
    }
  }

  if (input.fallbackUrl) {
    return await launchUrl(input.fallbackUrl)
  }

  return lastResult
}
