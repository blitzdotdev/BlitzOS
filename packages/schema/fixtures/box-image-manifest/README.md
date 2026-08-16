# Box-image manifest contract

The box-image manifest is a JSON object with these required fields:

- `parts`: a non-empty array of part objects.
- `parts[].name`: a string matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
- `parts[].sha256`: a 64-character hexadecimal SHA-256 digest.
- `totalSha256`: a 64-character hexadecimal SHA-256 digest for the concatenated parts, in array order.
- `imageTag`: a string matching `^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`.

SHA-256 input is case-insensitive. Consumers normalize every accepted part digest and `totalSha256` to lowercase. Fields not listed above are outside this contract and do not affect validation.

Every JSON document under `valid/` must be accepted by both the managed-file producer and the bootstrap's embedded Python validator. Every document under `invalid/` must be rejected by both.
