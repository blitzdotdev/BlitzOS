-- What image a machine actually runs, and how its last update attempt ended.
--
-- `box_image_reported` already stores the REF the host was asked to install.
-- Under the R2 manifest mode that canary runs, the ref is a manifest URL that
-- never changes across rebakes, so it cannot answer "is an update available".
-- `box_image_tag_reported` stores the CONCRETE image instead — the tag from
-- inside the manifest, or the ref itself under a registry pin — which is what
-- the deployment's own pin can be compared against.
--
-- `box_update_outcome` keeps the host's last verdict. It is what lets the UI
-- say the honest thing about a machine whose emitted updater predates the
-- manifest branch: that host reports `unsupported` and can never self-update.
--
-- Neither column takes a default. NULL means "never reported", which is a
-- different fact from any value either column can hold.
ALTER TABLE machines ADD COLUMN box_image_tag_reported TEXT;
ALTER TABLE machines ADD COLUMN box_update_outcome TEXT;
