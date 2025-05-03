import { Plugin } from 'obsidian';
import { ViewerService } from '../services/viewer-service';

export class DICOMViewerUI {
    private viewer: ViewerService;

    constructor(plugin: Plugin) {
        this.viewer = new ViewerService();
    }

    public render(container: HTMLElement): void {
        const viewerContainer = document.createElement('div');
        viewerContainer.className = 'dicom-viewer-container';
        container.appendChild(viewerContainer);

        // Initialize the viewer with the container
        this.viewer.initialize(viewerContainer);
    }
}