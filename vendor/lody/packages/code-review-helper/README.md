# @lody/code-review-helper

Standalone local code-review renderer and agent prompt package for Lody.

## Review file format (`.review.md`)

A `.review.md` file organizes a PR or commit range into human-reviewable groups.

### Frontmatter

```yaml
---
review_version: 1
merge_base: <full base sha>
current_commit: <full head sha>
base_ref: <optional base ref>
line_budget: 1500
pr_number: <optional PR number>
pr_url: <optional PR URL>
pr_title: <optional PR title>
---
```

### Overall summary

After the frontmatter, write a single `# Title` heading and a short prose summary.
This is rendered as the change overview.

### Groups

Each group starts with `## Group: <title>` and contains:

- Optional `Changed lines: <n>` and `Commits: \`sha\`, \`sha\`` metadata.
- A structured description (Purpose, Flow, Invariants, Risks, Reviewer checklist).
- One or more code blocks:
  - `changes://path?old=Lx-Ly&new=La-Lb` — a changed file (diff). Omit ranges when the
    whole file is small enough to review.
  - `context://path?range=Lx-Ly` — an unchanged file or unchanged range referenced for
    context. The renderer shows only the requested range plus surrounding lines.
- Line notes bound to the nearest preceding block:

```md
- INFO `new://L42`: neutral context.
- QUESTION `new://L45`: something unclear.
- WARNING `new://L50`: possible issue.
- ERROR `new://L55`: high-confidence bug or breaking change.
```

### Severity guidelines

- `ERROR` — use only when you are fairly sure there is a bug, breaking change, data
  loss, or security issue.
- `WARNING` — a real risk or scope concern that needs reviewer attention.
- `QUESTION` — uncertainty or a design question; lighter than `WARNING`.
- `INFO` (default) — context that helps reviewers understand the change.

### Line budget

`line_budget` is a soft guideline, not a hard limit. Groups should stay semantically
coherent; they may be much smaller or larger than the budget when the logic demands it.
