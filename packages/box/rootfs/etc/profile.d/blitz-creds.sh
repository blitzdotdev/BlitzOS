_blitz_load_credentials() {
	_blitz_state_dir=${BLITZ_STATE_DIR:-/var/lib/blitz}
	_blitz_creds_dir=$_blitz_state_dir/creds
	_blitz_sync_state=$_blitz_creds_dir/sync-state.json
	_blitz_fresh=false

	if [ -r "$_blitz_sync_state" ]; then
		if _blitz_expires_at=$(sed -n 's/.*"expires_at":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$_blitz_sync_state" 2>/dev/null); then
			case $_blitz_expires_at in
				''|*[!0-9]*) ;;
				*)
					if _blitz_now_s=$(date +%s 2>/dev/null); then
						_blitz_now_ms=$((_blitz_now_s * 1000))
						if [ "$_blitz_now_ms" -lt "$((_blitz_expires_at - 60000))" ] 2>/dev/null; then
							_blitz_fresh=true
						fi
					fi
					;;
			esac
		fi
	fi

	if [ "$_blitz_fresh" != true ]; then
		if command -v timeout >/dev/null 2>&1 && command -v blitz-cred >/dev/null 2>&1; then
			timeout 2 blitz-cred sync >/dev/null 2>&1 || :
		fi
	fi

	for _blitz_env_file in "$_blitz_creds_dir"/env.d/*.sh; do
		if [ -r "$_blitz_env_file" ]; then
			. "$_blitz_env_file" || :
		fi
	done

	unset _blitz_state_dir _blitz_creds_dir _blitz_sync_state _blitz_fresh
	unset _blitz_expires_at _blitz_now_s _blitz_now_ms _blitz_env_file
	return 0
}

_blitz_load_credentials || :
unset -f _blitz_load_credentials 2>/dev/null || :
