import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  getServerNow,
  type AgentConfigMeta,
  type SessionId,
  type SessionMeta,
  type TaskId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { buildAgentPrompt } from '@/lib';
import { useSessionActions } from '@/hooks/use-session-actions';

export type TaskCommentMentions = {
  /** Agent config ids mentioned in the comment text. */
  agentConfigIds: string[];
};

/** Letters, digits and underscore in any script — a mention must not sit inside a word. */
const isMentionWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/**
 * Finds agent mentions in comment text.
 *
 * Matching is on the agent's configured name, longest first, so "@Design Agent"
 * is not shadowed by an agent called "Design". Only a mention makes a comment
 * dispatch; ordinary text never does.
 */
export const findTaskAgentMentions = (
  text: string,
  agents: readonly { id: string; name: string }[]
): TaskCommentMentions => {
  // Longest name first, and each match consumes its span: without consuming,
  // "@Design Agent" would also match an agent merely called "Design" and send
  // the comment to two agents.
  let remaining = text.toLowerCase();
  const matched: string[] = [];
  const sorted = [...agents].sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const agent of sorted) {
    const name = agent.name.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const token = `@${name}`;
    let searchFrom = 0;
    let found = false;
    for (;;) {
      const index = remaining.indexOf(token, searchFrom);
      if (index < 0) {
        break;
      }
      // A mention has to stand alone. Without these boundaries an agent called
      // "a" is dispatched by "@alice" and by any email address in the comment —
      // and a mention is the ONE thing that turns a comment into real work.
      const isMention =
        !isMentionWordChar(remaining[index - 1]) &&
        !isMentionWordChar(remaining[index + token.length]);
      if (!isMention) {
        searchFrom = index + 1;
        continue;
      }
      found = true;
      remaining =
        remaining.slice(0, index) +
        ' '.repeat(token.length) +
        remaining.slice(index + token.length);
      searchFrom = index + token.length;
    }
    if (found && !matched.includes(agent.id)) {
      matched.push(agent.id);
    }
  }
  return { agentConfigIds: matched };
};

/**
 * Finds people mentioned in a comment, matched against the task's own
 * participants — its owner and whoever has commented before.
 *
 * Scoped to participants on purpose: there is no query that lists workspace
 * members with display names, and inventing one would put member identities on a
 * new surface. "@owner, please review" is the case this needs to serve, and those
 * names are already recorded on the timeline entries.
 *
 * Shares `isMentionWordChar` with the agent matcher so a name inside a longer
 * word — or an email address — is not a mention here either.
 */
export const findTaskUserMentions = (
  text: string,
  participants: readonly { id: string; name: string }[]
): string[] => {
  let remaining = text.toLowerCase();
  const matched: string[] = [];
  const sorted = [...participants].sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const person of sorted) {
    const name = person.name.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const token = `@${name}`;
    let searchFrom = 0;
    let found = false;
    for (;;) {
      const index = remaining.indexOf(token, searchFrom);
      if (index < 0) {
        break;
      }
      if (
        isMentionWordChar(remaining[index - 1]) ||
        isMentionWordChar(remaining[index + token.length])
      ) {
        searchFrom = index + 1;
        continue;
      }
      found = true;
      remaining =
        remaining.slice(0, index) +
        ' '.repeat(token.length) +
        remaining.slice(index + token.length);
      searchFrom = index + token.length;
    }
    if (found && !matched.includes(person.id)) {
      matched.push(person.id);
    }
  }
  return matched;
};

export type TaskCommentDispatchTarget = {
  sessionId: SessionId;
  /** A running session takes the comment as a queued follow-up, not a new turn. */
  busy: boolean;
};

/**
 * Picks which linked session an @agent comment goes to.
 *
 * A running session wins: the agent is already working, and interrupting it with
 * a second turn is worse than queueing behind the current one. Otherwise the
 * most recently active session is the continuation point.
 */
export const resolveTaskCommentTarget = (
  sessions: readonly SessionMeta[],
  agentConfigIds: readonly string[]
): TaskCommentDispatchTarget | null => {
  // A mention names WHO should pick this up, so only that agent's sessions are
  // eligible. Falling back to any session would hand "@Codex please do X" to
  // whichever other agent happened to be working here — and the caller resolves
  // the prompt config from the session, so that agent would be told it was
  // mentioned when it was not. With no session for the mentioned agent the
  // caller reports `no_session` and the UI points at Run instead.
  const pool =
    agentConfigIds.length > 0
      ? sessions.filter(
          (session) =>
            session.agentConfigId !== undefined && agentConfigIds.includes(session.agentConfigId)
        )
      : sessions;
  if (pool.length === 0) {
    return null;
  }

  const isBusy = (session: SessionMeta): boolean =>
    session.status?.type === 'running' || session.status?.type === 'initializing';

  const running = pool.find(isBusy);
  if (running) {
    return { sessionId: running.id, busy: true };
  }

  const mostRecent = [...pool].sort(
    (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)
  )[0];
  return mostRecent ? { sessionId: mostRecent.id, busy: false } : null;
};

/**
 * The prompt an @agent comment becomes.
 *
 * The quoted fragment has to travel with it: "@agent fix this" is meaningless to
 * the agent without the text "this" refers to, and the quote is the only record
 * of what the person had selected.
 */
export const buildTaskCommentPrompt = (
  taskTitle: string,
  comment: string,
  quote?: string
): string => {
  const trimmedQuote = quote?.trim();
  const quoted = trimmedQuote
    ? `${trimmedQuote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`
    : '';
  return `A comment on the task “${taskTitle}” mentions you:\n\n${quoted}${comment}`;
};

export type TaskCommentDispatchResult =
  | { ok: true; sessionId: SessionId; queued: boolean }
  | { ok: false; reason: 'no_mention' | 'no_session' | 'not_ready' };

/**
 * Sends an @agent task comment into a session.
 *
 * This is the one path by which a comment becomes work. Execution stays in the
 * session — the thread is where it is asked for, not where it happens — so the
 * comment records which session took it and the user can follow it there.
 */
export function useTaskCommentDispatch() {
  const user = useAtomValue(userAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom) as AgentConfigMeta[];
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { addSessionHistory } = useSessionActions();

  return useCallback(
    async (input: {
      taskId: TaskId;
      taskTitle: string;
      comment: string;
      /** Body fragment the comment is replying to, if the user quoted one. */
      quote?: string;
      sessions: readonly SessionMeta[];
    }): Promise<TaskCommentDispatchResult> => {
      const userId = user?.id;
      if (!userId || !runtime) {
        return { ok: false, reason: 'not_ready' };
      }

      const mentions = findTaskAgentMentions(
        input.comment,
        agentConfigs.map((config) => ({ id: config.id as string, name: config.name }))
      );
      if (mentions.agentConfigIds.length === 0) {
        return { ok: false, reason: 'no_mention' };
      }

      const target = resolveTaskCommentTarget(input.sessions, mentions.agentConfigIds);
      if (!target) {
        return { ok: false, reason: 'no_session' };
      }

      const session = input.sessions.find((entry) => entry.id === target.sessionId);
      const config =
        agentConfigs.find((entry) => entry.id === session?.agentConfigId) ??
        agentConfigs.find((entry) => (entry.id as string) === mentions.agentConfigIds[0]);
      if (!config) {
        return { ok: false, reason: 'not_ready' };
      }

      const promptText = buildTaskCommentPrompt(input.taskTitle, input.comment, input.quote);
      const inputBlocks = [{ type: 'text' as const, text: input.comment }];
      const inputConfig = buildSessionTurnInputConfig({
        inputBlocks,
        prompt: buildAgentPrompt(promptText, config.prompt ?? ''),
        cliType: config.cliType,
        agentType: config.agentType,
        taskToolsEnabled: true,
      });

      if (target.busy) {
        // The agent is mid-turn: queue the comment instead of racing it.
        await runtime.writer.enqueueSessionMessage(target.sessionId, {
          task: promptText,
          userId,
          timestamp: new Date(getServerNow()).toISOString(),
          isEditing: false,
          acpSessionConfig: { ...inputConfig, chainDepth: 0 },
        });
        return { ok: true, sessionId: target.sessionId, queued: true };
      }

      const entry = buildPendingUserHistoryEntry({
        userId,
        inputBlocks,
        timestamp: new Date(getServerNow()).toISOString(),
        inputConfig,
      });
      if (!entry) {
        return { ok: false, reason: 'not_ready' };
      }
      await addSessionHistory(target.sessionId, entry, { dispatch: true });
      return { ok: true, sessionId: target.sessionId, queued: false };
    },
    [addSessionHistory, agentConfigs, runtime, user?.id]
  );
}
