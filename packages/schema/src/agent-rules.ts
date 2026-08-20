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
