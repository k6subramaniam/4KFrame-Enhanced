export declare const TAP_MOVEMENT_TOLERANCE_PX = 10;
export declare const TAP_DURATION_MS = 300;
export declare const MULTI_TAP_WINDOW_MS = 350;
export declare const TRIPLE_TAP_ZOOM_STEP = 0.5;
export interface TapSequence {
    zoom: number;
    tapCount: number;
    durationMs: number;
    movementPx: number;
    maxPointerCount: number;
}
export interface TapZoomPatch {
    zoom: number;
    panX?: number;
    panY?: number;
}
/**
 * Resolves a completed touch/pen tap sequence. Triple-tap zooms out by 0.5x;
 * double-tap starts at 2x and subsequent double-taps add 0.5x.
 */
export declare function calculateTapZoom(sequence: TapSequence, minZoom: number, maxZoom: number): TapZoomPatch | null;
