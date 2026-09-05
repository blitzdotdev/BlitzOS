-- One validated cloud credential per organization and provider. The encrypted
-- payload uses the same CRED_MASTER_KEY/AES-GCM custody as connection roots;
-- only ciphertext ever reaches D1.
CREATE TABLE org_compute_credentials (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL CHECK (provider IN ('hetzner', 'aws')),
  ciphertext TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  validated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, provider)
);

-- Provenance is required for destructive calls. NULL is the legacy state:
-- every pre-BYOK cloud resource was created with the deployment credential.
-- New cloud resources record their source explicitly; older rows stay NULL.
ALTER TABLE workspaces ADD COLUMN compute_credential_source TEXT
  CHECK (compute_credential_source IN ('org', 'deployment'));
ALTER TABLE volume_ownership ADD COLUMN compute_credential_source TEXT
  CHECK (compute_credential_source IN ('org', 'deployment'));
