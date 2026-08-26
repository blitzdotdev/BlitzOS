# Automatic evals from real agent usage

Evals are not a subsystem in BlitzOS. They are one recipe — shipped as this
page, nothing seeded — whose prompt tells an agent to read the org's captured
agent usage and write eval tasks from it. This page covers the three parts:
turning on usage capture, building the eval recipe, and running evals later,
which is just another recipe.

Recipes live on the **Recipes** page in the webapp: a recipe is a workspace
template plus an invocation (harness, model, effort, prompt). Running one
creates a normal multiplayer workspace — you can open it mid-run, watch the
agent, or take over.

## What usage capture collects

With capture on, every workspace in the org mirrors its agents' **native
harness transcripts** into one org Drive folder named **Agent usage**:

- Claude Code project logs (what lands in `~/.claude/projects/` inside the
  box), and Codex session logs (`~/.codex/sessions/`). Headless recipe runs and
  terminal harness sessions both write these.
- The blobs are opaque vendor data. BlitzOS does not parse them; they already
  carry the full history, models, and token counts.
- Attribution is **per workspace**. Each workspace gets its own subtree with a
  small `meta.json` sidecar naming the workspace, its owner, and — when a
  recipe launched it — the recipe.

The folder layout, which the sidecar and the eval prompt below rely on:

```
Agent usage/
  <workspace-id>/
    meta.json          {workspaceId, recipeId, ownerName, workspaceName}
    claude/…           Claude Code transcripts (opaque)
    codex/…            Codex transcripts (opaque)
```

`recipeId` is `null` for workspaces people created by hand; recipe-launched
workspaces carry their recipe's id, so usage groups by routine without any
database access.

The folder is **admin-only by construction**: it is owned by the admin who
enabled capture, has no org-wide role, and the export is push-only — it is
never materialized into member workspaces. Transcripts contain everything the
agents saw, so grant access to this folder deliberately, like a credential.

## Enable it

1. Open **Settings → Usage** (the tab is visible to org admins only).
2. Turn on **Agent usage capture**.

The first enable lazy-creates the **Agent usage** folder and the panel links
to it in Drive. From then on, running workspaces sync their transcripts on the
regular file-sync cadence — expect the corpus to fill in within minutes of
agent activity, not instantly. Workspaces booted before the enable contribute
nothing until they are recreated; new workspaces capture from boot.

Turning capture off stops the export but keeps the folder and its id, so a
later re-enable appends to the same corpus instead of scattering it.

## Create the eval recipe

Two Drive-level pieces, then the recipe itself.

**1. The template.** On the **Templates** page, create a template (for
example "Eval authoring") that attaches:

- the **Agent usage** folder — the corpus, and
- a new, empty output folder — call it **Evals**.

Because the usage folder has no org-wide role, this template only yields the
corpus to people who hold a grant on it. A member who launches the recipe gets
a workspace *without* the usage folder — folders the launcher cannot read are
skipped, not leaked.

**2. The recipe.** On the **Recipes** page, create a recipe:

- **Template**: the one above.
- **Harness**: **Chat** — this schema label means a headless recipe run, not
  the unavailable native cockpit Chat surface. The prompt is delivered to the
  agent when the workspace boots.
- **Model**: pick one (a headless recipe must pin a model; the model selects
  the provider). Use a strong model — this is corpus analysis, not boilerplate.
- **Prompt**: paste the canonical prompt below.

**The canonical eval-authoring prompt:**

```text
You are building an eval suite from this organization's real agent usage.

Corpus: /workspace/shared/Agent usage/ — one directory per workspace. Each
<workspace-id>/ holds a meta.json sidecar ({workspaceId, recipeId,
ownerName, workspaceName}) beside raw harness transcripts under
claude/ and codex/. The transcripts are opaque vendor formats: read them for
content, never rewrite or reorganize them, and never copy secrets out of them.

1. Inventory the corpus. Group workspaces by recipeId from the sidecars;
   collect recipeId=null workspaces into ad-hoc groups by similar
   workspaceName and task content.
2. For each group, measure volume (workspaces, sessions, transcript bytes)
   and read enough transcripts to name the routine being performed, its
   typical inputs, and what a successful run actually produced.
3. Rank groups by volume and pick the top three to five routines — the
   highest-volume routine work is what is worth evaluating.
4. For each picked routine, write eval tasks into /workspace/shared/Evals/:
   - <routine>/task-<n>/task.md — a self-contained task prompt rebuilt from a
     real run's inputs, with no references back to the corpus.
   - <routine>/task-<n>/grader.md — pass/fail criteria a grading agent can
     apply to a candidate's transcript and output files, grounded in what
     successful real runs produced. Prefer checks on concrete artifacts.
5. Write /workspace/shared/Evals/README.md: the ranking, corpus coverage per
   routine, and the gaps where usage was too thin to write a fair grader.
```

**Run it.** Press **Run** on the recipe. The run is unattended by default —
the workspace boots, the prompt is delivered, and results land as files in
the **Evals** folder. It is still a normal workspace: open it from the rail to
watch the terminal or steer. When it finishes, review `Evals/README.md` and
the task files in Drive.

Re-running later regenerates evals against the grown corpus — same button.

## Running evals is just another recipe

Nothing here needs a runner or a scoring UI; executing the suite is one more
recipe. Make a template that attaches the **Evals** folder (and whatever the
tasks operate on, for example a repo folder), then a headless recipe (the
current schema's `Chat` harness) with a prompt along these lines:

```text
For each task under /workspace/shared/Evals/<routine>/task-<n>/: perform
task.md from a clean state, then evaluate your result against grader.md.
Write per-task verdicts and evidence to
/workspace/shared/Evals/results/<date>/<routine>/task-<n>.md, and finish with
a summary table in /workspace/shared/Evals/results/<date>/README.md.
```

Vary the pinned model between runs to compare models on your org's own work;
the results are files in Drive, so diffing two runs is reading two folders.
