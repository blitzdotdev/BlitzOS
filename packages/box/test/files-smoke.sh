#!/bin/sh
set -eu

if [ -z "${FILES_BASE:-}" ]; then
  echo "FILES_BASE is required" >&2
  exit 1
fi

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/blitz-files-smoke.XXXXXX")
name=".blitz-files-smoke-$$.txt"

cleanup() {
  for webapp in workspace home; do
    curl -sS -o /dev/null -X DELETE "${FILES_BASE%/}/$webapp/$name" 2>/dev/null || true
  done
  rm -rf "$test_dir"
}
trap cleanup EXIT HUP INT TERM

for webapp in workspace home; do
  payload="files-smoke-$webapp"
  printf '%s' "$payload" >"$test_dir/source"
  url="${FILES_BASE%/}/$webapp/$name"

  status=$(curl -sS -o /dev/null -w '%{http_code}' -T "$test_dir/source" "$url")
  case "$status" in
    200|201|204) ;;
    *) echo "$webapp PUT failed: HTTP $status" >&2; exit 1 ;;
  esac

  actual=$(curl -fsS "$url")
  [ "$actual" = "$payload" ] || {
    echo "$webapp GET returned the wrong content" >&2
    exit 1
  }

  listing=$(curl -fsS -X PROPFIND -H 'Depth: 1' "${FILES_BASE%/}/$webapp/")
  printf '%s' "$listing" | grep -Fq "$name" || {
    echo "$webapp PROPFIND omitted the uploaded file" >&2
    exit 1
  }

  echo "PASS $webapp PUT/GET/PROPFIND"
done

echo "PASS files smoke"
