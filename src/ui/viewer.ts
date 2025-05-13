import { Plugin } from 'obsidian';
import { ViewerService } from '../services/viewer-service';
import { DICOMService } from '../services/dicom-service';
import DICOMHandlerPlugin from '../main';

export class DICOMViewerUI {
    private viewer: ViewerService;

    constructor(plugin: DICOMHandlerPlugin) {
        const dicomService = new DICOMService(plugin.app, plugin.settings);
        this.viewer = new ViewerService(plugin.app, dicomService);
    }

    public render(container: HTMLElement): void {
        const viewerContainer = document.createElement('div');
        viewerContainer.className = 'dicom-viewer-container';
        container.appendChild(viewerContainer);

        // Initialize the viewer with the container
        this.viewer.initialize(viewerContainer);
    }
}