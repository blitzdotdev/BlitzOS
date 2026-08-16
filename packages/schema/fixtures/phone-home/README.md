# Phone-home v1 contract

Phone-home v1 accepts either `application/json` or `application/x-www-form-urlencoded` requests. Its canonical request keys are:

- `pub_key_ecdsa`
- `pub_key_ed25519`
- `pub_key_rsa`
- `bootstrap_error`

A successful enrollment supplies at least one valid SSH public key in the three `pub_key_*` scalar fields. Missing or empty algorithm fields are allowed because the bash producer always submits all three fields. A failure report supplies a non-empty, printable `bootstrap_error`. Unknown keys are invalid after legacy compatibility adaptation.

The canonical success response is JSON with exactly `box_id`, `access_token`, and `refresh_token`, each a non-empty string.

Descriptors store JSON request/response bodies as objects and form bodies as strings. `expect.valid` states whether the canonical parser or consumer must accept the descriptor. The `requests/legacy/` cases document the compatibility adapter for old in-flight images; new producers must not emit those shapes.
