import { App, WorkspaceLeaf, TFile } from 'obsidian';

export class ViewerService {
    private container: HTMLElement | null = null;

    constructor() {
        // Initialize viewer service
    }

    initialize(container: HTMLElement): void {
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
}