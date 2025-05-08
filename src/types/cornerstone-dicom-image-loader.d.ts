declare module '@cornerstonejs/core' {
    export function init(): Promise<void>;
    export class RenderingEngine {
        constructor(id: string);
        enableElement(options: ViewportInputOptions): void;
        getViewport(viewportId: string): Viewport;
        destroy(): void;
    }
    export const imageLoader: {
        loadImage: (imageId: string) => Promise<ImageType>;
    };
    export const getDefaultViewport: (element: HTMLElement, image: ImageType) => ViewportType;
    export const Enums: {
        ViewportType: {
            STACK: string;
        };
    };
}

declare module '@cornerstonejs/dicom-image-loader' {
    export function initializeCodecs(): Promise<void>;
    export const external: {
        cornerstone: any;
    };
    export function configure(options: {
        useWebWorkers: boolean;
        decodeConfig: {
            convertFloatPixelDataToInt: boolean;
        };
    }): void;
    export const wadouri: {
        fileManager: {
            add: (file: Blob) => string;
        };
    };
}

interface ViewportInputOptions {
    viewportId: string;
    element: HTMLElement;
    type: string;
}

interface Viewport {
    setStack(imageIds: string[]): Promise<void>;
    render(): Promise<void>;
}

interface ImageType {
    width: number;
    height: number;
}