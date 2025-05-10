import { Plugin, TFile, Notice, TFolder } from 'obsidian';
import { DICOMHandlerSettings, DEFAULT_SETTINGS, DICOMHandlerSettingsTab } from './settings';
import { DICOMService } from './services/dicom-service';
import { FileService } from './services/file-service';
import { ViewerService } from './services/viewer-service';
import { DicomTags } from './models/dicom-tags';
import { DicomModalities } from './models/dicom-modalities';
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

    private formatDateForPath(dicomDate: string, format: string): string {
        if (!dicomDate || !format) return '';

        // DICOM date format: YYYYMMDD
        const year = dicomDate.substring(0, 4);
        const month = dicomDate.substring(4, 6);
        const day = dicomDate.substring(6, 8);

        // Convert month number to names
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const monthAbbrev = monthNames.map(m => m.substring(0, 3));

        // Get day name
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayAbbrev = dayNames.map(d => d.substring(0, 3));

        const placeholders: Record<string, string> = {
            'YYYY': year,
            'YY': year.substring(2),
            'MMMM': monthNames[parseInt(month) - 1],
            'MMM': monthAbbrev[parseInt(month) - 1],
            'MM': month,
            'M': String(parseInt(month)), // Remove leading zero
            'DDDD': dayNames[date.getDay()],
            'DDD': dayAbbrev[date.getDay()],
            'DD': day,
            'D': String(parseInt(day)) // Remove leading zero
        };

        // Sort tokens by length (longest first) to avoid partial replacements
        const tokens = Object.keys(placeholders).sort((a, b) => b.length - a.length);

        let result = format;
        for (const token of tokens) {
            result = result.replace(new RegExp(token, 'g'), placeholders[token]);
        }

        return result;
    }

    private getOrganizedFolderPath(basePath: string, dataset: dicomParser.DataSet): string {
        const parts: string[] = [];

        // Add date-based subdirectories if format is specified
        const studyDate = dataset.string(DicomTags.StudyDate);
        if (studyDate && this.settings.subdirectoryFormat) {
            const datePath = this.formatDateForPath(studyDate, this.settings.subdirectoryFormat);
            if (datePath) {
                parts.push(...datePath.split('/'));
            }
        }

        // Study folder - always included with mandatory components
        const studyParts: string[] = [];

        const modality = dataset.string(DicomTags.Modality);
        const studyDesc = dataset.string(DicomTags.StudyDescription);
        const patientName = dataset.string(DicomTags.PatientName);

        // Always put date first if available
        if (studyDate) studyParts.push(studyDate);

        // Join date and 'Study' with spaced hyphen, then join rest with regular hyphens
        const restOfParts: string[] = ['Study'];
        if (modality) restOfParts.push(modality);
        if (studyDesc) restOfParts.push(studyDesc);

        let studyFolderName = studyDate
            ? `${studyDate} - ${restOfParts.join('-')}`
            : restOfParts.join('-');

        // Add patient name if available
        if (patientName) {
            studyFolderName += `-${this.formatPatientName(patientName)}`;
        }

        parts.push(studyFolderName);

        // Series folder - always included with mandatory components
        const seriesParts: string[] = [];

        const seriesNum = dataset.string(DicomTags.SeriesNumber);
        const seriesDesc = dataset.string(DicomTags.SeriesDescription);

        // Join 'Series' with the rest using hyphens
        const seriesRestOfParts: string[] = ['Series'];
        if (seriesNum) seriesRestOfParts.push(seriesNum);
        if (seriesDesc) seriesRestOfParts.push(seriesDesc);

        const seriesFolderName = seriesRestOfParts.join('-');
        parts.push(seriesFolderName);

        // First sanitize individual folder names
        const sanitizedParts = parts.map(part => part.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_'));

        // Then join with the base path to create the full path
        return path.join(basePath, ...sanitizedParts).replace(/\\/g, '/');
    }

    private sanitizeFileName(fileName: string): string {
        // Remove dots and spaces from the end of the filename
        let sanitized = fileName.replace(/[. ]+$/, '');
        // Replace any other invalid characters
        sanitized = sanitized.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_');
        // Ensure we still have a valid filename
        return sanitized || 'unnamed';
    }

    private async convertDicomToImage(file: TFile, destFolder?: TFolder) {
        try {
            let arrayBuffer;
            if (file.path.startsWith('C:')) {
                // Handle absolute path for temp files
                arrayBuffer = await fs.readFile(file.path);
            } else {
                // Handle vault files
                arrayBuffer = await this.app.vault.readBinary(file);
            }

            const dicomData = this.dicomService.parseDicomData(arrayBuffer);
            const imageData = await this.dicomService.convertToImage(file);

            // Use the parent's path directly, don't reorganize folders here since they're already organized
            const organizedPath = file.parent?.path || '';
            const imagesPath = `${organizedPath}/Images`;

            // Create Images folder if needed
            if (!this.app.vault.getAbstractFileByPath(imagesPath)) {
                await this.app.vault.createFolder(imagesPath);
            }

            // Use simple PNG filename - original name + .png
            const newFileName = `${file.basename}.png`;
            const newPath = `${imagesPath}/${newFileName}`;

            // Convert base64 to binary
            const base64Data = imageData.replace(new RegExp(`^data:image/${this.settings.imageFormat};base64,`), '');
            const binaryData = Buffer.from(base64Data, 'base64');

            // Save the PNG image
            await this.app.vault.createBinary(newPath, binaryData);

            // Archive original DICOM file if enabled
            if (this.settings.archiveDicomFiles) {
                const dicomPath = `${organizedPath}/DICOM`;
                if (!this.app.vault.getAbstractFileByPath(dicomPath)) {
                    await this.app.vault.createFolder(dicomPath);
                }

                // Copy the original DICOM file with original name
                const dicomFilePath = `${dicomPath}/${file.name}`;
                await this.app.vault.createBinary(dicomFilePath, Buffer.from(arrayBuffer));
            }

        } catch (error) {
            if (error instanceof Error) {
                console.error(`Failed to convert DICOM: ${error.message}`);
            } else {
                console.error('Failed to convert DICOM: Unknown error');
            }
            throw error;
        }
    }

    // Helper function to check if a string looks like a name
    private isLikelyName(str: string): boolean {
        // Remove any leading/trailing whitespace
        str = str.trim();

        // Check if string contains at least one letter
        if (!/[a-zA-Z]/.test(str)) {
            return false;
        }

        // Check if string is not just numbers with separators
        if (/^[\d\s.,/-]+$/.test(str)) {
            return false;
        }

        return true;
    }

    private formatPatientName(name: string): string {
        // Check if the name contains the DICOM separator '^'
        if (name.includes('^')) {
            const [lastName, firstName] = name.split('^');
            return `${firstName} ${lastName}`;
        }
        return name;
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

            // Add DICOM metadata as a list after the description
            content += `## DICOM Information\n\n`;

            const patientName = dataset.string(DicomTags.PatientName);
            if (patientName) content += `**Patient Name:** ${this.formatPatientName(patientName)}\n`;
            if (dataset.string(DicomTags.InstitutionName)) content += `**Imaging Site:** ${dataset.string(DicomTags.InstitutionName)}\n`;
            const modality = dataset.string(DicomTags.Modality);
            if (modality) {
                const modalityInfo = DicomModalities[modality];
                const modalityText = modalityInfo
                    ? `${modalityInfo.description}${modalityInfo.isRetired ? ' (Retired)' : ''}`
                    : modality;
                content += `**Imaging Type:** ${modalityText}\n`;
            }
            if (dataset.string(DicomTags.StudyDescription)) content += `**Study Type:** ${dataset.string(DicomTags.StudyDescription)}\n`;
            if (dataset.string(DicomTags.SeriesDescription)) content += `**Series Type:** ${dataset.string(DicomTags.SeriesDescription)}\n`;
            const studyPhysician = dataset.string(DicomTags.StudyPhysician);
            if (studyPhysician && this.isLikelyName(studyPhysician)) {
                content += `**Referring Physician:** ${studyPhysician}\n`;
            }
            content += '\n';

            // Get all image files in the Images subfolder to create gallery
            const imagesPath = `${folderPath}/Images`.replace(/\\/g, '/');
            const imagesFolder = this.app.vault.getAbstractFileByPath(imagesPath);

            if (imagesFolder instanceof TFolder) {
                const imageFiles = imagesFolder.children
                    .filter(file => file instanceof TFile &&
                        (file.extension === 'png' || file.extension === 'jpg' || file.extension === 'jpeg'))
                    .sort((a, b) => a.name.localeCompare(b.name));

                if (imageFiles.length > 0) {
                    content += `## Gallery\n\n`;
                    const imageWidth = this.settings.galleryImageWidth;
                    imageFiles.forEach((file, index) => {
                        // Use simple relative path
                        content += `![[${file.name}|${imageWidth}]]`;
                        if (index < imageFiles.length - 1) {
                            content += ' ';
                        }
                    });
                    content += '\n\n';
                }
            }

            const folderName = folderPath.split('/').pop() || 'series';
            // Always start with the date if available, then use the folder name without any date prefix
            const sanitizedFolderName = folderName.replace(/^\d{8}\s*-\s*/, ''); // Remove any date prefix from folder name
            const notePath = path.join(
                folderPath,
                `${studyDate ? studyDate + ' - ' : ''}${sanitizedFolderName}.md`
            ).replace(/\\/g, '/');

            // Create folder if it doesn't exist
            const parentFolder = this.app.vault.getAbstractFileByPath(folderPath.replace(/\\/g, '/'));
            if (!parentFolder) {
                await this.app.vault.createFolder(folderPath.replace(/\\/g, '/'));
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

            // Validate that OpenJPEG exists
            try {
                await fs.access(this.settings.opjPath);
            } catch {
                throw new Error('OpenJPEG executable not found at specified path');
            }

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

            // Recursively find all DICOM files in source folder and subfolders
            const dicomFiles = await this.findDicomFilesRecursively(sourceFolderPath);

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

            for (const filePath of dicomFiles) {
                try {
                    // Read the file from external folder
                    const fileBuffer = await fs.readFile(filePath);
                    const fileName = path.basename(filePath);

                    // Parse DICOM data
                    const arrayBuffer = new Uint8Array(fileBuffer).buffer;
                    const dicomData = this.dicomService.parseDicomData(arrayBuffer);

                    // Get organized path from root destination folder
                    const organizedPath = this.getOrganizedFolderPath(destinationFolderPath, dicomData).replace(/\\/g, '/');

                    // Create necessary folders
                    if (!this.app.vault.getAbstractFileByPath(organizedPath)) {
                        await this.app.vault.createFolder(organizedPath);
                    }

                    const imagesPath = `${organizedPath}/Images`;
                    if (!this.app.vault.getAbstractFileByPath(imagesPath)) {
                        await this.app.vault.createFolder(imagesPath);
                    }

                    if (this.settings.archiveDicomFiles) {
                        const dicomPath = `${organizedPath}/DICOM`;
                        if (!this.app.vault.getAbstractFileByPath(dicomPath)) {
                            await this.app.vault.createFolder(dicomPath);
                        }
                        // Save DICOM file directly to its final location
                        await this.app.vault.createBinary(
                            `${dicomPath}/${fileName}`,
                            fileBuffer
                        );
                    }

                    // Only create a temporary file if we need to use OpenJPEG
                    const transferSyntax = dicomData.string(DicomTags.TransferSyntaxUID);
                    const needsDecompression = transferSyntax === '1.2.840.10008.1.2.4.90' ||
                        transferSyntax === '1.2.840.10008.1.2.4.91';

                    if (needsDecompression) {
                        // Create temporary file in the DICOM folder if it exists, otherwise in the series folder
                        const tempPath = this.settings.archiveDicomFiles
                            ? `${organizedPath}/DICOM/temp_${fileName}`
                            : `${organizedPath}/temp_${fileName}`;

                        const tempFile = await this.app.vault.createBinary(tempPath, fileBuffer);

                        try {
                            // Convert to PNG
                            const targetPath = `${imagesPath}/${fileName}.png`;
                            await this.dicomService.convertToImage(tempFile as TFile, targetPath);
                        } finally {
                            // Clean up temporary file
                            await this.app.vault.delete(tempFile);
                        }
                    } else {
                        // For non-compressed files, convert directly without temporary file
                        const targetPath = `${imagesPath}/${fileName}.png`;
                        await this.dicomService.convertToImage({
                            path: filePath,
                            name: fileName,
                            basename: path.parse(fileName).name,
                            extension: path.parse(fileName).ext.slice(1),
                            vault: this.app.vault,
                            stat: { mtime: Date.now(), ctime: Date.now(), size: fileBuffer.length }
                        } as TFile, targetPath);
                    }

                    // Store DICOM data for metadata notes
                    const seriesInstanceUID = dicomData.string(DicomTags.SeriesInstanceUID);
                    if (seriesInstanceUID && !seriesMap.has(seriesInstanceUID)) {
                        seriesMap.set(seriesInstanceUID, {
                            dicomData,
                            folderPath: organizedPath
                        });
                    }

                    converted++;

                    // Show progress
                    if (converted % Math.max(10, Math.round(totalFiles / 10)) === 0) {
                        new Notice(`Importing DICOM files... ${converted}/${totalFiles}`);
                    }

                } catch (error) {
                    console.error(`Error importing ${path.basename(filePath)}:`, error);
                    if (error instanceof Error) {
                        new Notice(`Error importing ${path.basename(filePath)}: ${error.message}`);
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

    private async findDicomFilesRecursively(folderPath: string): Promise<string[]> {
        const dicomFiles: string[] = [];
        const entries = await fs.readdir(folderPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(folderPath, entry.name);

            if (entry.isDirectory()) {
                // Recursively search subdirectories
                const subDirFiles = await this.findDicomFilesRecursively(fullPath);
                dicomFiles.push(...subDirFiles);
            } else if (entry.isFile() && this.isDicomFile(entry.name)) {
                dicomFiles.push(fullPath);
            }
        }

        return dicomFiles;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}