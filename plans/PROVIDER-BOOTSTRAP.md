# Decision: each provider supplies its own bootstrap parts

Written 2026-08-25. This is a trade made at one moment, with the facts below.
It is not a rule. The last section says what would overturn it.

## What we decided

`VmProvider` gains an optional bootstrap contribution. A provider supplies the
setup lines only its own machines need. `core/bootstrap.ts` keeps the parts
every box needs, and asks the resolved provider for the rest.

AWS supplies the Canonical EC2 mirror probe. Hetzner supplies nothing.

## Why: the incident

Canary could not create any Hetzner workspace. Every one failed:

```
bootstrap failed: bootstrap failed at line 84 (exit 1)
```

Line 2 of the emitted script is `set -Eeuo pipefail`. Line 84 was:

```
ec2_mirror=$(grep -rhoE 'https?://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com' \
  /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -1)
```

That probe exists because Canonical's regional EC2 mirrors accept a connection
and then never answer. On a Hetzner box no such mirror exists. `grep` finds
nothing and exits 1. `pipefail` carries that to the pipeline. The assignment
then returns 1, and `set -e` stops the script.

So AWS code killed every non-AWS box, before it installed anything.

The fault hid for a long time. Canary had made 35 workspaces and every one used
AWS. The first Hetzner box appeared only after we repaired the canary
`HETZNER_API_TOKEN`, and it failed at once.

## What we rejected

**Add `|| true` to the assignment.** An empty result IS the correct meaning
here, so the line would work. But AWS-only code would still run on every box.
The next provider-specific line would fail the same way, somewhere else.

**Prebaked images for each provider.** Bake docker into one image per provider.
Bootstrap then installs nothing, and every mirror probe, timeout and fallback
goes away. Boot also gets much faster. We did not choose it now because it is a
build pipeline for each provider, with AMI copies for each region and an image
pin to keep, and Hetzner workspaces were broken at the time. It stays the
better long answer.

## Why this shape

`CLAUDE.md` already states the rule: capabilities are per-provider, and you ask
the resolved provider, never a global. Shared bootstrap holding AWS-only lines
broke that rule. This decision applies the rule that was already written.

## What would overturn this

Any one of these, alone, is enough to revisit:

- We build prebaked images per provider. Then the apt section leaves the shared
  script, and most of the seam has nothing left to carry.
- The contributions from two providers start to overlap. Shared setup with a
  provider flag is then simpler than two near-copies.
- A provider needs to change a part of bootstrap the seam does not reach. Do
  not bend the seam around it. Ask whether prebaked images answer it better.

Do not treat "every provider-specific line goes behind the seam" as a law. The
seam exists to keep one provider's fault away from another provider's box. A
line that every provider runs the same way belongs in the shared script.
