ALTER TABLE workspaces DROP COLUMN recipe_id;

DROP TABLE folder_attachments;
DROP TABLE folder_grants;
DROP TABLE folders;
DROP TABLE recipes;
DROP TABLE microvm_hosts;

ALTER TABLE workspaces DROP COLUMN files_ready;
ALTER TABLE orgs DROP COLUMN usage_capture;
ALTER TABLE orgs DROP COLUMN usage_folder_id;
ALTER TABLE orgs DROP COLUMN default_template_id;
