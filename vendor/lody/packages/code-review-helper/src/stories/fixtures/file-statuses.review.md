---
review_version: 1
merge_base: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
current_commit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
base_ref: origin/main
line_budget: 1500
---

# Cover Git file statuses

## Group: Cover Git file statuses

Changed lines: 71
Commits: `1900aaa`, `1900bbb`

This sample keeps every file status in one group so the renderer can be checked quickly.

`changes://packages/review-helper/src/cli.ts`

- `new://L6`: the command registry now includes the view command.

`changes://packages/review-helper/src/report.ts`

- `new://L1-L8`: added report formatting for copied comments.

`changes://packages/review-helper/src/legacy.ts`

- `old://L1-L7`: deleted legacy formatter code.

`changes://packages/review-helper/src/rendering/comment-export.ts`

- `old://L1-L6`: renamed from the copy-comments module.
- `new://L6`: output now includes side and source line text.
