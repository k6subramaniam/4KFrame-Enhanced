import type { MediaItem } from '@4kframe/shared';
export type DateField = 'uploaded' | 'created';
export type MediaKindFilter = 'all' | 'photo' | 'video';
export type SizeFilter = 'all' | 'under-10mb' | '10-100mb' | '100mb-1gb' | 'over-1gb' | 'unknown';
export interface MediaFilterState {
    dateField: DateField;
    startDate: string;
    endDate: string;
    kind: MediaKindFilter;
    uploader: string;
    size: SizeFilter;
    storage: string;
}
export type DatePreset = 'today' | '7-days' | '30-days' | 'this-month' | 'last-month' | 'clear';
export declare const DEFAULT_MEDIA_FILTERS: MediaFilterState;
export declare function itemUploader(item: MediaItem): string;
export declare function itemStorage(item: MediaItem): string;
export declare function itemDate(item: MediaItem, field: DateField): number;
export declare function filterLibraryItems(source: MediaItem[], filters: MediaFilterState): MediaItem[];
export declare function formatBytes(bytes: number | undefined): string;
export declare function datePresetRange(preset: DatePreset, now?: Date): {
    startDate: string;
    endDate: string;
};
