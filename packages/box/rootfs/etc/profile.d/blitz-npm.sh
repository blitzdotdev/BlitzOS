# Global npm installs (and claude auto-updates) go to the blitz-owned
# prefix. Login shells rebuild PATH from /etc/profile, so re-prepend it.
export NPM_CONFIG_PREFIX=/opt/blitz/npm
case ":$PATH:" in
	*:/opt/blitz/npm/bin:*) ;;
	*) PATH=/opt/blitz/npm/bin:$PATH ;;
esac
export PATH
