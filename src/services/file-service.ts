import { promises as fs } from 'fs';
import path from 'path';
import { DICOMHandlerSettings } from '../settings';

export class FileService {
    constructor(private settings: DICOMHandlerSettings) { }

    // Reads a DICOM file and returns its contents
    async readDicomFile(filePath: string): Promise<Buffer> {
        try {
            const data = await fs.readFile(filePath);
            return data;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error reading DICOM file: ${error.message}`);
            }
            throw new Error('Error reading DICOM file: Unknown error');
        }
    }

    // Writes data to a DICOM file
    async writeDicomFile(filePath: string, data: Buffer): Promise<void> {
        try {
            await fs.writeFile(filePath, data);
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error writing DICOM file: ${error.message}`);
            }
            throw new Error('Error writing DICOM file: Unknown error');
        }
    }

    async findDicomFiles(folderPath: string): Promise<string[]> {
        try {
            const dicomFiles = await this.findDicomFilesRecursively(folderPath);
            return dicomFiles;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error finding DICOM files: ${error.message}`);
            }
            throw new Error('Error finding DICOM files: Unknown error');
        }
    }

    private async findDicomFilesRecursively(folderPath: string): Promise<string[]> {
        const dicomFiles: string[] = [];
        const entries = await fs.readdir(folderPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(folderPath, entry.name);

            if (entry.isDirectory()) {
                const subDirFiles = await this.findDicomFilesRecursively(fullPath);
                dicomFiles.push(...subDirFiles);
            } else if (entry.isFile() && this.isDicomFile(entry.name)) {
                dicomFiles.push(fullPath);
            }
        }

        return dicomFiles;
    }

    private isDicomFile(filename: string): boolean {
        if (this.settings.dicomIdentification === 'extension') {
            return filename.toLowerCase().endsWith(`.${this.settings.dicomExtension.toLowerCase()}`);
        } else {
            return path.extname(filename) === '';
        }
    }

    // Checks if a file exists
    async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    // Checks if we should continue iterating through folders
    async shouldContinueIteration(folderPath: string): Promise<boolean> {
        try {
            const stats = await fs.stat(folderPath);
            if (!stats.isDirectory()) {
                return false;
            }

            const items = await fs.readdir(folderPath);
            // Continue if there are any items in the folder
            return items.length > 0;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error checking folder iteration: ${error.message}`);
            }
            throw new Error('Error checking folder iteration: Unknown error');
        }
    }
}