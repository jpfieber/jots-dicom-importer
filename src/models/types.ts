// src/models/types.ts

// Define the DICOM data structure
export interface DICOMFile {
    patientId: string;
    studyInstanceUid: string;
    seriesInstanceUid: string;
    sopInstanceUid: string;
    studyDate: string;
    modality: string;
    pixelData: Uint8Array; // Raw pixel data
}

// Define a type for DICOM metadata
export interface DICOMMetadata {
    [key: string]: string | number | boolean; // Flexible metadata structure
}

// Define a type for the plugin settings
export interface PluginSettings {
    enableAutoLoad: boolean;
    defaultViewer: string; // e.g., 'image', '3D'
}

// Define type for progress updates
export interface Progress {
    percentage: number;
    message: string;
    phase?: 'analyzing' | 'importing' | 'creating-folders' | 'processing-files' | 'creating-metadata';
}