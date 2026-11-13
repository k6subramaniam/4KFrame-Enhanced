# Media usage and controls

Tracking starts with this release. Legacy items have zero recorded activity; older usage cannot be reconstructed.

- Views: a photo successfully composed on a visible display, or loaded in an explicitly opened preview.
- Plays: a video with decoded frames and advancing playback on the display or an explicit preview.
- Clicks: deliberate library tile open/cast actions. Navigation, thumbnails, favorite/delete controls and failed media loads do not create views/plays.
- Selections: each unselected-to-selected transition, including each newly selected item in Select all matching. Deselect and Clear do not change history. “Selected now” is the current bulk selection, not a historical count.

One display presentation is counted once per media item across connected displays. Pause/resume, buffering, configuration redraws, reconnections, and hold-loop repetitions do not create extra plays. A new slideshow visit or explicit cast is a new presentation and counts only when the display confirms it. Preview openings are separate visits. This is usage activity, not unique people or completed-video counts.

Counts live with media metadata in the existing persistent store and survive restarts, Trash/restore, and catalog backup. Counts and idempotency receipts share an atomic disk write. Controller receipts are retained for up to 24 hours / 20,000 events; clients retry immediately with the same ID. No IP addresses or viewer identities are stored.

Authenticated GET /api/media/activity supports search, activityMin/Max, clicksMin/Max, selectedMin/Max, sort, limit (1–500), and offset. Activity is views for photos, plays for videos. POST on the same route takes ids (1–500), kind (view/play/click/select), and eventId. Existing admin authentication applies. Displays use the existing authenticated WebSocket with a server presentation ID, not a public counter endpoint.

Library controls provide count ranges, quick presets, search, grid/list layouts, a persistent compact player, and in-page previews. Live counters update without moving focused tiles; “Activity updated · Refresh results” explicitly reapplies sorting/filtering.
