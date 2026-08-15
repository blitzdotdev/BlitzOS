ALTER TABLE workspaces
ADD COLUMN machine_type_id TEXT NOT NULL DEFAULT 'unknown';

UPDATE workspaces
SET machine_type_id = 'mv-legacy'
WHERE vm_id LIKE 'microvm:v1:%';
