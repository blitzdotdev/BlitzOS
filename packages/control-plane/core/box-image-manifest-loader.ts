/**
 * The host-side shell library that downloads, validates, verifies, and loads
 * one versioned box-image manifest. It is installed once by the bootstrap and
 * sourced by both the first-boot image setup and the periodic image updater.
 * Keeping the Python validator here gives the box-image manifest contract one
 * consumer even though two host paths call it.
 *
 * This is a template string rather than a standalone asset because the
 * control-plane Worker cannot read files at runtime.
 */
export const BOX_IMAGE_MANIFEST_LOADER_PATH = "/usr/local/libexec/blitz-box-image-manifest.sh";

export const BOX_IMAGE_MANIFEST_LOADER_INSTALL = String.raw`install -d -m 0755 /usr/local/libexec
cat >${BOX_IMAGE_MANIFEST_LOADER_PATH} <<'BOX_IMAGE_MANIFEST_LOADER'
download() {
  curl --fail --location --retry 10 --retry-all-errors --retry-delay 3 \
    --silent --show-error --output "$2" "$1"
}

verify_sha256() {
  local path="$1"
  local expected="$2"
  local actual
  if ! actual=$(sha256sum "$path" | cut -d ' ' -f 1); then
    return 1
  fi
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  if [ "$actual" != "$expected" ]; then
    printf 'SHA-256 mismatch for %s\n' "$path" >&2
    return 1
  fi
}

# Arguments: manifest ref, required image tag (or empty), required total
# digest (or empty), currently running tag (or empty), scratch parent.
# Results are returned in BOX_IMAGE_LOADED_TAG and BOX_IMAGE_LOAD_ACTION.
load_box_image_manifest() {
  local manifest_ref="$1"
  local required_image_tag="$2"
  local required_total_sha256="$3"
  local running_image="$4"
  local state_dir="$5"
  local image_tmp_dir
  local image_archive
  local manifest_path
  local manifest_parts_path
  local manifest_metadata_path
  local manifest_total_sha256
  local manifest_image_tag
  local manifest_base
  local part_name
  local part_sha256
  local part_path

  BOX_IMAGE_LOADED_TAG=""
  BOX_IMAGE_LOAD_ACTION=""
  if ! image_tmp_dir=$(mktemp -d "$state_dir/.box-image.XXXXXX"); then
    return 1
  fi
  image_archive="$image_tmp_dir/image.tar.gz"
  manifest_path="$image_tmp_dir/manifest.json"
  manifest_parts_path="$image_tmp_dir/parts.tsv"
  manifest_metadata_path="$image_tmp_dir/metadata.tsv"

  if ! download "$manifest_ref" "$manifest_path"; then
    rm -rf "$image_tmp_dir"
    return 1
  fi
  if ! python3 - "$manifest_path" "$manifest_parts_path" >"$manifest_metadata_path" <<'PYTHON'
import json
import re
import sys

manifest_path, parts_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as manifest_file:
    value = json.load(manifest_file)

parts = value.get("parts")
total_sha256 = value.get("totalSha256")
image_tag = value.get("imageTag")
if not isinstance(parts, list) or not parts:
    raise ValueError("manifest parts must be a non-empty list")
if not isinstance(total_sha256, str) or re.fullmatch(r"[a-fA-F0-9]{64}", total_sha256) is None:
    raise ValueError("manifest totalSha256 must be a SHA-256 digest")
if not isinstance(image_tag, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", image_tag) is None:
    raise ValueError("manifest imageTag is invalid")

with open(parts_path, "w", encoding="utf-8") as parts_file:
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError("manifest part must be an object")
        name = part.get("name")
        sha256 = part.get("sha256")
        if not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) is None:
            raise ValueError("manifest part name is invalid")
        if not isinstance(sha256, str) or re.fullmatch(r"[a-fA-F0-9]{64}", sha256) is None:
            raise ValueError("manifest part sha256 must be a SHA-256 digest")
        parts_file.write(f"{name}\t{sha256.lower()}\n")

print(f"{total_sha256.lower()}\t{image_tag}")
PYTHON
  then
    rm -rf "$image_tmp_dir"
    return 1
  fi
  if ! IFS=$'\t' read -r manifest_total_sha256 manifest_image_tag <"$manifest_metadata_path"; then
    rm -rf "$image_tmp_dir"
    return 1
  fi
  if [ -n "$required_image_tag" ] && [ "$manifest_image_tag" != "$required_image_tag" ]; then
    printf 'manifest imageTag %s does not match required image tag %s\n' \
      "$manifest_image_tag" "$required_image_tag" >&2
    rm -rf "$image_tmp_dir"
    return 1
  fi

  BOX_IMAGE_LOADED_TAG="$manifest_image_tag"
  if [ -n "$running_image" ] && [ "$manifest_image_tag" = "$running_image" ]; then
    BOX_IMAGE_LOAD_ACTION=up-to-date
    rm -rf "$image_tmp_dir"
    return 0
  fi
  if docker image inspect "$manifest_image_tag" >/dev/null 2>&1; then
    BOX_IMAGE_LOAD_ACTION=available
    rm -rf "$image_tmp_dir"
    return 0
  fi

  manifest_base=${"${manifest_ref%/*}"}
  : >"$image_archive"
  while IFS=$'\t' read -r part_name part_sha256; do
    part_path="$image_tmp_dir/$part_name"
    if ! download "$manifest_base/$part_name" "$part_path"; then
      rm -rf "$image_tmp_dir"
      return 1
    fi
    if ! verify_sha256 "$part_path" "$part_sha256"; then
      rm -rf "$image_tmp_dir"
      return 1
    fi
    if ! cat "$part_path" >>"$image_archive"; then
      rm -rf "$image_tmp_dir"
      return 1
    fi
    rm -f "$part_path"
  done <"$manifest_parts_path"
  if ! verify_sha256 "$image_archive" "$manifest_total_sha256"; then
    rm -rf "$image_tmp_dir"
    return 1
  fi
  if [ -n "$required_total_sha256" ] && \
      ! verify_sha256 "$image_archive" "$required_total_sha256"; then
    rm -rf "$image_tmp_dir"
    return 1
  fi
  if ! gunzip -c "$image_archive" | docker load; then
    rm -rf "$image_tmp_dir"
    return 1
  fi
  if ! docker image inspect "$manifest_image_tag" >/dev/null 2>&1; then
    rm -rf "$image_tmp_dir"
    return 1
  fi
  BOX_IMAGE_LOAD_ACTION=loaded
  rm -rf "$image_tmp_dir"
}
BOX_IMAGE_MANIFEST_LOADER
chmod 0644 ${BOX_IMAGE_MANIFEST_LOADER_PATH}
`;
