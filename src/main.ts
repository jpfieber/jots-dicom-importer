import { Plugin, TFile, Notice, TFolder } from 'obsidian';
import { DICOMHandlerSettings, DEFAULT_SETTINGS, DICOMHandlerSettingsTab } from './settings';
import { DICOMService } from './services/dicom-service';
import { FileService } from './services/file-service';
import { ViewerService } from './services/viewer-service';
import { BatchProcessor } from './services/batch-processor';
import { MetadataService } from './services/metadata-service';
import { ImportModal } from './ui/import-modal';
import * as path from 'path';
import * as fs from 'fs/promises';

export default class DICOMHandlerPlugin extends Plugin {
    settings!: DICOMHandlerSettings;
    dicomService!: DICOMService;
    fileService!: FileService;
    viewerService!: ViewerService;
    metadataService!: MetadataService;
    batchProcessor!: BatchProcessor;

    async onload() {
        await this.loadSettings();

        this.dicomService = new DICOMService(this.app, this.settings);
        this.fileService = new FileService(this.settings);
        this.viewerService = new ViewerService(this.app, this.dicomService);
        this.metadataService = new MetadataService(this.app, this.settings);
        this.batchProcessor = new BatchProcessor(this.app, this.dicomService, this.metadataService, this.settings);

        this.addSettingTab(new DICOMHandlerSettingsTab(this.app, this));

        this.addCommand({
            id: 'import-dicom-to-image',
            name: 'Import DICOM to Image',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile?.extension === 'dcm') {
                    if (!checking) {
                        this.batchProcessor.processSingleFile(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'import-folder',
            name: 'Import All DICOM Files in Folder',
            callback: () => {
                if (!this.settings.sourceFolderPath) {
                    new Notice('Please configure the source folder in settings');
                    return;
                }
                if (!this.settings.destinationFolderPath) {
                    new Notice('Please configure the destination folder in settings');
                    return;
                }
                new ImportModal(this).open();
            }
        });
    }

    async convertFolder(sourceFolderPath: string, destinationFolderPath: string,
        onProgress?: (progress: { percentage: number, message: string }) => void) {
        try {
            await this.validateSettings();
            const dicomFiles = await this.fileService.findDicomFiles(sourceFolderPath);

            if (dicomFiles.length === 0) {
                throw new Error('No DICOM files found');
            }

            onProgress?.({ percentage: 20, message: `Found ${dicomFiles.length} DICOM files to import` });

            // Read all files first
            const fileBuffers = await Promise.all(dicomFiles.map(async path => ({
                path,
                buffer: await fs.readFile(path)
            })));

            // Process all files in a single batch
            await this.batchProcessor.processBatch(fileBuffers, destinationFolderPath, onProgress);

            onProgress?.({ percentage: 100, message: 'Import complete' });
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error importing files: ${error.message}`);
            }
            throw new Error('Error importing files');
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private async validateSettings(): Promise<void> {
        if (!this.settings.opjPath) {
            throw new Error('Please configure the OpenJPEG path in settings');
        }

        try {
            await fs.access(this.settings.opjPath);
        } catch {
            throw new Error('OpenJPEG executable not found at specified path');
        }
    }
}