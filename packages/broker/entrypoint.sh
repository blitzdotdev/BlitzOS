#!/bin/bash
set -euo pipefail

state_dir="${BLITZ_STATE_DIR:-/var/lib/blitz-broker}"
case "$state_dir" in
  /*) ;;
  *) echo "BLITZ_STATE_DIR must be absolute" >&2; exit 1 ;;
esac
if [[ "$state_dir" == "/" ]]; then
  echo "BLITZ_STATE_DIR cannot be /" >&2
  exit 1
fi

install -d -m 0755 "$state_dir"
install -d -m 0755 "$state_dir/members" /run/sshd /etc/blitz-broker/authorized_keys

hostkey_dir="$state_dir/ssh"
if [[ ! -e "$hostkey_dir" ]]; then
  hostkey_tmp="$(mktemp -d "$state_dir/.ssh.XXXXXX")"
  trap 'rm -rf -- "$hostkey_tmp"' EXIT
  ssh-keygen -q -t ed25519 -N "" -f "$hostkey_tmp/ssh_host_ed25519_key"
  chmod 0600 "$hostkey_tmp/ssh_host_ed25519_key"
  chmod 0644 "$hostkey_tmp/ssh_host_ed25519_key.pub"
  mv -T "$hostkey_tmp" "$hostkey_dir"
  trap - EXIT
fi
if [[ ! -f "$hostkey_dir/ssh_host_ed25519_key" || ! -f "$hostkey_dir/ssh_host_ed25519_key.pub" ]]; then
  echo "SSH host-key state is incomplete" >&2
  exit 1
fi

/usr/sbin/sshd -f /etc/ssh/sshd_config -h "$hostkey_dir/ssh_host_ed25519_key"
exec /usr/local/bin/blitz-broker sync
