export type VideoAudioMode = 'tv' | 'muted' | 'phone';

export function mutedForVideoAudioMode(mode: VideoAudioMode): boolean {
  return mode === 'muted';
}

export function playbackBlockedStatusMessage(mode: VideoAudioMode): string {
  if (mode === 'tv') {
    return 'TV blocked autoplay audio. Press Play on the TV/browser to resume with sound.';
  }
  if (mode === 'phone') {
    return 'Phone/browser audio may need a tap before it can play. Tap Play in the admin/controller UI to resume with sound.';
  }
  return 'Video playback was blocked. Press Play to resume muted playback.';
}

export interface VideoPlaybackSyncOptions {
  muted: boolean;
  loop: boolean;
  playbackRate: number;
  restartAfterUnmute?: boolean;
  onPlaybackRejected: (error: unknown) => void;
}

type VideoPlaybackElement = Pick<HTMLVideoElement, 'muted' | 'defaultMuted' | 'volume' | 'loop' | 'playbackRate' | 'defaultPlaybackRate' | 'play'>;

export const AUDIBLE_VIDEO_VOLUME = 1;
type SeekableVideoElement = Pick<HTMLVideoElement, 'currentTime' | 'duration' | 'readyState'>;

/** Apply playback preferences immediately and restart an active video after unmuting when requested. */
export function syncVideoPlaybackProperties(
  video: VideoPlaybackElement,
  options: VideoPlaybackSyncOptions,
): void {
  const becameAudible = video.muted && !options.muted;
  video.muted = options.muted;
  video.defaultMuted = options.muted;
  video.volume = AUDIBLE_VIDEO_VOLUME;
  video.loop = options.loop;
  const playbackRate = Number.isFinite(options.playbackRate)
    ? Math.min(4, Math.max(0.25, options.playbackRate))
    : 1;
  video.playbackRate = playbackRate;
  video.defaultPlaybackRate = playbackRate;

  if (options.restartAfterUnmute && becameAudible) {
    video.play().catch(options.onPlaybackRejected);
  }
}

/** Seek an active, metadata-ready video and clamp the target to its finite duration. */
export function seekActiveVideo(
  video: SeekableVideoElement,
  offsetSec: number,
  active: boolean,
): boolean {
  if (!active
    || video.readyState < 1
    || !Number.isFinite(video.currentTime)
    || !Number.isFinite(video.duration)
    || video.duration < 0
    || !Number.isFinite(offsetSec)) return false;

  video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + offsetSec));
  return true;
}
