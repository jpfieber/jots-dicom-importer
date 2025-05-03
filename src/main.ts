import { Plugin, TFile, Notice, TFolder } from 'obsidian';
import { DICOMHandlerSettings, DEFAULT_SETTINGS, DICOMHandlerSettingsTab } from './settings';
import { DICOMService } from './services/dicom-service';
import { FileService } from './services/file-service';
import { ViewerService } from './services/viewer-service';
import { DicomTags } from './models/dicom-tags';
import * as path from 'path';
import * as fs from 'fs/promises';
import dicomParser from 'dicom-parser';

export default class DICOMHandlerPlugin extends Plugin {
    settings!: DICOMHandlerSettings;
    dicomService!: DICOMService;
    fileService!: FileService;
    viewerService!: ViewerService;

    async onload() {
        await this.loadSettings();

        this.dicomService = new DICOMService(this.app, this.settings);
        this.fileService = new FileService();
        this.viewerService = new ViewerService();

        this.addSettingTab(new DICOMHandlerSettingsTab(this.app, this));

        this.addCommand({
            id: 'import-dicom-to-image',
            name: 'Import DICOM to Image',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile?.extension === 'dcm') {
                    if (!checking) {
                        this.convertDicomToImage(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'import-folder',
            name: 'Import All DICOM Files in Folder',
            callback: async () => {
                if (!this.settings.lastFolderPath) {
                    new Notice('Please select a source folder in settings first');
                    return;
                }
                if (!this.settings.destinationFolderPath) {
                    new Notice('Please select a destination folder in settings first');
                    return;
                }
                await this.convertFolder(
                    this.settings.lastFolderPath,
                    this.settings.destinationFolderPath
                );
            }
        });
    }

    private getOrganizedFolderPath(basePath: string, dataset: dicomParser.DataSet): string {
        const parts: string[] = [basePath];

        // Patient folder handling (unchanged)
        if (this.settings.usePatientFolder) {
            const folderParts: string[] = [];
            if (this.settings.includePatientId) {
                const id = dataset.string(DicomTags.PatientID);
                if (id) folderParts.push(id);
            }
            if (this.settings.includePatientName) {
                const name = dataset.string(DicomTags.PatientName);
                if (name) folderParts.push(name);
            }
            if (this.settings.includePatientBirthday) {
                const dob = dataset.string(DicomTags.PatientBirthDate);
                if (dob) folderParts.push(dob);
            }
            if (folderParts.length > 0) {
                parts.push(folderParts.join('_'));
            }
        }

        // Study folder
        if (this.settings.useStudyFolder) {
            const studyParts: string[] = [];

            const studyDate = dataset.string(DicomTags.StudyDate);
            const modality = dataset.string(DicomTags.Modality);
            const studyDesc = dataset.string(DicomTags.StudyDescription);
            const studyId = dataset.string(DicomTags.StudyID);

            // Always put date first if available
            if (this.settings.includeStudyDate && studyDate) studyParts.push(studyDate);

            // Join date and 'Study' with spaced hyphen, then join rest with regular hyphens
            const restOfParts: string[] = ['Study'];
            if (this.settings.includeStudyModality && modality) restOfParts.push(modality);
            if (this.settings.includeStudyDescription && studyDesc) restOfParts.push(studyDesc);
            if (this.settings.includeStudyId && studyId) restOfParts.push(studyId);

            const studyFolderName = studyDate
                ? `${studyDate} - ${restOfParts.join('-')}`
                : restOfParts.join('-');

            parts.push(studyFolderName);
        }

        // Series folder - always include series description if available
        if (this.settings.useSeriesFolder) {
            const seriesParts: string[] = [];

            const seriesDate = dataset.string(DicomTags.SeriesDate);
            const seriesNum = dataset.string(DicomTags.SeriesNumber);
            const seriesDesc = dataset.string(DicomTags.SeriesDescription);

            // Join date and 'Series' with spaced hyphen, then join rest with regular hyphens
            const restOfParts: string[] = ['Series'];
            if (this.settings.includeSeriesNumber && seriesNum) restOfParts.push(seriesNum);
            if (seriesDesc) restOfParts.push(seriesDesc);

            const seriesFolderName = seriesDate
                ? `${seriesDate} - ${restOfParts.join('-')}`
                : restOfParts.join('-');

            parts.push(seriesFolderName);
        }

        // Sanitize folder names to be safe for filesystem
        // Don't include / in sanitization since basePath is already a valid path
        return parts.map(part =>
            part === basePath ? part : part.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_')
        ).join('/');
    }

    private async convertDicomToImage(file: TFile, destFolder?: TFolder) {
        try {
            const arrayBuffer = await this.app.vault.readBinary(file);
            const dicomData = this.dicomService.parseDicomData(arrayBuffer);
            const imageData = await this.dicomService.convertToImage(file);

            if (!destFolder) {
                if (!file.parent) {
                    throw new Error('File has no parent folder');
                }
                destFolder = file.parent;
            }

            // Get organized folder path and normalize it
            const basePath = destFolder.path;
            const organizedPath = this.getOrganizedFolderPath(basePath, dicomData);

            // Create all necessary folders
            const folders = organizedPath.split('/').filter(part => part.length > 0);
            let currentPath = '';
            for (const folder of folders) {
                currentPath = currentPath ? `${currentPath}/${folder}` : folder;
                const existing = this.app.vault.getAbstractFileByPath(currentPath);
                if (!existing) {
                    await this.app.vault.createFolder(currentPath);
                }
            }

            // Get study date from DICOM data and format filename
            const studyDate = dicomData.string(DicomTags.StudyDate) || '';
            const formattedDate = studyDate ? studyDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1$2$3') : '';
            const newFileName = formattedDate
                ? `${formattedDate} - IMG${file.basename}.${this.settings.imageFormat}`
                : `IMG${file.basename}.${this.settings.imageFormat}`;
            const newPath = `${organizedPath}/${newFileName}`;

            // Convert base64 to binary
            const base64Data = imageData.replace(new RegExp(`^data:image/${this.settings.imageFormat};base64,`), '');
            const binaryData = Buffer.from(base64Data, 'base64');

            await this.app.vault.createBinary(newPath, binaryData);

            // Create metadata note
            await this.createMetadataNote(dicomData, organizedPath);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`Failed to convert DICOM: ${error.message}`);
            } else {
                console.error('Failed to convert DICOM: Unknown error');
            }
            throw error; // Re-throw to be handled by the bulk conversion process
        }
    }

    private async createMetadataNote(dataset: dicomParser.DataSet, folderPath: string) {
        try {
            const elements = dataset.elements;
            const metadata: Record<string, any> = {};

            // Process all DICOM elements
            for (const tag in elements) {
                try {
                    const element = elements[tag];
                    if (element) {
                        let value;
                        if (element.vr === 'DS' || element.vr === 'FL' || element.vr === 'FD') {
                            value = dataset.floatString(tag);
                            // Handle NaN values
                            if (typeof value === 'number' && isNaN(value)) {
                                continue;
                            }
                        } else if (element.vr === 'IS' || element.vr === 'SL' || element.vr === 'SS' || element.vr === 'UL' || element.vr === 'US') {
                            value = dataset.uint16(tag);
                        } else {
                            value = dataset.string(tag);
                        }

                        if (value !== undefined && value !== null && value !== '') {
                            // Clean up multi-line values and handle special characters
                            if (typeof value === 'string') {
                                // Replace any sequence of whitespace (including newlines) with a single space
                                value = value.replace(/\s+/g, ' ').trim();

                                // Handle backslashes in string values
                                if (value.includes('\\')) {
                                    value = value.split('\\').join('_');
                                }
                            }

                            // Get descriptive name for the tag
                            const descriptiveName = DicomTags.getDescriptiveName(tag);
                            metadata[descriptiveName] = value;
                        }
                    }
                } catch (e) {
                    // Silently skip problematic tags
                }
            }

            // Create markdown content with properly formatted YAML
            let content = '---\n';
            const sortedKeys = Object.keys(metadata).sort();

            for (const key of sortedKeys) {
                const value = metadata[key];
                if (value === undefined || value === null) continue;

                if (Array.isArray(value)) {
                    content += `${key}:\n`;
                    value.forEach(item => {
                        const escapedItem = typeof item === 'string'
                            ? item.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                            : item;
                        content += `  - "${escapedItem}"\n`;
                    });
                }
                else if (typeof value === 'object' && value !== null) {
                    // Convert object to string representation
                    content += `${key}: ${JSON.stringify(value)}\n`;
                }
                else if (typeof value === 'string') {
                    // Always quote string values and escape special characters
                    const escapedValue = value
                        .replace(/\\/g, '\\\\')
                        .replace(/"/g, '\\"')
                        .replace(/\n/g, ' ')  // Replace newlines with spaces
                        .replace(/\r/g, '');  // Remove carriage returns
                    content += `${key}: "${escapedValue}"\n`;
                }
                else if (typeof value === 'number') {
                    if (isNaN(value)) {
                        continue; // Skip NaN values
                    }
                    content += `${key}: ${value}\n`;
                }
                else if (typeof value === 'boolean') {
                    content += `${key}: ${value}\n`;
                }
            }
            content += '---\n\n';

            // Add basic content with date-first title
            const seriesDesc = dataset.string(DicomTags.SeriesDescription) || 'DICOM Series';
            const studyDate = dataset.string(DicomTags.StudyDate) || '';
            const titleDate = studyDate ? `${studyDate} - ` : '';

            content += `# ${titleDate}${seriesDesc}\n\n`;
            content += `This note contains metadata for a DICOM series${studyDate ? ` acquired on ${studyDate}` : ''}.\n`;

            const folderName = folderPath.split('/').pop() || 'series';
            const notePath = `${folderPath}/${studyDate ? studyDate + ' - ' : ''}${folderName}.md`;

            await this.app.vault.create(notePath, content);
        } catch (error) {
            // Silently handle errors
        }
    }

    private isDicomFile(filename: string): boolean {
        if (this.settings.dicomIdentification === 'extension') {
            return filename.toLowerCase().endsWith(`.${this.settings.dicomExtension.toLowerCase()}`);
        } else {
            // Check if file has no extension
            return path.extname(filename) === '';
        }
    }

    async convertFolder(sourceFolderPath: string, destinationFolderPath: string) {
        try {
            // Get source and destination folders from vault
            const sourceFolder = this.app.vault.getAbstractFileByPath(sourceFolderPath);
            if (!sourceFolder || !(sourceFolder instanceof TFolder)) {
                throw new Error('Source folder not found in vault');
            }

            // Normalize the destination path and ensure each part of the path exists
            const pathParts = destinationFolderPath.split('/').filter(part => part.length > 0);
            let currentPath = '';
            let destFolder: TFolder | null = null;

            for (const part of pathParts) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                const existing = this.app.vault.getAbstractFileByPath(currentPath);

                if (!existing) {
                    // Create this part of the path
                    destFolder = await this.app.vault.createFolder(currentPath);
                } else if (existing instanceof TFolder) {
                    destFolder = existing;
                } else {
                    throw new Error(`Path exists but is not a folder: ${currentPath}`);
                }
            }

            if (!destFolder) {
                throw new Error('Could not create or access destination folder');
            }

            // Rest of the method remains the same...
            const allFiles = this.app.vault.getAllLoadedFiles();
            const folderFiles = allFiles.filter(file =>
                file instanceof TFile &&
                file.path.startsWith(sourceFolderPath + '/') &&
                this.isDicomFile(file.name)
            ) as TFile[];

            if (folderFiles.length === 0) {
                const methodDesc = this.settings.dicomIdentification === 'extension'
                    ? `files with .${this.settings.dicomExtension} extension`
                    : 'files without extension';
                new Notice(`No DICOM files found (looking for ${methodDesc})`);
                return;
            }

            let converted = 0;
            const totalFiles = folderFiles.length;

            // Create progress container
            const progressEl = document.createElement('div');
            progressEl.addClass('dicom-progress');

            // Add text status
            const statusEl = document.createElement('div');
            statusEl.setText(`Importing DICOM files... 0/${totalFiles}`);
            progressEl.appendChild(statusEl);

            // Add progress bar
            const progressBarEl = document.createElement('div');
            progressBarEl.addClass('dicom-progress-bar');
            const progressFillEl = document.createElement('div');
            progressFillEl.addClass('dicom-progress-bar-fill');
            progressFillEl.style.width = '0%';
            progressBarEl.appendChild(progressFillEl);
            progressEl.appendChild(progressBarEl);

            document.body.appendChild(progressEl);

            for (const file of folderFiles) {
                try {
                    // Create a new TFile with the destination folder
                    const modifiedFile = {
                        ...file,
                        parent: destFolder
                    } as TFile;

                    await this.convertDicomToImage(modifiedFile);
                    converted++;

                    // Update progress
                    const percentage = Math.round((converted / totalFiles) * 100);
                    statusEl.setText(`Importing DICOM files... ${converted}/${totalFiles} (${percentage}%)`);
                    progressFillEl.style.width = percentage + '%';

                } catch (error) {
                    console.error(`Error importing ${file.name}:`, error);
                    if (error instanceof Error) {
                        new Notice(`Error importing ${file.name}: ${error.message}`);
                    }
                }
            }

            // Remove progress element
            progressEl.remove();
            new Notice(`Successfully imported ${converted} of ${totalFiles} DICOM files to ${destinationFolderPath}`);

        } catch (error) {
            if (error instanceof Error) {
                new Notice(`Error accessing folders: ${error.message}`);
            } else {
                new Notice('Error accessing folders');
            }
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}