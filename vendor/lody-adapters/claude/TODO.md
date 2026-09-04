# Lody Integration Follow-ups

These items track Lody-side integration work for Claude Code background
subagents. The adapter owns prompt settlement while spawned subagents remain
live; Lody should consume that lifecycle instead of implementing a second
background-task scheduler.

- [ ] Preserve `_meta.claudeCode.parentToolUseId` as a provider-neutral parent
      tool-call reference in persisted history, and group subagent tool activity
      under the corresponding Agent/Task entry in the UI.
- [ ] Add a cross-repository integration test proving that Lody remains in the
      working state after the initial result and finalizes only after the held ACP
      prompt returns following the subagent summary.
- [ ] Cover permission requests raised by a background subagent while the ACP
      prompt is held open, including successful response delivery and cancellation.
- [ ] Cover cancellation and acknowledged steering during a held turn, verifying
      that the prompt unblocks, logical-turn ownership changes correctly, and no
      output is attributed to the wrong assistant entry.
- [ ] Verify that ordinary background shell commands do not hold the turn open.
- [ ] Represent cancelled, killed, or stopped tasks separately from failed tasks
      so user-initiated cancellation is not rendered as a failure.
- [ ] Distinguish subagents, workflows, and background shell tasks in the task
      panel while keeping session busy state driven by ACP prompt completion rather
      than by UI task rows.
- [ ] Add a recovery test for a missing terminal task lifecycle notification so
      a cancelled or finalized turn cannot leave a permanently running task row.
