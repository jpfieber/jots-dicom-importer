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
            id: 'convert-dicom-to-image',
            name: 'Convert DICOM to Image',
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
            id: 'convert-folder',
            name: 'Convert All DICOM Files in Folder',
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

        // Patient folder handling
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
            const studyParts: string[] = ['Study'];

            const modality = dataset.string(DicomTags.Modality);
            const studyDesc = dataset.string(DicomTags.StudyDescription);
            const studyDate = dataset.string(DicomTags.StudyDate);
            const studyId = dataset.string(DicomTags.StudyID);

            if (this.settings.includeStudyModality && modality) studyParts.push(modality);
            if (this.settings.includeStudyDescription && studyDesc) studyParts.push(studyDesc);
            if (this.settings.includeStudyDate && studyDate) studyParts.push(studyDate);
            if (this.settings.includeStudyId && studyId) studyParts.push(studyId);

            parts.push(studyParts.join('-'));
        }

        // Series folder - always include series description if available
        if (this.settings.useSeriesFolder) {
            const seriesParts: string[] = ['Series'];

            const seriesNum = dataset.string(DicomTags.SeriesNumber);
            const seriesDesc = dataset.string(DicomTags.SeriesDescription);
            const seriesDate = dataset.string(DicomTags.SeriesDate);

            if (this.settings.includeSeriesNumber && seriesNum) seriesParts.push(seriesNum);
            if (seriesDesc) seriesParts.push(seriesDesc); // Always include series description
            if (this.settings.includeSeriesDate && seriesDate) seriesParts.push(seriesDate);

            parts.push(seriesParts.join('-'));
        }

        // Sanitize folder names to be safe for filesystem
        return parts.map(part => part.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')).join('/');
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

            // Get organized folder path
            const basePath = destFolder.path;
            const organizedPath = this.getOrganizedFolderPath(basePath, dicomData);

            // Create all necessary folders
            const folders = organizedPath.split('/');
            let currentPath = '';
            for (const folder of folders) {
                currentPath = currentPath ? `${currentPath}/${folder}` : folder;
                const folderExists = this.app.vault.getAbstractFileByPath(currentPath);
                if (!folderExists) {
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

            new Notice(`Successfully converted ${file.basename} to ${this.settings.imageFormat.toUpperCase()}`);
        } catch (error) {
            if (error instanceof Error) {
                new Notice(`Failed to convert DICOM: ${error.message}`);
            } else {
                new Notice('Failed to convert DICOM: Unknown error');
            }
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

            // Add basic content
            const seriesDesc = dataset.string(DicomTags.SeriesDescription) || 'DICOM Series';
            const studyDate = dataset.string(DicomTags.StudyDate) || 'unknown date';

            content += `# ${seriesDesc}\n\n`;
            content += `This note contains metadata for a DICOM series acquired on ${studyDate}.\n`;

            const folderName = folderPath.split('/').pop() || 'series';
            const notePath = `${folderPath}/${folderName}.md`;

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

            // Ensure destination folder exists, create if it doesn't
            let destFolder = this.app.vault.getAbstractFileByPath(destinationFolderPath);
            if (!destFolder) {
                destFolder = await this.app.vault.createFolder(destinationFolderPath);
            } else if (!(destFolder instanceof TFolder)) {
                throw new Error('Destination path exists but is not a folder');
            }

            // Get all files in the vault
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

            new Notice(`Converting ${folderFiles.length} DICOM files...`);
            let converted = 0;

            for (const file of folderFiles) {
                try {
                    // Create a new TFile with the destination folder
                    const modifiedFile = {
                        ...file,
                        parent: destFolder
                    } as TFile;

                    await this.convertDicomToImage(modifiedFile);
                    converted++;
                } catch (error) {
                    console.error(`Error converting ${file.name}:`, error);
                    if (error instanceof Error) {
                        new Notice(`Error converting ${file.name}: ${error.message}`);
                    }
                }
            }

            new Notice(`Successfully converted ${converted} of ${folderFiles.length} DICOM files to ${destinationFolderPath}`);
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