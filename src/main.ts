import { Plugin, TFile, Notice, TFolder } from 'obsidian';
import { DICOMHandlerSettings, DEFAULT_SETTINGS, DICOMHandlerSettingsTab } from './settings';
import { DICOMService } from './services/dicom-service';
import { FileService } from './services/file-service';
import { ViewerService } from './services/viewer-service';
import { DicomTags } from './models/dicom-tags';
import { DicomModalities } from './models/dicom-modalities';
import { ImportModal } from './ui/import-modal';
import * as path from 'path';
import * as fs from 'fs/promises';
import dicomParser from 'dicom-parser';
import { HL7Parser } from './utils/hl7-parser';

export default class DICOMHandlerPlugin extends Plugin {
    settings!: DICOMHandlerSettings;
    dicomService!: DICOMService;
    fileService!: FileService;
    viewerService!: ViewerService;

    async onload() {
        await this.loadSettings();

        this.dicomService = new DICOMService(this.app, this.settings);
        this.fileService = new FileService();
        this.viewerService = new ViewerService(this.app, this.dicomService);

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

        // Study folder - use shorter format
        const studyParts: string[] = [];
        const studyDesc = dataset.string(DicomTags.StudyDescription);
        
        // Build study folder name in exact format: "<date> - Study - <description> - <patient>"
        let studyFolderName = '';
        if (studyDate) studyFolderName = studyDate;
        studyFolderName += ' - Study';
        if (studyDesc) studyFolderName += ` - ${this.truncateString(studyDesc, 30)}`;
        
        // Add truncated patient name if available
        const patientName = dataset.string(DicomTags.PatientName);
        if (patientName) {
            studyFolderName += ` - ${this.truncateString(this.formatPatientName(patientName), 20)}`;
        }

        parts.push(studyFolderName);

        // Series folder - format: "<date> - Series - <description>"
        const seriesNum = dataset.string(DicomTags.SeriesNumber);
        const seriesDesc = dataset.string(DicomTags.SeriesDescription);

        // Build series folder name in exact format
        let seriesFolderName = '';
        if (studyDate) seriesFolderName = studyDate;
        seriesFolderName += ' - Series';
        if (seriesDesc) {
            seriesFolderName += ` - ${this.truncateString(seriesDesc, 30)}`;
        } else if (seriesNum) {
            seriesFolderName += ` - ${seriesNum}`;
        }

        parts.push(seriesFolderName);

        // Sanitize and join paths
        const sanitizedParts = parts.map(part => this.sanitizeFileName(part));

        // Add Windows long path prefix if needed
        let fullPath = path.join(basePath, ...sanitizedParts).replace(/\\/g, '/');
        if (fullPath.length > 250 && process.platform === 'win32' && !fullPath.startsWith('\\\\?\\')) {
            fullPath = `\\\\?\\${fullPath}`;
        }

        return fullPath;
    }

    private truncateString(str: string, maxLength: number): string {
        if (!str) return '';
        if (str.length <= maxLength) return str;
        return str.substring(0, maxLength - 3) + '...';
    }

    private sanitizeFileName(fileName: string): string {
        // Remove dots and spaces from the end of the filename
        let sanitized = fileName.replace(/[. ]+$/, '');
        // Replace any other invalid characters
        sanitized = sanitized.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_');
        // Ensure we still have a valid filename
        return sanitized || 'unnamed';
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const parts = folderPath.split('/');
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }

    private async ensureFolderPath(folderPath: string): Promise<void> {
        const normalizedPath = folderPath.replace(/\\/g, '/');
        const parts = normalizedPath.split('/').filter(p => p.length > 0);
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }

    private async convertDicomToImage(file: TFile, destFolder?: TFolder) {
        try {
            let arrayBuffer;
            // Handle file reading more carefully
            if (file.path.startsWith('C:') || file.path.startsWith('/')) {
                // For absolute paths, read directly using fs
                arrayBuffer = await fs.readFile(file.path);
            } else {
                // For vault-relative paths, use vault API
                arrayBuffer = await this.app.vault.readBinary(file);
            }

            const dicomData = this.dicomService.parseDicomData(arrayBuffer);

            // Check if this is a Structured Report
            const sopClassUID = dicomData.string(DicomTags.SOPClassUID);
            const isStructuredReport = sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' || // Basic Text SR
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' || // Enhanced SR
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';  // Comprehensive SR

            // Use parent path if available, or destFolder path if provided
            const basePath = destFolder ? destFolder.path : (file.parent?.path || '');

            if (isStructuredReport) {
                // For SR documents, create the metadata note directly
                const studyDate = dicomData.string(DicomTags.StudyDate);
                const organizedPath = this.getOrganizedFolderPath(basePath, dicomData);
                await this.ensureFolder(organizedPath);
                await this.createMetadataNote(dicomData, organizedPath);

                // Archive original DICOM file if enabled
                if (this.settings.archiveDicomFiles) {
                    const dicomPath = path.join(organizedPath, 'DICOM').replace(/\\/g, '/');
                    await this.ensureFolder(dicomPath);
                    const dicomFilePath = path.join(dicomPath, file.name).replace(/\\/g, '/');
                    await this.app.vault.createBinary(dicomFilePath, Buffer.from(arrayBuffer));
                }
                return;
            }

            // Handle regular image-containing DICOM files
            const imageData = await this.dicomService.convertToImage(file);

            const imagesPath = path.join(basePath, 'Images').replace(/\\/g, '/');

            // Ensure the Images folder and all parent folders exist
            await this.ensureFolder(imagesPath);

            // Use simple PNG filename - original name + .png
            const newFileName = `${file.basename}.png`;
            const newPath = path.join(imagesPath, newFileName).replace(/\\/g, '/');

            // Convert base64 to binary
            const base64Data = imageData.replace(new RegExp(`^data:image/${this.settings.imageFormat};base64,`), '');
            const binaryData = Buffer.from(base64Data, 'base64');

            // Save the PNG image
            await this.app.vault.createBinary(newPath, binaryData);

            // Archive original DICOM file if enabled
            if (this.settings.archiveDicomFiles) {
                const dicomPath = path.join(basePath, 'DICOM').replace(/\\/g, '/');
                await this.ensureFolder(dicomPath);

                // Copy the original DICOM file with original name
                const dicomFilePath = path.join(dicomPath, file.name).replace(/\\/g, '/');
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
        // Convert to Title Case and handle the DICOM separator '^'
        if (name.includes('^')) {
            const [lastName, firstName] = name.split('^');
            return `${this.toTitleCase(firstName)} ${this.toTitleCase(lastName)}`;
        }
        return this.toTitleCase(name);
    }

    private formatName(name: string): string {
        // Convert to Title Case and handle the DICOM separator '^'
        if (name.includes('^')) {
            const [lastName, firstName] = name.split('^');
            return `${this.toTitleCase(firstName)} ${this.toTitleCase(lastName)}`;
        }
        return this.toTitleCase(name);
    }

    private toTitleCase(str: string): string {
        // Handle empty or null strings
        if (!str) return '';

        // Split on word boundaries including spaces, hyphens, and other separators
        return str.toLowerCase().split(/[\s-]+/).map(word => {
            // Skip certain words that should remain lowercase
            const lowerCaseWords = ['and', 'or', 'the', 'in', 'on', 'at', 'to', 'for', 'of'];
            if (lowerCaseWords.includes(word.toLowerCase())) {
                return word.toLowerCase();
            }
            // Capitalize first letter, rest lowercase
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }).join(' ');
    }

    private async createMetadataNote(dataset: dicomParser.DataSet, folderPath: string) {
        try {
            // Check if this is a Structured Report
            const sopClassUID = dataset.string(DicomTags.SOPClassUID);
            const isStructuredReport = sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' || // Basic Text SR
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' || // Enhanced SR
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';  // Comprehensive SR

            const elements = dataset.elements;
            const metadata: Record<string, any> = {};

            // Define tags to skip (binary data, pixel data, and large elements)
            const tagsToSkip = new Set([
                DicomTags.PixelData,                   // Skip pixel data
                'x7fe00010',                          // Alternative pixel data tag
                'x00880200',                          // Icon Image Sequence
                'x00880904',                          // Topic Title
                'x00880906',                          // Topic Subject
                'x00880910',                          // Topic Author
                'x00880912',                          // Topic Keywords
            ]);

            // Process all DICOM elements
            for (const tag in elements) {
                try {
                    // Skip known binary/large data tags
                    if (tagsToSkip.has(tag)) {
                        continue;
                    }

                    const element = elements[tag];
                    if (element) {
                        // Skip elements that are too large (likely binary data)
                        if (element.length > 128) {
                            continue;
                        }

                        let value;
                        if (element.vr === 'DS' || element.vr === 'FL' || element.vr === 'FD') {
                            value = dataset.floatString(tag);
                            // Handle NaN values
                            if (typeof value === 'number' && isNaN(value)) {
                                continue;
                            }
                        } else if (element.vr === 'IS' || element.vr === 'SL' || element.vr === 'SS' || element.vr === 'UL' || element.vr === 'US') {
                            value = dataset.uint16(tag);
                        } else if (element.vr === 'OB' || element.vr === 'OW' || element.vr === 'UN') {
                            // Skip binary data value representations
                            continue;
                        } else {
                            value = dataset.string(tag);
                            // Skip values that look like binary data
                            if (this.looksLikeBinaryData(value)) {
                                continue;
                            }
                        }

                        if (value !== undefined && value !== null && value !== '') {
                            // Special handling for tag 0023,2080 which contains HL7 structured data
                            if (tag === 'x00232080') {
                                try {
                                    const stringValue = String(value);  // Convert to string explicitly
                                    const segments = HL7Parser.parseHL7(stringValue);
                                    const formattedReport = HL7Parser.formatReport(segments);
                                    if (formattedReport) {
                                        metadata['__structuredContent'] = formattedReport;
                                    }
                                    // Skip adding raw HL7 to metadata
                                    continue;
                                } catch (e) {
                                    console.error('Failed to parse HL7 content:', e);
                                    // If HL7 parsing fails, fall back to regular handling
                                }
                            }

                            // Regular metadata handling
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
                if (value === undefined || value === null || key === '__structuredContent') continue;

                if (Array.isArray(value)) {
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

            // Add DICOM metadata first for all document types
            content += `## DICOM Information\n\n`;

            const patientName = dataset.string(DicomTags.PatientName);
            if (patientName) content += `**Patient Name:** ${this.formatName(patientName)}\n`;
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
                content += `**Referring Physician:** ${this.formatName(studyPhysician)}\n`;
            }

            // For Structured Reports, add completion and verification status
            if (isStructuredReport) {
                const completionFlag = dataset.string(DicomTags.CompletionFlag);
                const verificationFlag = dataset.string(DicomTags.VerificationFlag);
                if (completionFlag) content += `**Report Status:** ${completionFlag}\n`;
                if (verificationFlag) content += `**Verification Status:** ${verificationFlag}\n`;
            }
            content += '\n';

            // If this is a Structured Report, add the report text next
            if (isStructuredReport) {
                content += `## Report Content\n\n`;

                // First check if we have structured content from tag 0023,2080
                if (metadata['__structuredContent']) {
                    content += metadata['__structuredContent'] + '\n\n';
                } else {
                    // Fall back to regular SR content handling
                    const reportText = dataset.string(DicomTags.DocumentContent) ||
                        dataset.string(DicomTags.TextValue) ||
                        dataset.string(DicomTags.DocumentTitle) ||
                        dataset.string(DicomTags.ProcedureDescription);

                    if (reportText) {
                        content += reportText.replace(/\\n/g, '\n') + '\n\n';
                    }
                }
            }

            // Only add animation and gallery sections for non-SR documents
            if (!isStructuredReport) {
                // Check for animation GIF in the series folder
                const seriesName = folderPath.split('/').pop() || 'series';
                const gifPath = path.join(folderPath, `${seriesName}.gif`).replace(/\\/g, '/');
                const gifFile = this.app.vault.getAbstractFileByPath(gifPath);

                // Add animation section if GIF exists
                if (gifFile instanceof TFile) {
                    content += `## Animation\n\n`;
                    content += `![[${gifFile.name}]]\n\n`;
                }

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

    async convertFolder(sourceFolderPath: string, destinationFolderPath: string,
        onProgress?: (progress: { percentage: number, message: string }) => void) {
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

            // Ensure destination folder exists
            await this.ensureFolderPath(destinationFolderPath);

            onProgress?.({ percentage: 10, message: 'Scanning for DICOM files...' });

            // Recursively find all DICOM files in source folder and subfolders
            const dicomFiles = await this.findDicomFilesRecursively(sourceFolderPath);

            if (dicomFiles.length === 0) {
                const methodDesc = this.settings.dicomIdentification === 'extension'
                    ? `files with .${this.settings.dicomExtension} extension`
                    : 'files without extension';
                throw new Error(`No DICOM files found (looking for ${methodDesc})`);
            }

            let converted = 0;
            const totalFiles = dicomFiles.length;

            // Track series by their SeriesInstanceUID
            const seriesMap = new Map<string, {
                dicomData: dicomParser.DataSet,
                folderPath: string,
                isReport: boolean
            }>();

            onProgress?.({ percentage: 20, message: `Found ${totalFiles} DICOM files to import` });

            for (const filePath of dicomFiles) {
                try {
                    // Read the file from external folder
                    const fileBuffer = await fs.readFile(filePath);
                    const fileName = path.basename(filePath);

                    // Parse DICOM data
                    const arrayBuffer = new Uint8Array(fileBuffer).buffer;
                    const dicomData = this.dicomService.parseDicomData(arrayBuffer);

                    // Check if this is a Structured Report
                    const sopClassUID = dicomData.string(DicomTags.SOPClassUID);
                    const isStructuredReport = sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' || // Basic Text SR
                        sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' || // Enhanced SR
                        sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';  // Comprehensive SR

                    // Get organized path from root destination folder
                    const organizedPath = this.getOrganizedFolderPath(destinationFolderPath, dicomData).replace(/\\/g, '/');

                    if (!isStructuredReport) {
                        // For image files, create Images folder and attempt conversion
                        const imagesPath = `${organizedPath}/Images`;
                        await this.ensureFolderPath(imagesPath);

                        // Remove the original extension (if any) before adding .png
                        const baseFileName = path.parse(fileName).name;
                        const targetPath = `${imagesPath}/${baseFileName}.png`;
                        await this.dicomService.convertToImage({
                            path: filePath,
                            name: fileName,
                            basename: path.parse(fileName).name,
                            extension: path.parse(fileName).ext.slice(1),
                            parent: null,
                            vault: this.app.vault,
                            stat: { mtime: Date.now(), ctime: Date.now(), size: fileBuffer.length }
                        } as TFile, targetPath);
                    }

                    // Archive original DICOM file if enabled (for both images and reports)
                    if (this.settings.archiveDicomFiles) {
                        const dicomPath = `${organizedPath}/DICOM`;
                        await this.ensureFolderPath(dicomPath);
                        // Use normalized filename for DICOM archive
                        const normalizedNumber = this.dicomService.normalizeFileName(fileName);
                        const archivedDicomName = `${normalizedNumber}${path.extname(fileName)}`;
                        await this.app.vault.createBinary(
                            `${dicomPath}/${archivedDicomName}`,
                            fileBuffer
                        );
                    }

                    // Store DICOM data for metadata notes
                    const seriesInstanceUID = dicomData.string(DicomTags.SeriesInstanceUID);
                    if (seriesInstanceUID && !seriesMap.has(seriesInstanceUID)) {
                        seriesMap.set(seriesInstanceUID, {
                            dicomData,
                            folderPath: organizedPath,
                            isReport: isStructuredReport
                        });
                    }

                    converted++;

                    // Update progress
                    const percentage = Math.min(90, 20 + Math.round((converted / totalFiles) * 70));
                    onProgress?.({
                        percentage,
                        message: `Processing file ${converted} of ${totalFiles}: ${path.basename(filePath)}`
                    });

                } catch (error) {
                    console.error(`Error importing ${path.basename(filePath)}:`, error);
                    throw error;
                }
            }

            onProgress?.({ percentage: 90, message: 'Creating animated GIFs...' });

            // Create animated GIFs for each series before creating metadata notes
            for (const { folderPath, isReport } of seriesMap.values()) {
                if (!isReport) {
                    // Get the series name from the folder path for the GIF name
                    const seriesFolder = folderPath.split('/').pop() || 'series';
                    const gifPath = `${folderPath}/${seriesFolder}.gif`;
                    const imagesPath = `${folderPath}/Images`;
                    try {
                        await this.dicomService.createAnimatedGif(imagesPath, gifPath);
                    } catch (error) {
                        console.error(`Failed to create GIF for series ${seriesFolder}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                        // Continue with other series rather than failing the whole process
                    }
                }
            }

            onProgress?.({ percentage: 95, message: 'Creating metadata notes...' });

            // Create metadata notes for each series after all files are converted
            for (const { dicomData, folderPath, isReport } of seriesMap.values()) {
                await this.createMetadataNote(dicomData, folderPath);
            }

            onProgress?.({ percentage: 100, message: `Successfully imported ${converted} of ${totalFiles} DICOM files` });

        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error importing files: ${error.message}`);
            } else {
                throw new Error('Error importing files');
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

    private looksLikeBinaryData(str: string | undefined): boolean {
        if (!str) return false;

        // Check for high percentage of non-printable characters
        let nonPrintable = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            // Count characters outside normal printable range
            if (code < 32 || (code > 126 && code < 160)) {
                nonPrintable++;
            }
        }

        // If more than 15% of characters are non-printable, consider it binary
        if (nonPrintable / str.length > 0.15) {
            return true;
        }

        // Check for very long strings without spaces (likely compressed/binary data)
        if (str.length > 100 && !str.includes(' ')) {
            return true;
        }

        return false;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}