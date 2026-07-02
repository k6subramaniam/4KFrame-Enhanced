import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playbackNavigationState } from '../src/playbackState.js';
function playback(patch) {
    return {
        paused: false,
        holding: false,
        itemId: null,
        kind: null,
        display: null,
        ...patch,
    };
}
test('photos and no active item use slideshow navigation', () => {
    for (const state of [
        playback({ itemId: 'photo-1', kind: 'photo' }),
        playback({ itemId: null, kind: null }),
    ]) {
        assert.deepEqual(playbackNavigationState(state), {
            previousLabel: 'Previous slideshow item',
            nextLabel: 'Next slideshow item',
            previousDisabled: false,
            nextDisabled: false,
            action: 'slideshow',
        });
    }
});
test('a connected seekable video switches controls to bounded seeking', () => {
    const state = playbackNavigationState(playback({
        itemId: 'video-1',
        kind: 'video',
        display: {
            itemId: 'video-1',
            currentTime: 20,
            duration: 60,
            seekable: true,
            observedAt: Date.now(),
        },
    }));
    assert.equal(state.action, 'video-seek');
    assert.equal(state.previousLabel, 'Seek backward 10 seconds; double tap for previous slideshow item');
    assert.equal(state.nextLabel, 'Seek forward 10 seconds; double tap for next slideshow item');
    assert.equal(state.previousDisabled, false);
    assert.equal(state.nextDisabled, false);
});
test('video seek controls remain enabled at playback boundaries so double tap can skip items', () => {
    const atStart = playbackNavigationState(playback({
        itemId: 'video-1',
        kind: 'video',
        display: { itemId: 'video-1', currentTime: 0, duration: 60, seekable: true, observedAt: Date.now() },
    }));
    assert.equal(atStart.previousDisabled, false);
    assert.equal(atStart.nextDisabled, false);
    const atEnd = playbackNavigationState(playback({
        itemId: 'video-1',
        kind: 'video',
        display: { itemId: 'video-1', currentTime: 60, duration: 60, seekable: true, observedAt: Date.now() },
    }));
    assert.equal(atEnd.previousDisabled, false);
    assert.equal(atEnd.nextDisabled, false);
});
test('disconnected, stale, unseekable, and transitioned display state falls back to slideshow navigation', () => {
    for (const state of [
        playback({ itemId: 'video-1', kind: 'video', display: null }),
        playback({
            itemId: 'video-2',
            kind: 'video',
            display: { itemId: 'video-1', currentTime: 10, duration: 60, seekable: true, observedAt: Date.now() },
        }),
        playback({
            itemId: 'video-1',
            kind: 'video',
            display: { itemId: 'video-1', currentTime: 10, duration: 60, seekable: false, observedAt: Date.now() },
        }),
    ]) {
        assert.equal(playbackNavigationState(state).action, 'slideshow');
    }
});
//# sourceMappingURL=playbackState.test.js.map