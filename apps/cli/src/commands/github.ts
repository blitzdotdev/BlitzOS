import { Command } from 'commander';
import {
  getAuthContextOrThrow,
  printJson,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { renderTerminalTable } from '@/lib/terminal-table';
import {
  listWorkspaceGitHubRepositoriesForCliToken,
  type WorkspaceGitHubRepository,
} from '@/lib/workspace';

type GitHubListOptions = Pick<CommonCommandOptions, 'workspace' | 'json' | 'debug'>;

export function sortGitHubRepositories(
  repositories: WorkspaceGitHubRepository[]
): WorkspaceGitHubRepository[] {
  return [...repositories].sort((left, right) => {
    const fullNameCompare = left.fullName.localeCompare(right.fullName);
    if (fullNameCompare !== 0) {
      return fullNameCompare;
    }

    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return left.id - right.id;
  });
}

function formatRepositoryVisibility(
  repository: Pick<WorkspaceGitHubRepository, 'private'>
): string {
  return repository.private ? 'private' : 'public';
}

function printHumanRepositoryList(repositories: WorkspaceGitHubRepository[]): void {
  if (repositories.length === 0) {
    console.log('No GitHub repositories found.');
    return;
  }

  console.log(
    renderTerminalTable(
      [{ header: 'ID' }, { header: 'Repository' }, { header: 'Visibility' }],
      repositories.map((repository) => [
        repository.id,
        repository.fullName,
        formatRepositoryVisibility(repository),
      ])
    )
  );
}

export const githubCommand = new Command('github')
  .description('Manage GitHub repositories linked to a workspace')
  .addCommand(
    new Command('list')
      .description('List GitHub repositories linked to a workspace')
      .option('--workspace <selector>', 'Target workspace id, slug, or name')
      .option('--json', 'Print JSON output')
      .option('--debug', 'Enable debug output')
      .action(async (options: GitHubListOptions) => {
        await runOneShotCommand('github', options, async () => {
          const auth = getAuthContextOrThrow('github');
          const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
          const repositories = sortGitHubRepositories(
            await listWorkspaceGitHubRepositoriesForCliToken({
              token: auth.token,
              workspaceId: workspace.id,
            })
          );

          if (options.json) {
            printJson({
              ok: true,
              workspaceId: workspace.id,
              repositories: repositories.map((repository) => ({
                id: repository.id,
                name: repository.name,
                fullName: repository.fullName,
                private: repository.private,
              })),
            });
            return;
          }

          printHumanRepositoryList(repositories);
        });
      })
  );
