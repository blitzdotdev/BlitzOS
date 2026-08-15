#!/usr/bin/env bash
set -uo pipefail

: "${CP_URL:?CP_URL is required}"
: "${HOST_NAME:?HOST_NAME is required}"
: "${TOKEN_FILE:?TOKEN_FILE is required}"

if [[ ! "$CP_URL" =~ ^https://[^/?#]+/?$ || "$CP_URL" == *"@"* ]]; then
  echo "blitz tunnel reporter: CP_URL must be a credential-free HTTPS origin" >&2
  exit 1
fi
if [[ ! "$HOST_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "blitz tunnel reporter: HOST_NAME is invalid" >&2
  exit 1
fi
CP_URL=${CP_URL%/}

report_url() {
  local tunnel_url=$1
  local token
  local delay=1
  local status

  while true; do
    token=""
    if [[ ! -f "$TOKEN_FILE" || ! -r "$TOKEN_FILE" ]] ||
      ! token=$(<"$TOKEN_FILE") 2>/dev/null; then
      echo "blitz tunnel reporter: token file is unreadable; retrying in ${delay}s" >&2
    elif (( ${#token} < 32 )) || [[ "$token" =~ [[:space:]] ]]; then
      echo "blitz tunnel reporter: token file must contain one token of at least 32 non-whitespace characters; retrying in ${delay}s" >&2
    else
      status=$(
        printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$token" |
          curl --silent --show-error \
            --connect-timeout 10 \
            --max-time 30 \
            --output /dev/null \
            --write-out '%{http_code}' \
            --request POST \
            --header @- \
            --data-binary "{\"url\":\"$tunnel_url\"}" \
            "$CP_URL/hosts/$HOST_NAME/register"
      ) || status=000
      if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
        echo "blitz tunnel reporter: registered $tunnel_url"
        return 0
      fi
      echo "blitz tunnel reporter: registration failed with HTTP $status; retrying in ${delay}s" >&2
    fi
    sleep "$delay"
    if (( delay < 60 )); then
      delay=$((delay * 2))
      if (( delay > 60 )); then
        delay=60
      fi
    fi
  done
}

last_url=""
while IFS= read -r line; do
  if [[ "$line" =~ (https://[A-Za-z0-9-]+\.trycloudflare\.com) ]]; then
    tunnel_url=${BASH_REMATCH[1]}
    if [[ "$tunnel_url" != "$last_url" ]]; then
      if report_url "$tunnel_url"; then
        last_url=$tunnel_url
      fi
    fi
  fi
done < <(
  journalctl -f -u blitz-microvm-tunnel --no-pager -o cat -n 100
)

echo "blitz tunnel reporter: tunnel journal ended" >&2
exit 1
