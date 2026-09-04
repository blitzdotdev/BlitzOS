# Global npm installs go to the blitz-owned prefix. Login shells rebuild PATH
# from /etc/profile, so re-prepend it.
export NPM_CONFIG_PREFIX=/opt/blitz/npm
case ":$PATH:" in
	*:/opt/blitz/npm/bin:*) ;;
	*) PATH=/opt/blitz/npm/bin:$PATH ;;
esac

# ...and then put /usr/local/bin back in FRONT of it. The order is
# load-bearing, not cosmetic: /usr/local/bin/claude is the shim that mints a
# token and execs the pinned binary, and /opt/blitz/npm/bin/claude is that
# pinned binary. Leaving the npm prefix first means every terminal `claude`
# skips the shim and runs signed out, which is exactly what a stray
# `PATH=/opt/blitz/npm/bin:$PATH` did before this block existed.
case ":$PATH:" in
	*:/usr/local/bin:*) PATH="/usr/local/bin:$(printf '%s' "$PATH" | sed -e 's#^/usr/local/bin:##' -e 's#:/usr/local/bin:#:#g' -e 's#:/usr/local/bin$##')" ;;
	*) PATH="/usr/local/bin:$PATH" ;;
esac

# NOTE: the PATH order above is what keeps a self-updated copy from shadowing
# the shims, and it is the only thing that does. The vendor CLIs update
# themselves on purpose — claude's version decides which models the Lody
# composer can offer (docs/LODY-MODELS.md) — and an update rewrites
# /opt/blitz/npm in place, which /usr/local/bin already sits ahead of.
export PATH
