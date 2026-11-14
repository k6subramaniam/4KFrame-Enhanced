# Media activity and library controls

## Metric definitions

- Photo views: a photo successfully loaded and completed its display transition in a visible receiver. Failed images and hidden receivers do not count.
- Video plays: a visible receiver confirms that the current video has decoded frames and progressed beyond time zero. A click, buffering, muted autoplay attempt, or audio-only decode is not a play.
- Clicks: explicit tile opening/preview or Play on TV requests in the admin. A failed playback request is still a click, but is not a play.
- Selections: additions to an admin selection, including Select all. Deselect, clear-selection, and repeated Select all on already-selected items do not increment.

Views/plays are per global slideshow appearance, not per viewer or device. Multiple receivers, reconnections, video loops, and pause/resume reuse the server-issued presentation receipt. Re-casting the same item creates a new appearance. These are not unique viewers, completion rates, or watch-duration metrics. Ephemeral Live Cast media are not library activity.

Existing media default to zero. Historical activity before this feature cannot be reconstructed. Totals cover the active library; recoverable Trash retains its counts, and restoring media restores those counts.

## Library UX

Every card shows views or plays, clicks, and lifetime selections. The bulk toolbar separately shows how many are selected now. Search combines with media type, date/source, people and inclusive integer count ranges. Quick presets select zero-count records. Sort by most/least viewed or played, clicked, selected, or most recently viewed.

Only the first 60 matching tiles render initially; Show more adds 60. Select all acts on **all matching results**, not just the rendered page. Selection and rotation use the same selection. Live badges update without moving a card under the user's finger. When counts affect the current filter/sort, an explicit "Activity changed · update results" control refreshes membership/order.

The bottom transport provides current item, previous/next media, pause/resume, and the existing Controls sheet. Now playing temporarily focuses the current media, ignoring conflicting library filters, without destroying the previous filter state. Clearing that focus returns to those filters.

## Backend

`GET /api/thumbs` remains backwards-compatible. Optional query parameters:

- `minViews`, `maxViews`, `minClicks`, `maxClicks`, `minSelections`, `maxSelections`: inclusive, nonnegative safe integers. Views means photo views or video plays per item.
- `sort`: `views-asc`, `views-desc`, `clicks-asc`, `clicks-desc`, `selections-asc`, `selections-desc`, `recent-viewed`.
- `q`: filename/caption search, at most 200 characters; `kind`: `photo`, `video`, `all`.
- `offset`, `limit`: optional pagination; explicit limit 1–500. Without pagination all matching records are returned, preserving existing clients. Response includes `total` before pagination.

`GET /api/media/activity` provides active-library totals.

`POST /api/media/activity` accepts `{kind: "click" | "selection", ids: string[], eventId: string}`. The existing admin-auth gate protects it. Maximum 500 IDs, 64KB body; IDs are deduplicated and missing IDs reject the batch. Reuse the same event ID when retrying. The persisted 4,096-event receipt window prevents repeat increments, and conflicting reuse returns 409. The admin retries a network/server failure once with the same event ID and reports unsaved activity rather than faking counts.

Display `mediaPresented` WebSocket messages must match both the current media and the current server-issued presentation ID. Only the server can increment views/plays, after a valid display confirmation. A per-item persisted receipt prevents reconnect duplicates independently of the admin-interaction receipt window. This is operational telemetry from trusted receivers, not fraud-resistant analytics.

Counters, timestamps and receipts use the existing atomic JSON store and write queue. No new database, analytics provider, user identity, IP log, or dependency is added. This retains the application's existing single-process/single-replica storage model.

## Rollout and rollback

Deploy the shared/server/admin/display build together; refresh admin and display clients after rollout. Old display clients without receipt support keep playing but cannot contribute confirmed views/plays until refreshed. The new fields and events are additive. Rolling back the application preserves media assets; older code may drop the interaction-receipt window on its next write, so avoid replaying old client requests after rollback.

## Coverage

Shared tests cover zero defaults, input validation, numeric sorting, combined ranges and summaries. Server tests cover concurrent increments, retry conflicts, reload persistence, display receipt validation, Live Cast exclusion, Trash preservation, query pagination and API authentication. Admin tests cover combined filters, batching, retries and authentication failures. Browser fixtures cover quick-action command isolation and video decode readiness before a play receipt. Desktop/mobile fixture UI checks cover incremental rendering, filters, selection/deselection and single keyboard activation.
