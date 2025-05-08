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
                if (!this.settings.sourceFolderPath) {
                    new Notice('Please configure the source folder in settings');
                    return;
                }
                if (!this.settings.destinationFolderPath) {
                    new Notice('Please configure the destination folder in settings');
                    return;
                }
                await this.convertFolder(
                    this.settings.sourceFolderPath,
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

            // Get series number and study date for filename
            const seriesNumber = dicomData.string(DicomTags.SeriesNumber) || '0';
            const studyDate = dicomData.string(DicomTags.StudyDate) || '';

            // Format the filename components
            const paddedSeriesNum = seriesNumber.padStart(3, '0');
            const formattedDate = studyDate ? studyDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1$2$3') : '';

            // Get the original filename without extension
            const originalName = file.basename;

            // Create filename: date-series-originalname
            const newFileName = formattedDate
                ? `${formattedDate}-S${paddedSeriesNum}-${originalName}.${this.settings.imageFormat}`
                : `S${paddedSeriesNum}-${originalName}.${this.settings.imageFormat}`;

            const newPath = `${organizedPath}/${newFileName}`;

            // Convert base64 to binary
            const base64Data = imageData.replace(new RegExp(`^data:image/${this.settings.imageFormat};base64,`), '');
            const binaryData = Buffer.from(base64Data, 'base64');

            await this.app.vault.createBinary(newPath, binaryData);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`Failed to convert DICOM: ${error.message}`);
            } else {
                console.error('Failed to convert DICOM: Unknown error');
            }
            throw error;
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
            content += `This note contains metadata for a DICOM series${studyDate ? ` acquired on ${studyDate}` : ''}.\n\n`;

            // Add horizontal rule before gallery
            content += `---\n\n`;

            // Get all image files in the folder to create gallery
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (folder instanceof TFolder) {
                const imageFiles = folder.children
                    .filter(file => file instanceof TFile &&
                        (file.extension === 'png' || file.extension === 'jpg' || file.extension === 'jpeg'))
                    .sort((a, b) => a.name.localeCompare(b.name));

                if (imageFiles.length > 0) {
                    content += `## Gallery\n\n`;
                    const imageWidth = this.settings.galleryImageWidth;
                    imageFiles.forEach((file, index) => {
                        content += `![[${file.name}|${imageWidth}]]`;
                        if (index < imageFiles.length - 1) {
                            content += ' ';
                        }
                    });
                    content += '\n\n';
                }
            }

            const folderName = folderPath.split('/').pop() || 'series';
            const notePath = path.join(folderPath, `${studyDate ? studyDate + ' - ' : ''}${folderName}.md`).replace(/\\/g, '/');

            // Create folder if it doesn't exist
            const parentFolder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!parentFolder) {
                await this.app.vault.createFolder(folderPath);
            }

            // Use vault.create instead of fs.writeFile
            await this.app.vault.create(notePath, content);
        } catch (error) {
            console.error('Error creating metadata note:', error);
            throw error;
        }
    }

    async convertFolder(sourceFolderPath: string, destinationFolderPath: string) {
        try {
            // Validate OpenJPEG settings
            if (!this.settings.opjPath) {
                throw new Error('Please configure the OpenJPEG path in settings');
            }

            if (!this.settings.tempDirectory) {
                throw new Error('Please configure the temporary directory in settings');
            }

            // Validate that OpenJPEG exists
            try {
                await fs.access(this.settings.opjPath);
            } catch {
                throw new Error('OpenJPEG executable not found at specified path');
            }

            // Create temporary directory if it doesn't exist
            await fs.mkdir(this.settings.tempDirectory, { recursive: true });

            // Check if source folder exists (external folder)
            try {
                await fs.access(sourceFolderPath);
            } catch {
                throw new Error('Source folder not found or not accessible');
            }

            // Get destination folder from vault
            const destFolder = this.app.vault.getAbstractFileByPath(destinationFolderPath);
            if (!destFolder || !(destFolder instanceof TFolder)) {
                // Create destination folder if it doesn't exist
                await this.app.vault.createFolder(destinationFolderPath);
            }

            // Read all files from external source directory
            const files = await fs.readdir(sourceFolderPath);
            const dicomFiles = files.filter(file => this.isDicomFile(file));

            if (dicomFiles.length === 0) {
                const methodDesc = this.settings.dicomIdentification === 'extension'
                    ? `files with .${this.settings.dicomExtension} extension`
                    : 'files without extension';
                new Notice(`No DICOM files found (looking for ${methodDesc})`);
                return;
            }

            let converted = 0;
            const totalFiles = dicomFiles.length;

            // Track series by their SeriesInstanceUID
            const seriesMap = new Map<string, {
                dicomData: dicomParser.DataSet,
                folderPath: string
            }>();

            // Show initial notice
            new Notice(`Starting import of ${totalFiles} DICOM files...`);

            for (const fileName of dicomFiles) {
                try {
                    // Read the file from external folder
                    const filePath = path.join(sourceFolderPath, fileName);
                    const fileBuffer = await fs.readFile(filePath);

                    // Create a temporary TFile-like object
                    const tempFile = {
                        path: fileName,
                        name: fileName,
                        basename: path.parse(fileName).name,
                        extension: path.parse(fileName).ext.slice(1),
                        vault: this.app.vault,
                        parent: this.app.vault.getAbstractFileByPath(destinationFolderPath) as TFolder
                    } as TFile;

                    // Parse DICOM data
                    const arrayBuffer = new Uint8Array(fileBuffer).buffer;
                    const dicomData = this.dicomService.parseDicomData(arrayBuffer);
                    const organizedPath = this.getOrganizedFolderPath(destinationFolderPath, dicomData);

                    // Store DICOM data for each unique series
                    const seriesInstanceUID = dicomData.string(DicomTags.SeriesInstanceUID);
                    if (seriesInstanceUID && !seriesMap.has(seriesInstanceUID)) {
                        seriesMap.set(seriesInstanceUID, {
                            dicomData,
                            folderPath: organizedPath
                        });
                    }

                    // Create a new temporary file in the vault's memory
                    const vaultFile = await this.app.vault.createBinary(
                        path.join(destinationFolderPath, fileName),
                        fileBuffer
                    );

                    // Convert the image
                    await this.convertDicomToImage(vaultFile as TFile);

                    // Clean up temporary vault file
                    await this.app.vault.delete(vaultFile);

                    converted++;

                    // Show progress every 10% or at least every 10 files
                    if (converted % Math.max(10, Math.round(totalFiles / 10)) === 0) {
                        new Notice(`Importing DICOM files... ${converted}/${totalFiles}`);
                    }

                } catch (error) {
                    console.error(`Error importing ${fileName}:`, error);
                    if (error instanceof Error) {
                        new Notice(`Error importing ${fileName}: ${error.message}`);
                    }
                }
            }

            // Create metadata notes for each series after all files are converted
            for (const { dicomData, folderPath } of seriesMap.values()) {
                await this.createMetadataNote(dicomData, folderPath);
            }

            new Notice(`Successfully imported ${converted} of ${totalFiles} DICOM files to ${destinationFolderPath}`);

        } catch (error) {
            if (error instanceof Error) {
                new Notice(`Error accessing folders: ${error.message}`);
            } else {
                new Notice('Error accessing folders');
            }
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

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}