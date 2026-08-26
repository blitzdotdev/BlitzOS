-- Host-driven box updates (the cloud-VM path; the microVM provider has its
-- own guest lifecycle and does not support updates yet).
--
-- `box_update_requested` gates the host-side updater: the VM host polls
-- GET /workspaces/self/box-config every ~5 minutes and replaces the box
-- container only when this flag is set, because a replacement kills every
-- process inside the container. Set by POST /workspaces/:id/box-update
-- (session, canControlWorkspace) or POST /workspaces/self/box-update (the
-- box's own token, via `blitz box update`).
--
-- `box_image_reported` is the image ref the host last reported to
-- POST /workspaces/self/box-update-result — per-workspace image
-- observability that did not exist before. The same report clears the flag.
ALTER TABLE workspaces ADD COLUMN box_update_requested INTEGER NOT NULL DEFAULT 0 CHECK (box_update_requested IN (0, 1));
ALTER TABLE workspaces ADD COLUMN box_image_reported TEXT;
