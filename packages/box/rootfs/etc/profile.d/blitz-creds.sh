_blitz_load_credentials() {
	# Only the workspace's own variables live here. Connection secrets are
	# pulled at the moment of use with `blitz-cred get`, so a login shell has
	# nothing to fetch and nothing to wait for.
	for _blitz_env_file in "$BLITZ_STATE_DIR"/creds/env.d/*.sh; do
		if [ -r "$_blitz_env_file" ]; then
			. "$_blitz_env_file" || :
		fi
	done

	unset _blitz_env_file
	return 0
}

_blitz_load_credentials || :
unset -f _blitz_load_credentials 2>/dev/null || :
