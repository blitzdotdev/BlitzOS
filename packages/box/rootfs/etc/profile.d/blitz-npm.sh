# Global npm installs go to the blitz-owned prefix. Login shells rebuild PATH
# from /etc/profile, so re-prepend it.
export NPM_CONFIG_PREFIX=/opt/blitz/npm
case ":$PATH:" in
	*:/opt/blitz/npm/bin:*) ;;
	*) PATH=/opt/blitz/npm/bin:$PATH ;;
esac

# ...and then put /usr/local/bin back in FRONT of it. The order is
# load-bearing, not cosmetic: /usr/local/bin/codex is the shim that turns the
# startup update check on before it execs the managed binary, and
# /opt/blitz/npm/bin/codex is that vendor binary. Leaving the npm prefix first
# means every terminal `codex` skips the shim and its explicit startup check,
# which is exactly what a stray `PATH=/opt/blitz/npm/bin:$PATH` did before this
# block existed.
case ":$PATH:" in
	*:/usr/local/bin:*) PATH="/usr/local/bin:$(printf '%s' "$PATH" | sed -e 's#^/usr/local/bin:##' -e 's#:/usr/local/bin:#:#g' -e 's#:/usr/local/bin$##')" ;;
	*) PATH="/usr/local/bin:$PATH" ;;
esac

# The PATH order keeps an updated vendor binary from shadowing the shims. The
# agent-cli-update service rewrites /opt/blitz/npm in place, and
# /usr/local/bin already sits ahead of it.
export PATH
