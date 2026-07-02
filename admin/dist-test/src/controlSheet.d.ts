export interface ControlSheetElements {
    toggle?: HTMLButtonElement | null;
    close?: HTMLButtonElement | null;
    sheet?: HTMLElement | null;
    backdrop?: HTMLElement | null;
    body?: HTMLElement | null;
    document?: Document | null;
}
export interface ControlSheetController {
    isOpen(): boolean;
    setOpen(open: boolean): void;
}
export declare function wireControlSheet(elements: ControlSheetElements, initialOpen?: boolean): ControlSheetController;
