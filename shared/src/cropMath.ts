export interface PreviewFrameSize {
  width: number;
  height: number;
}

export interface PreviewMediaSize {
  width: number;
  height: number;
}

export interface PanConversionInput {
  startPanX: number;
  startPanY: number;
  deltaX: number;
  deltaY: number;
  frame: PreviewFrameSize;
  media: PreviewMediaSize;
  fillMode: string;
  zoom: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function effectiveFit(fillMode: string): 'cover' | 'contain' | 'stretch' {
  if (fillMode === 'contain' || fillMode === 'blur') return 'contain';
  if (fillMode === 'stretch') return 'stretch';
  return 'cover';
}

export function fittedPreviewSize(
  media: PreviewMediaSize,
  frame: PreviewFrameSize,
  fillMode: string,
  zoom: number,
): PreviewFrameSize {
  const z = clamp(zoom, 1, 3);
  if (effectiveFit(fillMode) === 'stretch') return { width: frame.width * z, height: frame.height * z };
  const base = effectiveFit(fillMode) === 'cover'
    ? Math.max(frame.width / media.width, frame.height / media.height)
    : Math.min(frame.width / media.width, frame.height / media.height);
  return { width: media.width * base * z, height: media.height * base * z };
}

export function panFromPixelDrag(input: PanConversionInput): { panX: number; panY: number } {
  const fitted = fittedPreviewSize(input.media, input.frame, input.fillMode, input.zoom);
  const overflowX = Math.max(0, fitted.width - input.frame.width);
  const overflowY = Math.max(0, fitted.height - input.frame.height);
  const panX = overflowX > 0 ? input.startPanX - (2 * input.deltaX) / overflowX : 0;
  const panY = overflowY > 0 ? input.startPanY - (2 * input.deltaY) / overflowY : 0;
  return { panX: clamp(panX, -1, 1), panY: clamp(panY, -1, 1) };
}
