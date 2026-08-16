PRAGMA defer_foreign_keys = ON;

DELETE FROM workspace_grants
WHERE membership_id IN (
        SELECT membership.id
        FROM memberships membership
        JOIN users user ON user.id = membership.user_id
        WHERE user.google_user_id IS NULL
      )
   OR granted_by_membership_id IN (
        SELECT membership.id
        FROM memberships membership
        JOIN users user ON user.id = membership.user_id
        WHERE user.google_user_id IS NULL
      );

DELETE FROM invites
WHERE created_by_membership_id IN (
  SELECT membership.id
  FROM memberships membership
  JOIN users user ON user.id = membership.user_id
  WHERE user.google_user_id IS NULL
);

UPDATE invites SET redeemed_by_user_id = NULL
WHERE redeemed_by_user_id IN (
  SELECT id FROM users WHERE google_user_id IS NULL
);

DELETE FROM volume_ownership
WHERE created_by_membership_id IN (
  SELECT membership.id
  FROM memberships membership
  JOIN users user ON user.id = membership.user_id
  WHERE user.google_user_id IS NULL
);

UPDATE integrations SET created_by_membership_id = NULL
WHERE created_by_membership_id IN (
  SELECT membership.id
  FROM memberships membership
  JOIN users user ON user.id = membership.user_id
  WHERE user.google_user_id IS NULL
);

UPDATE workspaces SET owner_membership_id = NULL
WHERE owner_membership_id IN (
  SELECT membership.id
  FROM memberships membership
  JOIN users user ON user.id = membership.user_id
  WHERE user.google_user_id IS NULL
);

UPDATE sessions SET membership_id = NULL
WHERE membership_id IN (
  SELECT membership.id
  FROM memberships membership
  JOIN users user ON user.id = membership.user_id
  WHERE user.google_user_id IS NULL
);

DELETE FROM memberships
WHERE user_id IN (SELECT id FROM users WHERE google_user_id IS NULL);

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  google_user_id TEXT NOT NULL,
  email TEXT NOT NULL CHECK (email = lower(email)),
  name TEXT NOT NULL,
  avatar_url TEXT,
  platform_operator INTEGER NOT NULL DEFAULT 0 CHECK (platform_operator IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

INSERT INTO users_new
  (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
SELECT id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at
FROM users
WHERE google_user_id IS NOT NULL;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX users_google_user_id ON users(google_user_id);
CREATE UNIQUE INDEX users_email ON users(email);

PRAGMA foreign_key_check;
