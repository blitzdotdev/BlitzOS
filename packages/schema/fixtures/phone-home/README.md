# Phone-home v1 contract

Phone-home v1 accepts either `application/json` or `application/x-www-form-urlencoded` requests. Its canonical request keys are:

- `pub_key_ecdsa`
- `pub_key_ed25519`
- `pub_key_rsa`
- `bootstrap_error`

A successful enrollment supplies at least one valid SSH public key in the three `pub_key_*` scalar fields. Missing or empty algorithm fields are allowed because the bash producer always submits all three fields. A failure report supplies a non-empty, printable `bootstrap_error`. Unknown keys are invalid.

The canonical success response is JSON with exactly `box_id`, `access_token`, and `refresh_token`. Each field contains a non-empty string.

Descriptors store JSON request and response bodies as objects. Descriptors store form bodies as strings. `expect.valid` defines acceptance.
