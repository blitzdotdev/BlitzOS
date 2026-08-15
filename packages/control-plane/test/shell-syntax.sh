#!/bin/sh
set -eu

if [ -n "${BLITZ_REPORTER_TEST_DIR:-}" ]; then
  case "${0##*/}" in
    journalctl)
      printf '%s\n' "INF Your quick Tunnel has been created! Visit it at https://fresh.trycloudflare.com"
      exit 0
      ;;
    curl)
      for argument do
        case "$argument" in
          *"$BLITZ_REPORTER_OLD_TOKEN"*|*"$BLITZ_REPORTER_NEW_TOKEN"*)
            mkdir "$BLITZ_REPORTER_TEST_DIR/token-in-curl-argv" 2>/dev/null || true
            printf '204'
            exit 0
            ;;
        esac
      done
      headers=$(command cat)
      if mkdir "$BLITZ_REPORTER_TEST_DIR/curl-first" 2>/dev/null; then
        case "$headers" in
          *"Authorization: Bearer $BLITZ_REPORTER_OLD_TOKEN"*) ;;
          *) mkdir "$BLITZ_REPORTER_TEST_DIR/wrong-first-token"; printf '204'; exit 0 ;;
        esac
        printf '%s\n' "$BLITZ_REPORTER_NEW_TOKEN" >"$TOKEN_FILE"
        printf '401'
      elif mkdir "$BLITZ_REPORTER_TEST_DIR/curl-second" 2>/dev/null; then
        case "$headers" in
          *"Authorization: Bearer $BLITZ_REPORTER_NEW_TOKEN"*) ;;
          *) mkdir "$BLITZ_REPORTER_TEST_DIR/wrong-second-token"; printf '204'; exit 0 ;;
        esac
        printf '204'
      else
        mkdir "$BLITZ_REPORTER_TEST_DIR/unexpected-extra-curl" 2>/dev/null || true
        printf '204'
      fi
      exit 0
      ;;
    sleep)
      if [ "$#" -ne 1 ] || [ "$1" != 1 ]; then
        mkdir "$BLITZ_REPORTER_TEST_DIR/wrong-backoff" 2>/dev/null || true
      fi
      mkdir "$BLITZ_REPORTER_TEST_DIR/slept" 2>/dev/null || true
      exit 0
      ;;
  esac
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
reporter="$repo_root/packages/microvm-host/deploy/blitz-tunnel-reporter.sh"

bash -n "$reporter"

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/blitz-tunnel-reporter.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
fake_bin="$test_dir/bin"
mkdir "$fake_bin"
for command_name in journalctl curl sleep; do
  cp "$script_dir/shell-syntax.sh" "$fake_bin/$command_name"
  chmod +x "$fake_bin/$command_name"
done

old_token=old-token-012345678901234567890123456
new_token=new-token-012345678901234567890123456
token_file="$test_dir/token"
printf '%s\n' "$old_token" >"$token_file"

reporter_status=0
reporter_output=$(
  BLITZ_REPORTER_TEST_DIR="$test_dir" \
  BLITZ_REPORTER_OLD_TOKEN="$old_token" \
  BLITZ_REPORTER_NEW_TOKEN="$new_token" \
  CP_URL=https://cp.example \
  HOST_NAME=home \
  TOKEN_FILE="$token_file" \
  PATH="$fake_bin:$PATH" \
    bash "$reporter" 2>&1
) || reporter_status=$?

[ "$reporter_status" -eq 1 ]
[ -d "$test_dir/curl-first" ]
[ -d "$test_dir/curl-second" ]
[ -d "$test_dir/slept" ]
[ ! -d "$test_dir/token-in-curl-argv" ]
[ ! -d "$test_dir/wrong-first-token" ]
[ ! -d "$test_dir/wrong-second-token" ]
[ ! -d "$test_dir/wrong-backoff" ]
[ ! -d "$test_dir/unexpected-extra-curl" ]
case "$reporter_output" in
  *"$old_token"*|*"$new_token"*)
    echo "tunnel reporter leaked a token in output" >&2
    exit 1
    ;;
esac

printf '%s\n' "tunnel reporter retry behavior: ok"
