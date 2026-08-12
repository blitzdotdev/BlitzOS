#!/bin/sh
set -eu

if [ -z "${FILES_BASE:-}" ]; then
  echo "FILES_BASE is required" >&2
  exit 1
fi

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/blitz-files-smoke.XXXXXX")
name=".blitz-files-smoke-$$.txt"

cleanup() {
  for surface in workspace home; do
    curl -sS -o /dev/null -X DELETE "${FILES_BASE%/}/$surface/$name" 2>/dev/null || true
  done
  rm -rf "$test_dir"
}
trap cleanup EXIT HUP INT TERM

for surface in workspace home; do
  payload="files-smoke-$surface"
  printf '%s' "$payload" >"$test_dir/source"
  url="${FILES_BASE%/}/$surface/$name"

  status=$(curl -sS -o /dev/null -w '%{http_code}' -T "$test_dir/source" "$url")
  case "$status" in
    200|201|204) ;;
    *) echo "$surface PUT failed: HTTP $status" >&2; exit 1 ;;
  esac

  actual=$(curl -fsS "$url")
  [ "$actual" = "$payload" ] || {
    echo "$surface GET returned the wrong content" >&2
    exit 1
  }

  listing=$(curl -fsS -X PROPFIND -H 'Depth: 1' "${FILES_BASE%/}/$surface/")
  printf '%s' "$listing" | grep -Fq "$name" || {
    echo "$surface PROPFIND omitted the uploaded file" >&2
    exit 1
  }

  echo "PASS $surface PUT/GET/PROPFIND"
done

echo "PASS files smoke"
