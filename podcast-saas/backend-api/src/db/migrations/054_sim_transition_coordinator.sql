-- 054: Kill switch for the bidirectional frame-valid transition coordinator (audit P0.1).
--
-- Same posture, and the same reason, as 048 / 051 / 052: the coordinator becomes the PRESENTATION
-- AUTHORITY for the simulation→video handoff — it decides which pixels a viewer may see and when
-- the outgoing package's audio is released. A behaviour with that blast radius must be switchable
-- off without a deploy, and must default to the behaviour every deployment has today.
--
-- OFF is byte-for-byte the current exit: freeze + mute the package, clear the overlay, then seek
-- and play. ON holds the outgoing (frozen, still-audible) simulation as the cover until a frame
-- callback proves the requested video frame reached the compositor at the requested media time,
-- and only then uncovers. A timeout under ON selects a cover and a retry — never a reveal.
--
-- Applying this migration changes nothing for any viewer.
ALTER TABLE admin_settings
  ADD COLUMN IF NOT EXISTS sim_transition_coordinator BOOLEAN NOT NULL DEFAULT false;
