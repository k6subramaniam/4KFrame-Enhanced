export interface VideoPlaybackSyncOptions {
  muted: boolean;
  loop: boolean;
  restartAfterUnmute?: boolean;
  onPlaybackRejected: (error: unknown) => void;
}

type VideoPlaybackElement = Pick<HTMLVideoElement, 'muted' | 'loop' | 'play'>;

/** Apply playback preferences immediately and restart an active video after unmuting when requested. */
export function syncVideoPlaybackProperties(
  video: VideoPlaybackElement,
  options: VideoPlaybackSyncOptions,
): void {
  const becameAudible = video.muted && !options.muted;
  video.muted = options.muted;
  video.loop = options.loop;

  if (options.restartAfterUnmute && becameAudible) {
    video.play().catch(options.onPlaybackRejected);
  }
}
