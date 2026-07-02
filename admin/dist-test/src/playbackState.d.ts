import type { Playback } from './api.js';
export declare const VIDEO_SEEK_SECONDS = 10;
export interface PlaybackNavigationState {
    previousLabel: string;
    nextLabel: string;
    previousDisabled: boolean;
    nextDisabled: boolean;
    action: 'slideshow' | 'video-seek';
}
export declare function playbackNavigationState(playback: Playback): PlaybackNavigationState;
