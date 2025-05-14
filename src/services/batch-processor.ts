import { App, TFile, TFolder } from 'obsidian';
import { DICOMService } from './dicom-service';
import { MetadataService } from './metadata-service';
import { PathService } from './path-service';
import { DicomTags } from '../models/dicom-tags';
import { DICOMHandlerSettings } from '../settings';
import * as path from 'path';
import * as fs from 'fs/promises';
import dicomParser from 'dicom-parser';

export class BatchProcessor {
    constructor(
        private app: App,
        private dicomService: DICOMService,
        private metadataService: MetadataService,
        private settings: DICOMHandlerSettings
    ) { }

    public async processBatch(
        files: { path: string; buffer: Buffer }[],
        destinationPath: string,
        onProgress?: (progress: { percentage: number; message: string }) => void
    ): Promise<void> {
        const batchResults = new Map<string, {
            dicomData: dicomParser.DataSet;
            isNew: boolean;
            targetPath: string;
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
            files: { path: string; buffer: Buffer }[];
            targetPath: string;
            dicomData: dicomParser.DataSet;
        }>();

        const studyGroups = new Map<string, {
            dicomData: dicomParser.DataSet;
            seriesPaths: string[];
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

                if (this.settings.createAnimatedGif) {
                    const seriesName = group.targetPath.split('/').pop() || 'series';
                    const gifPath = PathService.joinPath(group.targetPath, `${seriesName}.gif`);
                    await this.dicomService.createAnimatedGif(imagesPath, gifPath);
                }
            }

            // Create metadata note
            await this.metadataService.createMetadataNote(group.dicomData, group.targetPath);

            // Archive original files if enabled
            if (this.settings.archiveDicomFiles) {
                await this.archiveOriginalFiles(group, group.targetPath);
            }

            processedSeries++;
            onProgress?.({
                percentage: Math.min(90, 20 + Math.round((processedSeries / seriesGroups.size) * 70)),
                message: `Processing series ${processedSeries} of ${seriesGroups.size}`
            });
        }

        // Create study metadata notes after all series are processed
        for (const [studyUID, studyData] of studyGroups) {
            await this.metadataService.createStudyMetadataNote(studyUID, studyData);
        }
    }

    public async processSingleFile(file: TFile, destFolder?: TFolder): Promise<void> {
        try {
            let arrayBuffer;
            if (file.path.startsWith('C:') || file.path.startsWith('/')) {
                arrayBuffer = await fs.readFile(file.path);
            } else {
                arrayBuffer = await this.app.vault.readBinary(file);
            }

            const dicomData = this.dicomService.parseDicomData(arrayBuffer);
            const basePath = destFolder ? destFolder.path : (file.parent?.path || '');

            if (this.isStructuredReport(dicomData)) {
                const studyDate = dicomData.string(DicomTags.StudyDate);
                const organizedPath = this.getOrganizedFolderPath(basePath, dicomData);
                await this.ensureFolderPath(organizedPath);

                const folderName = organizedPath.split('/').pop() || 'series';
                const sanitizedFolderName = folderName.replace(/^\d{8}\s*-\s*/, '');
                const notePath = path.join(
                    organizedPath,
                    `${studyDate ? studyDate + ' - ' : ''}${sanitizedFolderName}.md`
                ).replace(/\\/g, '/');

                const noteExists = await this.app.vault.adapter.exists(notePath);
                if (!noteExists) {
                    await this.metadataService.createMetadataNote(dicomData, organizedPath);
                }

                if (this.settings.archiveDicomFiles) {
                    const dicomPath = path.join(organizedPath, 'DICOM').replace(/\\/g, '/');
                    await this.ensureFolderPath(dicomPath);
                    const dicomFilePath = path.join(dicomPath, file.name).replace(/\\/g, '/');

                    const dicomExists = await this.app.vault.adapter.exists(dicomFilePath);
                    if (!dicomExists) {
                        await this.app.vault.createBinary(dicomFilePath, Buffer.from(arrayBuffer));
                    }
                }
                return;
            }

            const imageData = await this.dicomService.convertToImage(file);
            const imagesPath = path.join(basePath, 'Images').replace(/\\/g, '/');
            await this.ensureFolderPath(imagesPath);

            const newFileName = `${file.basename}.png`;
            const newPath = path.join(imagesPath, newFileName).replace(/\\/g, '/');

            const imageExists = await this.app.vault.adapter.exists(newPath);
            if (!imageExists) {
                const base64Data = imageData.replace(new RegExp(`^data:image/${this.settings.imageFormat};base64,`), '');
                const binaryData = Buffer.from(base64Data, 'base64');
                await this.app.vault.createBinary(newPath, binaryData);
            }

            if (this.settings.archiveDicomFiles) {
                const dicomPath = path.join(basePath, 'DICOM').replace(/\\/g, '/');
                await this.ensureFolderPath(dicomPath);
                const dicomFilePath = path.join(dicomPath, file.name).replace(/\\/g, '/');

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

    private async archiveOriginalFiles(
        group: { files: { path: string; buffer: Buffer }[] },
        targetPath: string
    ): Promise<void> {
        const dicomPath = PathService.joinPath(targetPath, 'DICOM');
        await this.ensureFolderPath(dicomPath);

        await Promise.all(group.files.map(async file => {
            const normalizedNumber = this.dicomService.normalizeFileName(path.basename(file.path));
            const archivedName = `${normalizedNumber}${path.extname(file.path)}`;
            const archivePath = PathService.joinPath(dicomPath, archivedName);
            await this.app.vault.createBinary(archivePath, file.buffer);
        }));
    }

    private async ensureFolderPath(folderPath: string): Promise<void> {
        const parts = folderPath.split('/').filter(p => p.length > 0);
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                await this.app.vault.createFolder(currentPath);
            }
        }
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

        const sanitizedParts = parts.map(part => PathService.sanitizeFileName(part));
        const fullPath = PathService.joinPath(basePath, ...sanitizedParts);
        return PathService.normalizePath(fullPath, true);
    }

    private formatDateForPath(dicomDate: string, format: string): string {
        if (!dicomDate || !format) return '';

        const year = dicomDate.substring(0, 4);
        const month = dicomDate.substring(4, 6);
        const day = dicomDate.substring(6, 8);

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const monthAbbrev = monthNames.map(m => m.substring(0, 3));

        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayAbbrev = dayNames.map(d => d.substring(0, 3));

        const placeholders: Record<string, string> = {
            'YYYY': year,
            'YY': year.substring(2),
            'MMMM': monthNames[parseInt(month) - 1],
            'MMM': monthAbbrev[parseInt(month) - 1],
            'MM': month,
            'M': String(parseInt(month)),
            'DDDD': dayNames[date.getDay()],
            'DDD': dayAbbrev[date.getDay()],
            'DD': day,
            'D': String(parseInt(day))
        };

        const tokens = Object.keys(placeholders).sort((a, b) => b.length - a.length);
        let result = format;
        for (const token of tokens) {
            result = result.replace(new RegExp(token, 'g'), placeholders[token]);
        }

        return result;
    }

    private truncateString(str: string | undefined, maxLength: number): string {
        if (!str) return '';
        if (str.length <= maxLength) return str;
        return str.substring(0, maxLength - 3) + '...';
    }

    private formatPatientName(name: string): string {
        if (name.includes('^')) {
            const [lastName, firstName] = name.split('^');
            return `${this.toTitleCase(firstName)} ${this.toTitleCase(lastName)}`;
        }
        return this.toTitleCase(name);
    }

    private toTitleCase(str: string): string {
        if (!str) return '';

        return str.toLowerCase().split(/[\s-]+/).map(word => {
            const lowerCaseWords = ['and', 'or', 'the', 'in', 'on', 'at', 'to', 'for', 'of'];
            if (lowerCaseWords.includes(word.toLowerCase())) {
                return word.toLowerCase();
            }
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }).join(' ');
    }

    private isStructuredReport(dicomData: dicomParser.DataSet): boolean {
        const sopClassUID = dicomData.string(DicomTags.SOPClassUID);
        return sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' || // Basic Text SR
            sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' || // Enhanced SR
            sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';  // Comprehensive SR
    }
}