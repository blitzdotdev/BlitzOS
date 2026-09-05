#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = api-token ]
printf '%s\n' smoke-bearer
