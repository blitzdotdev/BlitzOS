// blitzscript — llm.mjs is now a DEPRECATED re-export shim.
//
// The leaf + resource layer moved to ./agent.mjs (renamed llm() -> agent(), refactored to a per-run
// RunContext — see plans/blitzos-blitzscript-claude-interface.md §5). This shim keeps every existing
// import working: the legacy examples (naming-tournament, workflow-patterns), the built-in library
// (verify-job, supervise-tick), and the unit tests (test-blitz-llm / -journal / -library /
// -orchestrator), which import { llm, _setSpawn, _resetJournal, _stats, _setCaps, leafMetadata } from
// here. (The orchestrator duty no longer imports anything — it uses the injected-globals interface.)
//
// NEW workflows do NOT import anything — `agent` (and parallel/pipeline/phase/log/args/budget/workflow)
// are injected as globals by the runtime loader (runtime.mjs). Prefer agent.mjs directly for new code.

export {
  agent,
  agent as llm,
  _setSpawn,
  _resetJournal,
  _stats,
  _setCaps,
  _spawn,
  leafMetadata,
  RunContext,
  withRunContext,
  getRunContext,
  WorkflowBudgetExceededError,
  MAX_CONCURRENCY,
} from './agent.mjs'

import { agent } from './agent.mjs'
export default agent
