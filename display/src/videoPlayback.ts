export interface VideoPlaybackSyncOptions {
  muted: boolean;
  loop: boolean;
  restartAfterUnmute?: boolean;
  onPlaybackRejected: (error: unknown) => void;
}

type VideoPlaybackElement = Pick<HTMLVideoElement, 'muted' | 'defaultMuted' | 'volume' | 'loop' | 'play'>;

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
