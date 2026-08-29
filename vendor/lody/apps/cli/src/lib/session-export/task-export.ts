import type { TaskSnapshot } from '@/lib/task-doc';

export type TaskIndexExportEntry = {
  taskId: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  relativePath: string;
};

/**
 * Renders a task as the Markdown a person actually wants out of an export: the
 * body verbatim (it is already the authored source format), preceded by the
 * fields that do not survive as prose and followed by the thread.
 */
export function formatTaskMarkdown(snapshot: TaskSnapshot): string {
  const { meta } = snapshot;
  const lines: string[] = [`# ${meta.title || 'Untitled task'}`, ''];
  lines.push(`- Status: ${meta.status}`);
  if (meta.ownerId) {
    lines.push(`- Owner: ${meta.ownerId}`);
  }
  if (meta.agent?.agentConfigId) {
    lines.push(`- Agent: ${meta.agent.agentConfigId}`);
  }
  lines.push('');

  const body = snapshot.body.trim();
  lines.push(body.length > 0 ? body : '_No description._');

  const links = snapshot.links.filter((link) => link.removedAt === undefined);
  if (links.length > 0) {
    lines.push('', '## Links', '');
    for (const link of links) {
      lines.push(
        link.kind === 'session'
          ? `- Session \`${link.sessionId}\`${link.origin ? ` (${link.origin})` : ''}`
          : `- ${link.url ?? 'Pull request'}`
      );
    }
  }

  const comments = snapshot.timeline.filter((entry) => entry.kind === 'comment');
  if (comments.length > 0) {
    lines.push('', '## Thread', '');
    for (const comment of comments) {
      const author = comment.actorName ?? comment.actorId ?? comment.actorKind;
      lines.push(`### ${author}`, '', (comment.body ?? '').trim(), '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildTaskIndexExportEntry(snapshot: TaskSnapshot): TaskIndexExportEntry {
  return {
    taskId: snapshot.meta.taskId,
    title: snapshot.meta.title,
    status: snapshot.meta.status,
    createdAt: snapshot.meta.createdAt,
    updatedAt: snapshot.meta.updatedAt,
    relativePath: `tasks/${snapshot.meta.taskId}`,
  };
}

export function sortTasksByCreatedAt(snapshots: readonly TaskSnapshot[]): TaskSnapshot[] {
  return [...snapshots].sort((left, right) => {
    const delta = (left.meta.createdAt ?? 0) - (right.meta.createdAt ?? 0);
    return delta !== 0 ? delta : left.meta.taskId.localeCompare(right.meta.taskId);
  });
}
