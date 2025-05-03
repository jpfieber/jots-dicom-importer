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