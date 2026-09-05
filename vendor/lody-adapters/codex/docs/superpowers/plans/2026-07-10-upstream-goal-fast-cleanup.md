# Upstream Goal/Fast Cleanup Implementation Plan

1. Remove fork goal ACP extension constants, request types, parsers, route registration, and server/client forwarding wrappers.
2. Preserve upstream goal setters, runtime-effect tracking, session metadata, cancellation, and `/goal` orchestration.
3. Remove raw goal notifications and restore upstream goal event tests/snapshots.
4. Restore upstream no-argument `/goal` behavior and remove fork-only goal formatting/tests.
5. Delete the fork goal extension test suite and scan for remaining fork goal symbols.
6. Verify Plan Mode/proposed-plan code is unchanged.
7. Verify Fast Mode source and behavior match upstream and the ACP SDK dependency/lock resolution matches upstream.
8. Run targeted tests, typecheck, the complete test suite, npm build/package checks, and all CI Bun bundles.
9. Review the final diff and commit the implementation.
