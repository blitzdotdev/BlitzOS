# Multi-member workspaces

Several people work in one workspace. Each person runs their own agent
sessions, holds their own credentials, and commits under their own account.
They share the machine, not the code.

```
                 ┌────────────────────────────────┐
                 │         control plane          │
                 │  one credential per member     │
                 └───────────────┬────────────────┘
                                 │ token for (workspace, member)
                                 ▼
┌──────────────────────────── the box ────────────────────────────┐
│                                                                 │
│  SHARED — everyone                                              │
│    dev server · packages · containers · database · caches       │
│    shared folders and files                                     │
│                                                                 │
│  PRIVATE — per member                                           │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│   │ X  admin     │  │ Y  editor    │  │ Z  viewer    │          │
│   │ own repos    │  │ own repos    │  │ no shell     │          │
│   │ own token    │  │ own token    │  │ watch only   │          │
│   └──────┬───────┘  └──────┬───────┘  └──────────────┘          │
│          │                 │                                    │
└──────────┼─────────────────┼────────────────────────────────────┘
           │ push direct     │ push → pull request
           ▼                 ▼
      ┌──────────────────────────────┐
      │            GitHub            │
      │  commits show X and Y        │
      └──────────────────────────────┘
```

## The idea

Give each member their own identity inside the box: their own Linux
user, their own credential, and their own copy of the code.

## What is shared

Split by content type, not by role.

| Content | Shared? | Why |
| --- | --- | --- |
| The machine and its services | shared | This is the reason to share a box. |
| Folders and files | shared | Plain files have no conflict problem. |
| Git repositories | private, per member | See below. |

Don't share git repos since one shared checkout means one index and one branch, so
agents block each other. It also means one `.git`, and a hook that one member
writes runs as another. Git already copies code between people, so a shared
checkout adds nothing.

## Roles

The role names already exist in the code: owner, editor, viewer.

| Role | Files | Repos | Sessions | Machine |
| --- | --- | --- | --- | --- |
| owner | write | own copy, push direct | watch and use | manage |
| editor | write | own copy, pull request | watch and use | no |
| viewer | read | none | watch only | no |

A viewer never opens a shell, so a viewer needs no Linux user.

State roles as capabilities, never as file permissions. "You propose code
changes with a pull request" is the product. "You cannot write here" is an
error message.

## When a member joins

1. The member opens the workspace. Shared files and services are ready.
2. The member connects GitHub if the workspace holds repositories.
3. The box copies the workspace's repositories into the member's own space,
   with their own credential.
4. The UI reports progress, and names any repository they cannot reach.

## What to build

**1. Identity.** The control plane must mint a credential for the acting
member, not for the workspace owner. The box must ask on behalf of the
session's member. The box already knows who each session belongs to.

**2. Isolation.** Create one Linux user per member, each with a private home
directory. `blitz-cred` must decide which credential to serve from the calling
user, not from an environment variable. Each member's repository directory must
resolve to their own.

**3. Content.** The workspace must own its repository list, because a template
can change after the workspace exists. Copy repositories with `git clone`,
never `git worktree`: a worktree writes into the source, and a clone does not
carry hooks.

Build 1 first. It stops the silent misattribution on its own. Build 2 as one
unit, because private directories without a user-aware `blitz-cred` protect
nothing. Build 3 last.

## For nontechnical people

Improve the folder tab to make /shared effectively a "Shared Drive". They can
drag and drop folders/files into this tab and everyone will be able to read it
they can control who can edit it. When new member joins a workspace, based on 
their role their Claude should receive rules that already orient it towards using
the shared drive for work.

## Open questions

1. **A viewer can read another member's tokens.** Credentials appear in session
   output, and a viewer watches that output. Choose: filter the stream, keep
   credentials out of watchable sessions, or state that a viewer is trusted.
2. **Attribution without git.** Commits identify a coder. Nothing yet
   identifies who changed a shared file. Per-member Linux users give ownership
   for free once Build 2 lands, but the product must say so.

## Known limits

- Members cannot see each other's uncommitted code. Code review happens through
  pull requests. Say this plainly, because "shared workspace" suggests
  otherwise.
- A member who leaves keeps a Linux user and files until something removes
  them.

---

## Appendix — decisions

**Trust: accepted.** The box states which member a session belongs to, and the
control plane believes it. A compromised box therefore reaches every member of
that workspace. The owner accepts this cost.

**Credentials on disk, one directory per member.** File permissions are real
kernel enforcement and need no privileged program. A setuid helper and a root
service were both rejected as more risk or more code.

**Share the machine, not the code.** A shared box gives one dev server, live
sessions others can watch, installed packages, a seeded database, and one VM's
cost. Separate boxes give none of that. Private checkouts cost none of it.

**Every member writes to their own repository directory.** An earlier shape
made that directory read-only for editors. Members then asked why a directory
existed that they could not use.
