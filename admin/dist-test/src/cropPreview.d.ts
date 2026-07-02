import type { MediaItem } from '@4kframe/shared';
export interface CropPreviewConfig {
    fillMode?: string;
    frameAspect?: string;
    zoom?: string | number;
    panX?: string | number;
    panY?: string | number;
}
export type CropPreviewUpdater = (patch: CropPreviewConfig) => void;
export declare function cropPreviewControlPatch(action: string, state: {
    zoom: number;
    panX: number;
    panY: number;
}): {
    zoom?: number;
    panX?: number;
    panY?: number;
} | null;
export declare function renderCropPreview(item: MediaItem | undefined, config: CropPreviewConfig): string;
export declare function wireCropPreview(root: HTMLElement, updateConfig: (patch: Record<string, string>) => void | Promise<void>): CropPreviewUpdater;
