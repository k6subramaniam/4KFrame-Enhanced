export interface VideoPlaybackSyncOptions {
  muted: boolean;
  loop: boolean;
  restartAfterUnmute?: boolean;
  onPlaybackRejected: (error: unknown) => void;
}

type VideoPlaybackElement = Pick<HTMLVideoElement, 'muted' | 'defaultMuted' | 'volume' | 'loop' | 'play'>;

export const AUDIBLE_VIDEO_VOLUME = 1;

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
