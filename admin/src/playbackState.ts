import type { Playback } from './api.js';

export const VIDEO_SEEK_SECONDS = 10;

export interface PlaybackNavigationState {
  previousLabel: string;
  nextLabel: string;
  previousDisabled: boolean;
  nextDisabled: boolean;
  action: 'slideshow' | 'video-seek';
}

export function playbackNavigationState(playback: Playback): PlaybackNavigationState {
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
    previousLabel: `Seek backward ${VIDEO_SEEK_SECONDS} seconds`,
    nextLabel: `Seek forward ${VIDEO_SEEK_SECONDS} seconds`,
    previousDisabled: display.currentTime <= 0,
    nextDisabled: display.currentTime >= display.duration,
    action: 'video-seek',
  };
}
