_blitz_environment_file=$BLITZ_STATE_DIR/env/user-env.sh
_blitz_environment_attempt=0
while [ ! -r "$_blitz_environment_file" ] && [ -r "$BLITZ_STATE_DIR/origin" ] && [ "$_blitz_environment_attempt" -lt 50 ]; do
	_blitz_environment_attempt=$((_blitz_environment_attempt + 1))
	sleep 0.1
done
if [ -r "$_blitz_environment_file" ]; then
	. "$_blitz_environment_file" || :
fi
unset _blitz_environment_file _blitz_environment_attempt
