/** Thin REST client for the admin PWA. */
import type { ApiDataPayload, ControlMessage, CurrentResponse, DisplayPlaybackState, MediaItem, MediaKind } from '@4kframe/shared';
export declare function fetchItems(): Promise<MediaItem[]>;
export declare function fetchCurrent(): Promise<CurrentResponse>;
export declare function fetchData(): Promise<ApiDataPayload>;
export declare function sendControl(message: ControlMessage): Promise<boolean>;
export declare function updateData(patch: Record<string, string>): Promise<void>;
export declare function castItem(id: string): Promise<void>;
export declare function deleteItem(id: string): Promise<void>;
export declare function setItemsEnabled(ids: string[], enabled: boolean): Promise<void>;
export declare function deleteItems(ids: string[]): Promise<void>;
export declare function playSequence(ids: string[]): Promise<void>;
export interface AuthState {
    required: boolean;
    authed: boolean;
    /** Which login methods the server offers (older servers omit this). */
    methods?: {
        password: boolean;
        google: boolean;
    };
}
export declare function me(): Promise<AuthState>;
export declare function login(password: string): Promise<boolean>;
export declare function logout(): Promise<void>;
export declare function skipNext(): Promise<void>;
export declare function skipPrev(): Promise<void>;
export interface Playback {
    paused: boolean;
    holding: boolean;
    itemId: string | null;
    kind: MediaKind | null;
    display: DisplayPlaybackState | null;
}
export declare function getPlayback(): Promise<Playback>;
export declare function setPaused(paused: boolean): Promise<void>;
export declare function setHold(holding: boolean): Promise<void>;
export declare function seekBy(deltaSec: number): Promise<void>;
/** Include/exclude an item from rotation; returns the new enabled state. */
export declare function toggleEnabled(id: string): Promise<boolean>;
export declare function patchMediaTransforms(ids: string[], transform: Partial<Pick<MediaItem, 'rotation' | 'flipHorizontal' | 'flipVertical'>>): Promise<MediaItem[]>;
export interface UploadResult {
    ok: boolean;
    added: MediaItem[];
    errors?: {
        filename: string;
        error: string;
    }[];
}
export declare function upload(files: FileList | File[], onProgress?: (fraction: number) => void): Promise<UploadResult>;
export interface GoogleStatus {
    configured: boolean;
    connected: boolean;
}
export declare function googleStatus(): Promise<GoogleStatus>;
export interface PickerSession {
    id: string;
    pickerUri: string;
    mediaItemsSet: boolean;
    pollIntervalMs: number;
}
/** Create a Google Photos Picker session (returns the URI the user opens to pick). */
export declare function createPickerSession(): Promise<PickerSession>;
/** Poll a Picker session to see whether the user has finished selecting. */
export declare function pollPickerSession(id: string): Promise<PickerSession>;
/** Import the items the user picked in a session. Returns how many were added. */
export declare function importPickerSession(id: string): Promise<number>;
export declare function thumbUrl(item: MediaItem): string;
