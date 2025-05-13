import { App, WorkspaceLeaf, TFile, Notice, TFolder } from 'obsidian';
import { DICOMService } from './dicom-service';
import { Progress } from '../models/types';
import * as path from 'path';

export class ViewerService {
    private container: HTMLElement | null = null;
    private dicomService: DICOMService;
    private app: App;

    constructor(app: App, dicomService: DICOMService) {
        this.app = app;
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

    private async updateGif(seriesPath: string): Promise<void> {
        try {
            // Remove any existing series-level GIF first
            const seriesName = seriesPath.split('/').pop() || 'series';
            const gifPath = path.join(seriesPath, `${seriesName}.gif`).replace(/\\/g, '/');
            const gifFile = this.app.vault.getAbstractFileByPath(gifPath);
            if (gifFile instanceof TFile) {
                await this.app.vault.delete(gifFile);
            }

            // Create new GIF
            const imagesPath = path.join(seriesPath, 'Images').replace(/\\/g, '/');
            try {
                await this.dicomService.createAnimatedGif(imagesPath, gifPath);
            } catch (error: any) {
                console.error(`Failed to create GIF for series ${seriesPath}: ${error.message}`);
            }

        } catch (error: any) {
            console.error(`Error creating GIF: ${error.message}`);
        }
    }
}