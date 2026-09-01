---
review_version: 1
merge_base: cccccccccccccccccccccccccccccccccccccccc
current_commit: dddddddddddddddddddddddddddddddddddddddd
base_ref: origin/main
line_budget: 12
---

# Large parser rewrite

## Group: Large parser rewrite

Changed lines: 88
Commits: `2800aaa`

This group is over the preferred line budget. The renderer should allow it, but keep the warning visible.

`changes://packages/parser/src/large-parser.ts?old=L4-L10&new=L4-L12`

- `new://L8`: check the new token branch ordering.
- `new://L99`: this note is intentionally out of range so validation is visible.
