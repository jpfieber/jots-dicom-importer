// src/models/types.ts

// Define type for progress updates
export interface Progress {
    percentage: number;
    message: string;
    phase?: 'analyzing' | 'importing' | 'creating-folders' | 'processing-files' | 'creating-metadata';
}