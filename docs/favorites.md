# Quick favorites and playback order

## Admin workflow

Use the star on any media card to save/remove a favorite without playing that item.
The star is a keyboard-accessible toggle with `aria-pressed`; pending writes disable
repeat activation. Existing favorites are preserved: the existing `enabled` flag is
still the source of truth (`enabled !== false` includes legacy/default items). This
release does not reclassify the library or change upload defaults.

For multiple items, choose **Select media**, select cards (or **Select all matching**),
and choose **Save favorites** in the persistent selection bar. Save adds to existing
favorites; it does not replace the set. Large selections use the existing 500-ID
batch API. Only acknowledged saved IDs are cleared from the current selection. A
failed/partially completed batch keeps the selection available for retry and reports
the incomplete save. Removing favorites never deletes media files.

**Show favorites** filters the library and combines with existing search/type/count/
date filters. **Reset filters** returns to all media. Playback always uses all saved
favorites of the chosen playback media type, not just visible/filtered cards.

Choose **Photos + videos**, **Photos only**, or **Videos only**, then:

- **Play in order** follows Saved library order, Oldest first, Newest first, or
  Filename A-Z. Date order uses the original creation date when present and the
  library creation date otherwise. Filename order is numeric (2 before 10).
- **Shuffle** chooses a random order with no duplicate primary item within a pass,
  avoids immediate repeats at cycle boundaries when more than one item is eligible,
  and keeps bounded Previous/Next history (up to 1,024 entries). The existing optional
  paired-portrait layout may display a companion photo alongside the primary.

Playback repeats through the eligible favorites. The selected mode, sort and media
type persist across server restarts. A fresh shuffle is generated after a restart.
Play cancels a temporary selected-items queue and releases pause/hold. If Photo
Period was zero, explicit Play sets it to 15 seconds. Other display, zoom, pan,
audio, speed, face-label and quality settings remain unchanged. New/removed stars
are picked up as playback progresses; processing videos are not handed to the TV.

## API and compatibility

Authenticated `POST /api/favorites/play` accepts
`{ "order": "ordered" | "shuffle", "media": "both" | "photos" | "videos",
"sort": "library" | "oldest" | "newest" | "filename" }`.
It returns `{ ok: true, count, config }` for ready media. Invalid requests return
400, and no eligible favorites returns 409 without disturbing existing playback.
The route remains behind the existing admin authentication hook.

`playbackOrder` and `favoritesSort` are additive FrameConfig fields, also serialized
through `/api/data`; older persisted configurations default to ordered/library.
Stars continue to use `/api/items/enabled`. No asset migration, new dependency,
new database or external analytics service is introduced.
