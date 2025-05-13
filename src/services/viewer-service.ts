import { App, WorkspaceLeaf, TFile, Notice, TFolder } from 'obsidian';
import { DICOMService } from './dicom-service';
import { Progress } from '../models/types';

type ProgressCallback = (progress: Progress) => void;

interface SeriesInfo {
    folderPath: string;
    isReport: boolean;
}

export class ViewerService {
    private container: HTMLElement | null = null;
    private dicomService: DICOMService;

    constructor(app: App, dicomService: DICOMService) {
        this.dicomService = dicomService;
    }

    async initialize(container: HTMLElement): Promise<void> {
        this.container = container;
    }

    async displayDicomImage(imageData: string): Promise<void> {
        if (!this.container) {
            throw new Error('Viewer not initialized');
        }

        const img = document.createElement('img');
        img.src = imageData;
        img.className = 'dicom-image';

        this.container.empty();
        this.container.appendChild(img);
    }

    private async processFiles(files: TFile[], onProgress?: ProgressCallback): Promise<void> {
        const seriesMap = new Map<string, SeriesInfo>();
        // ...existing code...

        // Create animated GIFs for each series
        onProgress?.({ percentage: 90, message: 'Creating animated GIFs...' });
        for (const { folderPath, isReport } of seriesMap.values()) {
            if (!isReport) {
                try {
                    const seriesFolder = folderPath.split('/').pop() || 'series';
                    const gifPath = `${folderPath}/${seriesFolder}.gif`;
                    const imagesPath = `${folderPath}/Images`;

                    await this.dicomService.createAnimatedGif(imagesPath, gifPath)
                        .catch((error: Error) => {
                            console.error(`Failed to create GIF for series ${seriesFolder}: ${error.message}`);
                            new Notice(`Warning: Could not create GIF for series ${seriesFolder}`, 5000);
                            // Continue processing other series
                        });
                } catch (error) {
                    // Log error and continue with other series rather than failing the whole process
                    if (error instanceof Error) {
                        console.error(`Error creating GIF: ${error.message}`);
                    }
                }
            }
        }

        // Create metadata notes
        onProgress?.({ percentage: 95, message: 'Creating metadata notes...' });
        // ...rest of existing code...
    }
}