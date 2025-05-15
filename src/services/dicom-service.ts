import { TFile, App, Notice, TFolder, TAbstractFile } from 'obsidian';
import dicomParser from 'dicom-parser';
import { DICOMHandlerSettings } from '../settings';
import { DicomTags } from '../models/dicom-tags';
import { getDicomConverter } from '../utils/transfer-syntax';
import * as path from 'path';
import * as fs from 'fs/promises';

export class DICOMService {
    private lastTransferSyntax: string | undefined;

    constructor(
        private app: App,
        private settings: DICOMHandlerSettings
    ) { }

    private extractPixelData(dicomData: dicomParser.DataSet): { data: Buffer, needsDecompression: boolean } {
        const pixelDataElement = dicomData.elements[DicomTags.PixelData];
        if (!pixelDataElement) {
            throw new Error('No pixel data found in DICOM file');
        }

        // Get transfer syntax to determine format
        const transferSyntax = dicomData.string(DicomTags.TransferSyntaxUID);

        // Handle raw pixel data (uncompressed)
        if (transferSyntax === '1.2.840.10008.1.2.1' || // Explicit VR Little Endian
            transferSyntax === '1.2.840.10008.1.2' ||    // Implicit VR Little Endian
            transferSyntax === '1.2.840.10008.1.2.2') {  // Explicit VR Big Endian

            // Create a new buffer directly from dicomParser's byteArray, preserving correct offsets
            const buffer = Buffer.from(dicomData.byteArray.buffer, dicomData.byteArray.byteOffset + pixelDataElement.dataOffset, pixelDataElement.length);

            // Handle big endian data if needed
            if (transferSyntax === '1.2.840.10008.1.2.2') {
                // Swap bytes for big endian data
                for (let i = 0; i < buffer.length; i += 2) {
                    const temp = buffer[i];
                    buffer[i] = buffer[i + 1];
                    buffer[i + 1] = temp;
                }
            }

            return {
                data: buffer,
                needsDecompression: false
            };
        }

        // Handle JPEG2000 compressed data
        if (transferSyntax === '1.2.840.10008.1.2.4.90' || // JPEG 2000 Lossless
            transferSyntax === '1.2.840.10008.1.2.4.91') { // JPEG 2000 Lossy
            return this.extractJPEG2000Data(dicomData, pixelDataElement);
        }

        // Handle JPEG Lossless compressed data
        if (transferSyntax === '1.2.840.10008.1.2.4.70') { // JPEG Lossless
            return this.extractJPEGLosslessData(dicomData, pixelDataElement);
        }

        throw new Error(`Unsupported transfer syntax: ${transferSyntax}`);
    }

    private extractJPEG2000Data(dicomData: dicomParser.DataSet, pixelDataElement: any): { data: Buffer, needsDecompression: boolean } {
        const byteArray = new Uint8Array(dicomData.byteArray.buffer);
        let position = pixelDataElement.dataOffset;

        // Skip Basic Offset Table if present
        if (byteArray[position] === 0xFE && byteArray[position + 1] === 0xFF &&
            byteArray[position + 2] === 0x00 && byteArray[position + 3] === 0xE0) {
            const botLength =
                byteArray[position + 4] |
                (byteArray[position + 5] << 8) |
                (byteArray[position + 6] << 16) |
                (byteArray[position + 7] << 24);
            position += 8 + botLength;
        }

        // Find JPEG2000 stream
        if (position < byteArray.length - 8 &&
            byteArray[position] === 0xFE && byteArray[position + 1] === 0xFF &&
            byteArray[position + 2] === 0x00 && byteArray[position + 3] === 0xE0) {

            const itemLength =
                byteArray[position + 4] |
                byteArray[position + 5] << 8 |
                byteArray[position + 6] << 16 |
                byteArray[position + 7] << 24;

            position += 8;

            const j2kData = Buffer.from(byteArray.buffer, byteArray.byteOffset + position, itemLength);

            return {
                data: j2kData,
                needsDecompression: true
            };
        }

        throw new Error('Could not find JPEG2000 stream after Basic Offset Table');
    }

    private extractJPEGLosslessData(dicomData: dicomParser.DataSet, pixelDataElement: any): { data: Buffer, needsDecompression: boolean } {
        const byteArray = new Uint8Array(dicomData.byteArray.buffer);
        let position = pixelDataElement.dataOffset;

        // Find JPEG header (SOI marker: 0xFFD8)
        while (position < byteArray.length - 2) {
            if (byteArray[position] === 0xFF && byteArray[position + 1] === 0xD8) {
                // Found JPEG header, now look for end marker (EOI: 0xFFD9)
                let endPosition = position + 2;
                while (endPosition < byteArray.length - 2) {
                    if (byteArray[endPosition] === 0xFF && byteArray[endPosition + 1] === 0xD9) {
                        // Found complete JPEG frame
                        const jpegData = Buffer.from(byteArray.buffer, byteArray.byteOffset + position, endPosition - position + 2);
                        return {
                            data: jpegData,
                            needsDecompression: true
                        };
                    }
                    endPosition++;
                }
            }
            position++;
        }

        throw new Error('Could not find valid JPEG Lossless frame in DICOM data');
    }

    // Add this helper method to normalize filenames
    public normalizeFileName(originalName: string): string {
        // Extract all numbers from filename
        const numbers = originalName.match(/\d+/g);
        if (!numbers) return originalName;

        // Get the last number in the sequence, which is typically the slice number
        const number = numbers[numbers.length - 1];

        // Pad the number to 4 digits
        return number.padStart(4, '0');
    }

    async convertToImage(file: TFile, targetPath?: string): Promise<string> {
        const tempFiles: string[] = [];

        try {
            const arrayBuffer = await this.loadDICOMFile(file);
            const dicomData = this.parseDicomData(arrayBuffer);

            // Get and store transfer syntax before extracting pixel data
            this.lastTransferSyntax = dicomData.string(DicomTags.TransferSyntaxUID) || 'default';

            // Extract pixel data
            const { data, needsDecompression } = this.extractPixelData(dicomData);

            let result: string;

            if (this.lastTransferSyntax === '1.2.840.10008.1.2.4.70') {  // JPEG Lossless
                if (!this.settings.magickPath) {
                    throw new Error('ImageMagick path is not configured');
                }

                // Create temporary files for JPEG processing
                const os = require('os');
                const crypto = require('crypto');
                const hash = crypto.createHash('md5').update(file.basename).digest('hex').substring(0, 8);
                const tempJpegPath = path.join(os.tmpdir(), `dicom_tmp_${hash}.jpg`);
                const tempPngPath = path.join(os.tmpdir(), `dicom_tmp_${hash}.png`);
                tempFiles.push(tempJpegPath, tempPngPath);

                // Write JPEG data to temp file
                await fs.writeFile(tempJpegPath, data);

                // Convert JPEG to PNG using ImageMagick
                await this.runImageMagickCommand(tempJpegPath, tempPngPath, ['-auto-level']);

                // Read the converted PNG
                const pngData = await fs.readFile(tempPngPath);
                result = `data:image/png;base64,${pngData.toString('base64')}`;
            } else {
                // For all other formats, use our direct pixel manipulation
                if (needsDecompression) {
                    // For compressed data (e.g. JPEG 2000), decompress first
                    const os = require('os');
                    const crypto = require('crypto');
                    const hash = crypto.createHash('md5').update(file.basename).digest('hex').substring(0, 8);
                    const tempCompressedPath = path.join(os.tmpdir(), `dicom_tmp_${hash}.j2k`);
                    const tempDecompressedPath = path.join(os.tmpdir(), `dicom_tmp_${hash}.pgm`);
                    tempFiles.push(tempCompressedPath, tempDecompressedPath);

                    // Write the compressed data
                    await fs.writeFile(tempCompressedPath, data);

                    // Decompress using OpenJPEG
                    if (!this.settings.opjPath) {
                        throw new Error('OpenJPEG path is not configured');
                    }
                    await this.runConverter(tempCompressedPath, tempDecompressedPath);

                    // Read the decompressed data
                    const decompressedData = await fs.readFile(tempDecompressedPath);
                    result = await this.convertRawToImage(decompressedData, dicomData);
                } else {
                    // For uncompressed data, convert directly
                    result = await this.convertRawToImage(data, dicomData);
                }
            }

            // If a target path is specified, save the PNG file
            if (targetPath) {
                const base64Data = result.replace(/^data:image\/png;base64,/, '');
                const binaryData = Buffer.from(base64Data, 'base64');

                // Get the vault path for proper file handling
                const vaultPath = (this.app.vault.adapter as any).basePath;
                const absoluteTargetPath = targetPath.startsWith(vaultPath) ?
                    targetPath : path.join(vaultPath, targetPath);

                // Ensure target directory exists
                const targetDir = path.dirname(absoluteTargetPath);
                await fs.mkdir(targetDir, { recursive: true });

                // Create the file in the vault
                await this.app.vault.createBinary(
                    targetPath.startsWith(vaultPath) ?
                        path.relative(vaultPath, targetPath) : targetPath,
                    binaryData
                );
            }

            return result;
        } catch (error) {
            console.error('Conversion failed:', error);
            throw error;
        } finally {
            // Clean up temporary files
            for (const tempPath of tempFiles) {
                try {
                    await fs.access(tempPath).then(
                        () => fs.unlink(tempPath),
                        () => { /* File doesn't exist, no need to delete */ }
                    );
                } catch (cleanupError) {
                    console.error('Failed to clean up temp file:', cleanupError);
                }
            }
        }
    }

    private async runImageMagickCommand(inputPath: string, outputPath: string, options: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');

            // Build the ImageMagick command with options
            const command = `"${this.settings.magickPath}" "${inputPath}" ${options.join(' ')} "${outputPath}"`;

            exec(command, { windowsHide: true }, async (error: any, stdout: string, stderr: string) => {
                if (error) {
                    reject(new Error(`ImageMagick conversion failed: ${error.message}\n${stderr}`));
                    return;
                }

                // Verify the output file exists and has content
                try {
                    const exists = await fs.access(outputPath)
                        .then(() => true)
                        .catch(() => false);

                    if (!exists) {
                        reject(new Error(`Output file not created at ${outputPath}`));
                        return;
                    }

                    const stats = await fs.stat(outputPath);
                    if (stats.size === 0) {
                        reject(new Error('Output file was created but is empty'));
                        return;
                    }

                    resolve();
                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                    reject(new Error(`Failed to verify output file: ${errorMessage}`));
                }
            });
        });
    }

    private async runConverter(inputPath: string, outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');

            // Get the converter settings based on transfer syntax
            const transferSyntax = this.lastTransferSyntax || 'default';
            const converter = getDicomConverter(transferSyntax);

            // Ensure paths are absolute and properly quoted
            const normalizedInputPath = path.resolve(inputPath);
            const normalizedOutputPath = path.resolve(outputPath);

            // Build command based on the utility
            let command;
            if (converter.utility === 'magick') {
                command = `"${this.settings.magickPath}" "${normalizedInputPath}" "${normalizedOutputPath}"`;
            } else {
                command = `"${this.settings.opjPath}" -i "${normalizedInputPath}" -o "${normalizedOutputPath}"`;
            }

            exec(command, { windowsHide: true }, async (error: any, stdout: string, stderr: string) => {
                if (error) {
                    const errorMsg = converter.utility === 'magick' ? 'ImageMagick conversion failed' : 'OpenJPEG conversion failed';
                    reject(new Error(`${errorMsg}: ${error.message}\n${stderr}`));
                    return;
                }

                // Filter out known non-error messages from stderr
                if (stderr && stderr.trim() !== '' &&
                    !stderr.includes('WARNING -> [PGM file] Only the first component') &&
                    !stderr.includes('is written to the file')) {
                    console.error(`${converter.utility} stderr:`, stderr);
                }

                // Verify the output file exists and has content
                try {
                    const exists = await fs.access(normalizedOutputPath)
                        .then(() => true)
                        .catch(() => false);

                    if (!exists) {
                        reject(new Error(`Output file not created at ${normalizedOutputPath}`));
                        return;
                    }

                    const stats = await fs.stat(normalizedOutputPath);
                    if (stats.size === 0) {
                        reject(new Error('Output file was created but is empty'));
                        return;
                    }

                    resolve();
                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                    reject(new Error(`Failed to verify output file: ${errorMessage}`));
                }
            });
        });
    }

    private async convertRawToImage(pixelData: Buffer, dicomData: dicomParser.DataSet): Promise<string> {
        try {
            const columns = dicomData.uint16(DicomTags.Columns) || 0;
            const rows = dicomData.uint16(DicomTags.Rows) || 0;
            const bitsAllocated = dicomData.uint16(DicomTags.BitsAllocated) || 16;
            const pixelRepresentation = dicomData.uint16(DicomTags.PixelRepresentation) || 0;
            const samplesPerPixel = dicomData.uint16(DicomTags.SamplesPerPixel) || 1;

            const expectedLength = rows * columns * (bitsAllocated / 8);
            if (pixelData.length < expectedLength) {
                throw new Error(`Invalid pixel data length. Expected ${expectedLength} bytes but got ${pixelData.length} bytes`);
            }

            const transferSyntax = dicomData.string(DicomTags.TransferSyntaxUID);
            const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2';

            // Create typed array for pixel data
            const pixelCount = rows * columns;
            const pixels = new Int16Array(pixelCount);
            const view = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.length);

            // Read pixels with bounds checking
            for (let i = 0; i < pixelCount && (i * 2 + 1) < pixelData.length; i++) {
                pixels[i] = view.getInt16(i * 2, littleEndian);
            }

            // Calculate window settings if not provided
            let windowCenter = dicomData.floatString(DicomTags.WindowCenter);
            let windowWidth = dicomData.floatString(DicomTags.WindowWidth);

            if (!windowCenter || !windowWidth) {
                // Auto window by scanning min/max values
                let min = Number.MAX_VALUE;
                let max = Number.MIN_VALUE;
                for (let i = 0; i < pixels.length; i++) {
                    const value = pixels[i];
                    min = Math.min(min, value);
                    max = Math.max(max, value);
                }
                windowCenter = (max + min) / 2;
                windowWidth = max - min;
            }

            // Convert 16-bit to 8-bit using window/level
            const lowValue = windowCenter - (windowWidth / 2);
            const highValue = windowCenter + (windowWidth / 2);

            // Create PNG header
            const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            const ihdrChunk = this.createPNGChunk('IHDR', Buffer.from([
                ...this.toBytes(columns, 4),
                ...this.toBytes(rows, 4),
                8,                              // Bit depth
                0,                              // Color type (grayscale)
                0,                              // Compression method
                0,                              // Filter method
                0                               // Interlace method
            ]));

            // Create image data with proper filter type handling
            const scanlineLength = columns + 1;
            const imageData = Buffer.alloc(rows * scanlineLength);

            // Fill image data with normalized pixel values
            let pixelIndex = 0;
            for (let y = 0; y < rows; y++) {
                imageData[y * scanlineLength] = 0; // Filter type 0 (None)
                for (let x = 0; x < columns; x++) {
                    const pixelValue = pixels[pixelIndex++];
                    let normalized = (pixelValue - lowValue) / (highValue - lowValue);
                    normalized = Math.max(0, Math.min(1, normalized));
                    const intensity = Math.round(normalized * 255);
                    imageData[y * scanlineLength + x + 1] = intensity;
                }
            }

            // Compress image data
            const deflate = require('zlib').deflateSync;
            const compressedData = deflate(imageData);
            const idatChunk = this.createPNGChunk('IDAT', compressedData);
            const iendChunk = this.createPNGChunk('IEND', Buffer.alloc(0));

            // Combine all chunks
            const pngData = Buffer.concat([
                pngSignature,
                ihdrChunk,
                idatChunk,
                iendChunk
            ]);

            return `data:image/png;base64,${pngData.toString('base64')}`;
        } catch (error) {
            console.error('Error during raw DICOM conversion:', error);
            throw error;
        }
    }

    private toBytes(num: number, bytes: number): number[] {
        const result = new Array(bytes);
        for (let i = bytes - 1; i >= 0; i--) {
            result[i] = num & 0xff;
            num = num >> 8;
        }
        return result;
    }

    private createPNGChunk(type: string, data: Buffer): Buffer {
        const typeBytes = Buffer.from(type);
        const length = data.length;
        const chunk = Buffer.concat([
            Buffer.from(this.toBytes(length, 4)),
            typeBytes,
            data
        ]);

        // Calculate CRC
        const crc = this.calculateCRC(Buffer.concat([typeBytes, data]));
        return Buffer.concat([chunk, Buffer.from(this.toBytes(crc, 4))]);
    }

    private calculateCRC(data: Buffer): number {
        let crc = 0xffffffff;
        const crcTable = this.createCRCTable();

        for (let i = 0; i < data.length; i++) {
            crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
        }

        return crc ^ 0xffffffff;
    }

    private createCRCTable(): number[] {
        const table = new Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
            }
            table[i] = c;
        }
        return table;
    }

    private async cleanup(...paths: string[]): Promise<void> {
        for (const filePath of paths) {
            try {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file) {
                    await this.app.vault.delete(file);
                }
            } catch (error) {
                console.error(`Failed to clean up file ${filePath}: ${error}`);
            }
        }
    }

    private async loadDICOMFile(file: TFile): Promise<ArrayBuffer> {
        try {
            if (file.path.startsWith('C:') || file.path.startsWith('/')) {
                // For absolute paths, read directly using fs
                const buffer = await fs.readFile(file.path);
                return buffer.buffer;
            } else {
                // For vault-relative paths, use vault API
                return await this.app.vault.readBinary(file);
            }
        } catch (error) {
            throw error;
        }
    }

    public parseDicomData(arrayBuffer: ArrayBuffer): dicomParser.DataSet {
        try {
            const byteArray = new Uint8Array(arrayBuffer);
            return dicomParser.parseDicom(byteArray);
        } catch (error) {
            throw error;
        }
    }

    getDicomMetadata(arrayBuffer: ArrayBuffer): Record<string, string | undefined> {
        const dataSet = this.parseDicomData(arrayBuffer);
        return {
            patientName: dataSet.string(DicomTags.PatientName),
        };
    }

    private async getReportText(dicomData: dicomParser.DataSet): Promise<string> {
        // Check if this is a Structured Report
        const sopClassUID = dicomData.string(DicomTags.SOPClassUID);
        const isStructuredReport = sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' || // Basic Text SR
            sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' || // Enhanced SR
            sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';  // Comprehensive SR

        if (!isStructuredReport) {
            throw new Error('Not a DICOM Structured Report');
        }

        // Try to get the report text from various possible tags
        const reportText = dicomData.string('x00420010') || // Document Title
            dicomData.string('x00420012') || // Document Content
            dicomData.string('x00400100') || // Procedure Description
            dicomData.string('x00081030');   // Study Description

        if (!reportText) {
            throw new Error('No report text found in DICOM SR');
        }

        return reportText;
    }

    async createAnimatedGif(imagesPath: string, outputPath: string): Promise<void> {
        if (!this.settings.createAnimatedGif || !this.settings.magickPath) {
            return;
        }

        try {
            // Get a list of PNG files in the Images folder
            const imagesFolder = this.app.vault.getAbstractFileByPath(imagesPath);
            if (!imagesFolder || !(imagesFolder instanceof TFolder)) {
                console.error('Failed to create GIF - Images folder not found or invalid');
                return;
            }

            const pngFiles = imagesFolder.children
                .filter((file: TAbstractFile): file is TFile =>
                    file instanceof TFile && file.extension === 'png')
                .sort((a, b) => a.name.localeCompare(b.name));

            if (pngFiles.length < this.settings.minImagesForGif) {
                return;
            }

            // Get the vault path for constructing absolute paths
            const vaultPath = (this.app.vault.adapter as any).basePath;

            return new Promise((resolve, reject) => {
                const { exec } = require('child_process');

                // Use wildcards for input and normalize paths
                const inputPattern = path.join(vaultPath, imagesPath, '*.png').replace(/\\/g, '/');
                const absoluteOutputPath = path.join(vaultPath, outputPath).replace(/\\/g, '/');

                // ImageMagick command with wildcard pattern
                const command = `"${this.settings.magickPath}" -delay ${this.settings.gifFrameDelay / 10} "${inputPattern}" -loop 0 "${absoluteOutputPath}"`;

                exec(command, {
                    windowsHide: true,
                    maxBuffer: 1024 * 1024 * 100,
                    env: {
                        ...process.env,
                        MAGICK_CONFIGURE_PATH: path.dirname(this.settings.magickPath)
                    }
                }, (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        console.error(`GIF creation failed - ImageMagick error: ${error.message}`);
                        if (stderr) console.error(`ImageMagick stderr: ${stderr}`);
                        reject(new Error(`Failed to create animated GIF: ${error.message}`));
                        return;
                    }
                    resolve();
                });
            });
        } catch (error) {
            console.error(`GIF creation failed - Unexpected error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }

    // Add helper method for path shortening
    private shortenPath(longPath: string): string {
        const ext = path.extname(longPath);
        const dir = path.dirname(longPath);
        const base = path.basename(longPath, ext);

        // If path is too long, truncate the basename while preserving extension
        if (longPath.length >= 260) {
            const maxBaseLength = 260 - (dir.length + ext.length + 1);
            const shortenedBase = base.substring(0, maxBaseLength - 1);
            return path.join(dir, shortenedBase + ext);
        }
        return longPath;
    }
}