-- Adds physical-placement columns to `nodes` -- floor and a relative 2D
-- position (metres, on a per-floor plane whose origin the operator picks) --
-- so GET /api/topology (brief B2, @homecsi/api) can derive per-link
-- geometry (endpoints, midpoint, length, which rooms a link spans) and the
-- dashboard can draw a floor plan. See packages/config/src/schema.ts's
-- `nodeSchema` for the full units/origin/no-trilateration contract; this
-- migration only adds the storage for it.
--
-- `pos_x`/`pos_y` are both nullable: placement is optional (an operator who
-- hasn't measured anything yet must still be able to run the system), and
-- NULL means "not placed" -- never (0, 0), which would silently draw a node
-- in the wrong spot instead of honestly rendering nothing for it. `floor`
-- is NOT NULL DEFAULT 0 because every node is on SOME floor even before it
-- has been placed precisely -- unlike position, "which floor" has a sane
-- default (0, the common single-floor case) rather than an honest "unknown".
--
-- These columns are a PROJECTION of `config.nodes`, not independently
-- editable state: `config.yaml` (gitignored, holds per-node PSKs) is the
-- source of truth, and `upsertNode` (packages/storage/src/dbWriter.ts) -
-- called from ingest startup and from `homecsi replay` - overwrites them
-- from config every time. There is deliberately no dashboard write-back
-- path for placement (see dbWriter.ts's `upsertNode` comment): editing
-- these columns directly in the database, or via any future API write
-- route, would be silently reverted at the next ingest restart, which is a
-- worse failure mode than not offering the write path at all.
DO $sql$
BEGIN
  EXECUTE $ddl$ ALTER TABLE nodes ADD COLUMN floor smallint NOT NULL DEFAULT 0 $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add nodes.floor.
Original error: %', SQLERRM;
END
$sql$;

DO $sql$
BEGIN
  EXECUTE $ddl$ ALTER TABLE nodes ADD COLUMN pos_x real $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add nodes.pos_x.
Original error: %', SQLERRM;
END
$sql$;

DO $sql$
BEGIN
  EXECUTE $ddl$ ALTER TABLE nodes ADD COLUMN pos_y real $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add nodes.pos_y.
Original error: %', SQLERRM;
END
$sql$;
