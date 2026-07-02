export const VIDEO_SEEK_SECONDS = 10;
export function playbackNavigationState(playback) {
    const display = playback.display;
    const canSeek = playback.kind === 'video'
        && playback.itemId !== null
        && display?.itemId === playback.itemId
        && display.seekable
        && Number.isFinite(display.currentTime)
        && Number.isFinite(display.duration)
        && display.duration > 0;
    if (!canSeek || !display) {
        return {
            previousLabel: 'Previous slideshow item',
            nextLabel: 'Next slideshow item',
            previousDisabled: false,
            nextDisabled: false,
            action: 'slideshow',
        };
    }
    return {
        previousLabel: `Seek backward ${VIDEO_SEEK_SECONDS} seconds; double tap for previous slideshow item`,
        nextLabel: `Seek forward ${VIDEO_SEEK_SECONDS} seconds; double tap for next slideshow item`,
        previousDisabled: false,
        nextDisabled: false,
        action: 'video-seek',
    };
}
//# sourceMappingURL=playbackState.js.map