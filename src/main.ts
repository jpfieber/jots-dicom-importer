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
import { PathService } from './services/path-service';

export default class DICOMHandlerPlugin extends Plugin {
    settings!: DICOMHandlerSettings;
    dicomService!: DICOMService;
    fileService!: FileService;
    viewerService!: ViewerService;

    private pathCache: Map<string, {
        normalized: string,
        folderExists: boolean,
        timestamp: number
    }> = new Map();
    private readonly CACHE_TTL = 1000 * 60 * 30; // 30 minutes TTL

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

        const studyDate = dataset.string(DicomTags.StudyDate);
        if (studyDate && this.settings.subdirectoryFormat) {
            const datePath = this.formatDateForPath(studyDate, this.settings.subdirectoryFormat);
            if (datePath) {
                parts.push(...datePath.split('/'));
            }
        }

        // Study folder
        let studyFolderName = studyDate ? studyDate : '';
        studyFolderName += ' - Study';
        if (dataset.string(DicomTags.StudyDescription)) {
            studyFolderName += ` - ${this.truncateString(dataset.string(DicomTags.StudyDescription), 30)}`;
        }
        const patientName = dataset.string(DicomTags.PatientName);
        if (patientName) {
            studyFolderName += ` - ${this.truncateString(this.formatPatientName(patientName), 20)}`;
        }
        parts.push(studyFolderName);

        // Series folder
        let seriesFolderName = studyDate ? studyDate : '';
        seriesFolderName += ' - Series';
        const seriesDesc = dataset.string(DicomTags.SeriesDescription);
        const seriesNum = dataset.string(DicomTags.SeriesNumber);
        if (seriesDesc) {
            seriesFolderName += ` - ${this.truncateString(seriesDesc, 30)}`;
        } else if (seriesNum) {
            seriesFolderName += ` - ${seriesNum}`;
        }
        parts.push(seriesFolderName);

        // Sanitize and join paths
        const sanitizedParts = parts.map(part => PathService.sanitizeFileName(part));
        const fullPath = PathService.joinPath(basePath, ...sanitizedParts);

        return PathService.normalizePath(fullPath, true);
    }

    private truncateString(str: string | undefined, maxLength: number): string {
        if (!str) return '';
        if (str.length <= maxLength) return str;
        return str.substring(0, maxLength - 3) + '...';
    }

    private static readonly INVALID_CHARS_REGEX = /[<>:"\/\\|?*\x00-\x1F]/g;
    private static readonly TRAILING_DOTS_SPACES_REGEX = /[. ]+$/;

    private sanitizeFileName(fileName: string): string {
        // Remove dots and spaces from the end of the filename
        let sanitized = fileName.replace(DICOMHandlerPlugin.TRAILING_DOTS_SPACES_REGEX, '');
        // Replace any other invalid characters
        sanitized = sanitized.replace(DICOMHandlerPlugin.INVALID_CHARS_REGEX, '_');
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

    private normalizePath(path: string): string {
        const now = Date.now();
        const cached = this.pathCache.get(path);

        if (cached) {
            if (now - cached.timestamp < this.CACHE_TTL) {
                return cached.normalized;
            }
            // Cache expired, remove it
            this.pathCache.delete(path);
        }

        const normalized = path.replace(/\\/g, '/');
        this.pathCache.set(path, {
            normalized,
            folderExists: false,
            timestamp: now
        });
        return normalized;
    }

    private async ensureFolderPath(folderPath: string): Promise<void> {
        const now = Date.now();
        const normalizedPath = this.normalizePath(folderPath);
        const cached = this.pathCache.get(folderPath);

        if (cached?.folderExists && now - cached.timestamp < this.CACHE_TTL) {
            return;
        }

        const parts = normalizedPath.split('/').filter(p => p.length > 0);
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const cacheEntry = this.pathCache.get(currentPath);

            if (!cacheEntry?.folderExists || now - cacheEntry.timestamp >= this.CACHE_TTL) {
                const folder = this.app.vault.getAbstractFileByPath(currentPath);
                if (!folder) {
                    await this.app.vault.createFolder(currentPath);
                }
                this.pathCache.set(currentPath, {
                    normalized: this.normalizePath(currentPath),
                    folderExists: true,
                    timestamp: now
                });
            }
        }
    }

    // Cache cleanup method
    private cleanupCache(): void {
        const now = Date.now();
        for (const [path, entry] of this.pathCache.entries()) {
            if (now - entry.timestamp >= this.CACHE_TTL) {
                this.pathCache.delete(path);
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

                // Check if metadata note already exists
                const folderName = organizedPath.split('/').pop() || 'series';
                const sanitizedFolderName = folderName.replace(/^\d{8}\s*-\s*/, '');
                const notePath = path.join(
                    organizedPath,
                    `${studyDate ? studyDate + ' - ' : ''}${sanitizedFolderName}.md`
                ).replace(/\\/g, '/');

                const noteExists = await this.app.vault.adapter.exists(notePath);
                if (!noteExists) {
                    await this.createMetadataNote(dicomData, organizedPath);
                }

                // Archive original DICOM file if enabled
                if (this.settings.archiveDicomFiles) {
                    const dicomPath = path.join(organizedPath, 'DICOM').replace(/\\/g, '/');
                    await this.ensureFolder(dicomPath);
                    const dicomFilePath = path.join(dicomPath, file.name).replace(/\\/g, '/');

                    // Check if DICOM file already exists
                    const dicomExists = await this.app.vault.adapter.exists(dicomFilePath);
                    if (!dicomExists) {
                        await this.app.vault.createBinary(dicomFilePath, Buffer.from(arrayBuffer));
                    }
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

            // Check if image already exists
            const imageExists = await this.app.vault.adapter.exists(newPath);
            if (!imageExists) {
                // Convert base64 to binary
                const base64Data = imageData.replace(new RegExp(`^data:image/${this.settings.imageFormat};base64,`), '');
                const binaryData = Buffer.from(base64Data, 'base64');

                // Save the PNG image
                await this.app.vault.createBinary(newPath, binaryData);
            }

            // Archive original DICOM file if enabled
            if (this.settings.archiveDicomFiles) {
                const dicomPath = path.join(basePath, 'DICOM').replace(/\\/g, '/');

                await this.ensureFolder(dicomPath);

                // Copy the original DICOM file with original name
                const dicomFilePath = path.join(dicomPath, file.name).replace(/\\/g, '/');

                // Check if DICOM file already exists
                const dicomExists = await this.app.vault.adapter.exists(dicomFilePath);
                if (!dicomExists) {
                    await this.app.vault.createBinary(dicomFilePath, Buffer.from(arrayBuffer));
                }
            }

        } catch (error) {
            if (error instanceof Error && !(error.message.includes('already exists'))) {
                console.error(`Failed to convert DICOM: ${error.message}`);
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

    private async createStudyMetadataNote(studyInstanceUID: string, studyData: {
        dicomData: dicomParser.DataSet,
        seriesPaths: string[]
    }): Promise<void> {
        try {
            const dicomData = studyData.dicomData;
            const seriesPaths = studyData.seriesPaths;

            // Get study folder path from first series path
            const studyPath = path.dirname(seriesPaths[0]);

            // Create YAML frontmatter
            let content = '---\n';
            content += `study_instance_uid: "${studyInstanceUID}"\n`;
            if (dicomData.string(DicomTags.StudyDate)) content += `study_date: "${dicomData.string(DicomTags.StudyDate)}"\n`;
            if (dicomData.string(DicomTags.StudyDescription)) content += `study_description: "${dicomData.string(DicomTags.StudyDescription)}"\n`;
            const patientNameStr = dicomData.string(DicomTags.PatientName);
            if (patientNameStr) content += `patient_name: "${this.formatName(patientNameStr)}"\n`;
            if (dicomData.string(DicomTags.PatientID)) content += `patient_id: "${dicomData.string(DicomTags.PatientID)}"\n`;
            if (dicomData.string(DicomTags.AccessionNumber)) content += `accession_number: "${dicomData.string(DicomTags.AccessionNumber)}"\n`;
            content += '---\n\n';

            // Add title
            const studyDate = dicomData.string(DicomTags.StudyDate) || '';
            const studyDesc = dicomData.string(DicomTags.StudyDescription) || 'Study';
            content += `# ${studyDate} - ${studyDesc}\n\n`;

            // Add patient information section
            content += '## Patient Information\n\n';
            const patientName = dicomData.string(DicomTags.PatientName);
            if (patientName) content += `**Patient Name:** ${this.formatName(patientName)}\n`;
            if (dicomData.string(DicomTags.InstitutionName)) content += `**Imaging Site:** ${dicomData.string(DicomTags.InstitutionName)}\n`;
            const studyPhysician = dicomData.string(DicomTags.StudyPhysician);
            if (studyPhysician && this.isLikelyName(studyPhysician)) {
                content += `**Study Physician:** ${this.formatName(studyPhysician)}\n`;
            }
            content += '\n';

            // Add series list section with links
            content += '## Series\n\n';
            for (const seriesPath of seriesPaths) {
                // Get the series markdown file
                const seriesFiles = (await this.app.vault.adapter.list(seriesPath))
                    .files.filter(f => f.endsWith('.md'));

                for (const seriesFile of seriesFiles) {
                    // Get relative path for the link
                    const relPath = path.relative(studyPath, seriesFile).replace(/\\/g, '/');
                    // Add link to the series note
                    content += `- [[${relPath}|${path.basename(seriesFile, '.md')}]]\n`;
                }
            }

            // Create the study markdown file
            const studyFileName = `${studyDate} - Study.md`;
            const studyFilePath = path.join(studyPath, studyFileName).replace(/\\/g, '/');
            await this.app.vault.create(studyFilePath, content);

        } catch (error) {
            console.error('Error creating study metadata note:', error);
            throw error;
        }
    }

    async convertFolder(sourceFolderPath: string, destinationFolderPath: string,
        onProgress?: (progress: { percentage: number, message: string }) => void) {
        try {
            await this.validateSettings();
            const dicomFiles = await this.findDicomFilesRecursively(sourceFolderPath);

            if (dicomFiles.length === 0) {
                throw new Error('No DICOM files found');
            }

            onProgress?.({ percentage: 20, message: `Found ${dicomFiles.length} DICOM files to import` });

            // Read all files first
            const fileBuffers = await Promise.all(dicomFiles.map(async path => ({
                path,
                buffer: await fs.readFile(path)
            })));

            // Process in batches of 10 files
            const batchSize = 10;
            for (let i = 0; i < fileBuffers.length; i += batchSize) {
                const batch = fileBuffers.slice(i, i + batchSize);
                await this.processBatch(batch, destinationFolderPath, onProgress);
            }

            onProgress?.({ percentage: 100, message: 'Import complete' });
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error importing files: ${error.message}`);
            }
            throw new Error('Error importing files');
        }
    }

    private async processBatch(
        files: { path: string, buffer: Buffer }[],
        destinationPath: string,
        onProgress?: (progress: { percentage: number, message: string }) => void
    ): Promise<void> {
        const batchResults = new Map<string, {
            dicomData: dicomParser.DataSet,
            isNew: boolean,
            targetPath: string
        }>();

        // First pass - analyze all files in batch
        for (const file of files) {
            const arrayBuffer = new Uint8Array(file.buffer).buffer;
            const dicomData = this.dicomService.parseDicomData(arrayBuffer);
            const organizedPath = this.getOrganizedFolderPath(destinationPath, dicomData);

            const seriesUID = dicomData.string(DicomTags.SeriesInstanceUID);
            if (!seriesUID) continue;

            const seriesExists = await this.app.vault.adapter.exists(
                PathService.joinPath(organizedPath, 'metadata.md')
            );

            batchResults.set(file.path, {
                dicomData,
                isNew: !seriesExists,
                targetPath: organizedPath
            });
        }

        // Process files by series and track studies
        const seriesGroups = new Map<string, {
            files: { path: string, buffer: Buffer }[],
            targetPath: string,
            dicomData: dicomParser.DataSet
        }>();

        const studyGroups = new Map<string, {
            dicomData: dicomParser.DataSet,
            seriesPaths: string[]
        }>();

        for (const [filePath, result] of batchResults.entries()) {
            if (!result.isNew) continue;

            const seriesUID = result.dicomData.string(DicomTags.SeriesInstanceUID);
            const studyUID = result.dicomData.string(DicomTags.StudyInstanceUID);
            if (!seriesUID || !studyUID) continue;

            const fileInfo = files.find(f => f.path === filePath);
            if (!fileInfo) continue;

            // Track series
            if (!seriesGroups.has(seriesUID)) {
                seriesGroups.set(seriesUID, {
                    files: [],
                    targetPath: result.targetPath,
                    dicomData: result.dicomData
                });
            }
            seriesGroups.get(seriesUID)?.files.push(fileInfo);

            // Track study
            if (!studyGroups.has(studyUID)) {
                studyGroups.set(studyUID, {
                    dicomData: result.dicomData,
                    seriesPaths: []
                });
            }
            if (!studyGroups.get(studyUID)?.seriesPaths.includes(result.targetPath)) {
                studyGroups.get(studyUID)?.seriesPaths.push(result.targetPath);
            }
        }

        // Process each series
        let processedSeries = 0;
        for (const [seriesUID, group] of seriesGroups) {
            await this.ensureFolderPath(group.targetPath);

            // Process images in parallel
            if (!this.isStructuredReport(group.dicomData)) {
                const imagesPath = PathService.joinPath(group.targetPath, 'Images');
                await this.ensureFolderPath(imagesPath);

                await Promise.all(group.files.map(async file => {
                    const fileName = path.basename(file.path);
                    const baseFileName = path.parse(fileName).name;
                    const targetPath = PathService.joinPath(imagesPath, `${baseFileName}.png`);

                    await this.dicomService.convertToImage({
                        path: file.path,
                        name: fileName,
                        basename: baseFileName,
                        extension: path.parse(fileName).ext.slice(1),
                        parent: null,
                        vault: this.app.vault,
                        stat: { mtime: Date.now(), ctime: Date.now(), size: file.buffer.length }
                    } as TFile, targetPath);
                }));

                // Create animated GIF if enabled
                if (this.settings.createAnimatedGif) {
                    const seriesName = group.targetPath.split('/').pop() || 'series';
                    const gifPath = PathService.joinPath(group.targetPath, `${seriesName}.gif`);
                    await this.dicomService.createAnimatedGif(imagesPath, gifPath);
                }
            }

            // Create metadata note
            await this.createMetadataNote(group.dicomData, group.targetPath);

            // Archive original files if enabled
            if (this.settings.archiveDicomFiles) {
                const dicomPath = PathService.joinPath(group.targetPath, 'DICOM');
                await this.ensureFolderPath(dicomPath);

                await Promise.all(group.files.map(async file => {
                    const normalizedNumber = this.dicomService.normalizeFileName(path.basename(file.path));
                    const archivedName = `${normalizedNumber}${path.extname(file.path)}`;
                    const targetPath = PathService.joinPath(dicomPath, archivedName);
                    await this.app.vault.createBinary(targetPath, file.buffer);
                }));
            }

            processedSeries++;
            onProgress?.({
                percentage: Math.min(90, 20 + Math.round((processedSeries / seriesGroups.size) * 70)),
                message: `Processing series ${processedSeries} of ${seriesGroups.size}`
            });
        }

        // Create study metadata notes after all series are processed
        for (const [studyUID, studyData] of studyGroups) {
            await this.createStudyMetadataNote(studyUID, studyData);
        }
    }

    private isStructuredReport(dicomData: dicomParser.DataSet): boolean {
        const sopClassUID = dicomData.string(DicomTags.SOPClassUID);
        return sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' || // Basic Text SR
            sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' || // Enhanced SR
            sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';  // Comprehensive SR
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