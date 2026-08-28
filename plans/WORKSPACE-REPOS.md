# Workspace repositories

A workspace owns its repository list. Members pick repositories through the
GitHub App, and only through the App. A personal access token can no longer
list or clone them.

## Two ways a workspace gets repositories

```
  create a workspace
        │
        ├── template selected ──►  repositories come from the template
        │                          the picker stays hidden
        │
        └── no template ────────►  the picker appears
                                   the member selects repositories
                        │
                        ▼
            ┌───────────────────────────┐
            │  saved on the workspace   │
            │  workspace_repos          │
            └─────────────┬─────────────┘
                          ▼
                 bootstrap clones them
```

The two sources never mix. A request that carries both a template and a
repository list is an error, not a merge. A silent winner turns a UI bug into a
wrong clone list that nobody can explain.

## The App is the only way

```
  GET /connections/github/repositories
        │
        ├── no grant   ──► 409 ──► "Connect GitHub"
        ├── PAT grant  ──► 409 ──► "Connect GitHub"
        └── App grant  ──► list repositories
```

A personal token cannot list repositories, and cannot put a private repository
in a workspace. A token that a person pastes carries whatever reach they chose
on github.com, and the product cannot see or trust that reach.

Cloning needs no new rule. A public repository clones without any credential. A
private one is already refused at create unless a credential exists. So an App
grant at create decides the clone as well.

The personal token stays useful for everything else: `blitz-cred get github`,
`gh`, and agent API calls.

## What to build

**1. App-only credentials.** The repository routes must refuse a personal-token
grant with 409. Delete the `/user/repos` fallback and the `source` field it
feeds; with one path left, that field says nothing.

**2. Workspace repositories.** Add a `workspace_repos` table that mirrors the
template one, with the `private` flag the server derives. Accept a repository
list on create, and use it only when no template is selected. Validate the
chosen list once: `owner/name` shape, a cap of 16, and no two repositories that
clone into the same directory.

**3. Picker on the create dialog.** Mount the existing picker when no template
is selected, and hide it when one is. Add the selection to the connect draft,
so it survives the round trip to GitHub.

## When a member creates a workspace

1. The member opens the create dialog.
2. With no template, the picker appears. Without an App grant it offers
   Connect.
3. Connect saves the draft, then leaves for GitHub. The member returns to the
   same dialog with their selection intact.
4. The member picks repositories and creates the workspace.
5. The control plane refuses the create if a private repository needs a
   credential the member does not hold.
6. The box clones the repositories at boot, with the member's own token.

## Known limits

- A workspace that already exists keeps no repository list. The table starts
  empty for them, and the boxes they booted are unaffected.
- A member who holds a personal token loses the picker until they connect the
  App. Connect replaces the grant, so nothing else is needed.
- The list is fixed at create. Add and remove come later.

---

## Appendix — decisions

**Store the list, do not only emit it.** Today the repository list lives in one
place: the bootstrap script, written once at create. Nothing in the database
knows what a workspace holds. A table costs one migration and buys the UI a
list to show, a failed clone a retry, and a new member a way to be seeded.
`MULTI-MEMBER-BOX.md` needs the same table, so the alternative is to write it
twice.

**Template or picker, never both.** Repositories on a template describe a
starting point that a team shares. Repositories on one workspace describe a
one-off. A member who wants both should edit the template.

**Refuse a personal token rather than fall back to it.** A fallback reads as a
convenience and behaves as a downgrade: the same screen would list different
repositories for two members, for reasons neither can see.
