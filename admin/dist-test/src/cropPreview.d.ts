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
/** Markup for the "Now playing crop" section, including its heading. */
export declare function activeCropPreviewSectionHtml(item: MediaItem | undefined, config: CropPreviewConfig): string;
/**
 * Rebuild and rewire just the "Now playing crop" section within an already-rendered
 * settings root, without touching the other panels. Used to keep the preview tracking
 * the item actually playing on the display (e.g. on a WebSocket 'show' event) without
 * the flicker/cost of a full renderSettings() pass.
 */
export declare function renderActiveCropPreview(settingsRoot: ParentNode, item: MediaItem | undefined, config: CropPreviewConfig, updateConfig: (patch: Record<string, string>) => void | Promise<void>): void;
export declare function wireCropPreview(root: HTMLElement, updateConfig: (patch: Record<string, string>) => void | Promise<void>): CropPreviewUpdater;
