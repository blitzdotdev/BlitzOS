CREATE TABLE folder_attachments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  folder_id TEXT NOT NULL REFERENCES folders(id),
  attached_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, folder_id)
);

CREATE INDEX folder_attachments_folder ON folder_attachments(folder_id, workspace_id);
