#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = api-token ]
if [ -n "${BLITZ_PAYLOAD_CREDENTIAL_UID_LOG:-}" ]; then
	id -u >>"$BLITZ_PAYLOAD_CREDENTIAL_UID_LOG"
fi
printf '%s\n' smoke-bearer
