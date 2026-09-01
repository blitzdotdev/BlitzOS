-- Which plane created a machine: a person, or an agent.
--
-- An agent authenticates with its box credential and acts as its own member
-- (core/machine-plane.ts), so every ownership check downstream says yes to
-- exactly what that person may do — including destroying the machine they are
-- working on. Membership cannot tell the two apart, because it is the same
-- membership. Only provenance can.
--
-- So a machine records the plane that asked for it, and the agent plane may
-- destroy only what the agent plane made. A person's machine is not an agent's
-- to take away, and the recorded fact is what makes that enforceable rather
-- than merely intended.
--
-- 'session' is the default and the backfill together: every machine that
-- exists today was created from a browser, and a row written by a control
-- plane too old to set the column is a person's by the same reasoning. The
-- safe direction is the one that refuses an agent, so the default is the one
-- an agent may not destroy.
ALTER TABLE machines ADD COLUMN created_by_plane TEXT NOT NULL DEFAULT 'session'
  CHECK (created_by_plane IN ('session', 'machine'));
