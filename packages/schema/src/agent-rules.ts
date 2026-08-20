/** The envelope `GET /workspaces/self/agent-rules` returns to a box.
 *
 * This crosses a runtime boundary the other views do not: the producer is the
 * control-plane Worker and the consumer is a shell/Node reader baked into the
 * box image (`packages/box/rootfs/usr/local/bin/blitz-rules`). Both are pinned
 * to `packages/schema/fixtures/agent-rules/`. `version` is a content hash of
 * `content`, so a box can tell an edit from a redelivery. */
export interface AgentRulesResponse {
  version: string;
  content: string;
}

/** One selectable agent-rules document. The built-in doc is served in the same
 * list with `id: null` and `builtIn: true` so the picker can offer it — and
 * pre-fill an edit of it — without a second endpoint. */
export interface AgentRuleView {
  id: string | null;
  name: string;
  content: string;
  updatedAt: number | null;
  builtIn: boolean;
}

export interface ListAgentRulesResponse {
  rules: AgentRuleView[];
}

export interface PutAgentRuleRequest {
  name: string;
  content: string;
}

export interface PutAgentRuleResponse {
  rule: AgentRuleView;
}
