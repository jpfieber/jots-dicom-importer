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

            // Create a new buffer from the pixel data, respecting the element's offset and length
            const buffer = Buffer.from(
                dicomData.byteArray.buffer,
                pixelDataElement.dataOffset,
                pixelDataElement.length
            );

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
        let result: string | undefined;

        try {
            // Check for ImageMagick
            if (!this.settings.magickPath) {
                throw new Error('ImageMagick path is not configured');
            }

            const arrayBuffer = await this.loadDICOMFile(file);
            const dicomData = this.parseDicomData(arrayBuffer);

            // Normalize the filename
            const normalizedNumber = this.normalizeFileName(file.basename);

            // Update target path with normalized number
            if (targetPath) {
                const targetDir = path.dirname(targetPath);
                targetPath = path.join(targetDir, `${normalizedNumber}.png`);
            }

            // Get and store transfer syntax before extracting pixel data
            this.lastTransferSyntax = dicomData.string(DicomTags.TransferSyntaxUID) || 'default';

            // Only try to extract pixel data for non-SR documents
            const { data, needsDecompression } = this.extractPixelData(dicomData);

            // Get window/level settings from DICOM if available
            const windowCenter = dicomData.floatString(DicomTags.WindowCenter);
            const windowWidth = dicomData.floatString(DicomTags.WindowWidth);
            const rescaleSlope = dicomData.floatString(DicomTags.RescaleSlope) || 1;
            const rescaleIntercept = dicomData.floatString(DicomTags.RescaleIntercept) || 0;

            // Create a temporary file for the raw pixel data
            const os = require('os');
            const crypto = require('crypto');
            const hash = crypto.createHash('md5').update(file.basename).digest('hex').substring(0, 8);
            const tempRawPath = path.join(os.tmpdir(), `dicom_raw_${hash}.pgm`);
            tempFiles.push(tempRawPath);

            if (needsDecompression) {
                // For compressed data, we'll need an intermediate file
                const converter = getDicomConverter(this.lastTransferSyntax);
                const tempCompressedPath = path.join(os.tmpdir(), `dicom_tmp_${hash}.${converter.tempExtension}`);
                tempFiles.push(tempCompressedPath);

                // Write the compressed data
                await fs.writeFile(tempCompressedPath, data);

                // Decompress first
                if (converter.utility === 'magick') {
                    await this.runImageMagickCommand(tempCompressedPath, tempRawPath, []);
                } else {
                    await this.runConverter(tempCompressedPath, tempRawPath);
                }
            } else {
                // For raw data, write PGM file directly
                const columns = dicomData.uint16(DicomTags.Columns) || 0;
                const rows = dicomData.uint16(DicomTags.Rows) || 0;
                const bitsAllocated = dicomData.uint16(DicomTags.BitsAllocated) || 16;

                // Create PGM header
                const pgmHeader = Buffer.from(`P5\n${columns} ${rows}\n${Math.pow(2, bitsAllocated) - 1}\n`);

                // Write PGM file with header and pixel data
                await fs.writeFile(tempRawPath, Buffer.concat([pgmHeader, data]));
            }

            // Ensure we have an absolute path for the target
            const vaultPath = (this.app.vault.adapter as any).basePath;
            const absoluteTargetPath = targetPath?.startsWith('C:') || targetPath?.startsWith('/')
                ? targetPath
                : path.join(vaultPath, targetPath || '');

            if (absoluteTargetPath.length >= 260) {
                const shortenedPath = this.shortenPath(absoluteTargetPath);
                targetPath = shortenedPath;
            }

            // Create target directory if needed
            const targetDir = path.dirname(absoluteTargetPath);
            await fs.mkdir(targetDir, { recursive: true }).catch(err => {
                throw err;
            });

            // Build ImageMagick command options for contrast enhancement
            const options = [];

            if (windowCenter !== undefined && windowWidth !== undefined) {
                // Use DICOM window/level settings if available
                options.push('-level', `${windowCenter - windowWidth / 2},${windowCenter + windowWidth / 2}`);
            } else {
                // Auto-level and enhance contrast
                options.push('-auto-level');
                // More aggressive contrast stretch with smaller threshold to preserve dark areas
                options.push('-contrast-stretch', '1%');
                // Increase contrast in mid-tones while preserving blacks
                options.push('-sigmoidal-contrast', '4,50%');
            }

            // Adjust brightness slightly down and increase contrast
            options.push('-brightness-contrast', '10,20');
            // Adjust gamma and then use levels to deepen the blacks
            options.push('-gamma', '0.8');
            options.push('-level', '5%,95%,0.9');
            // Final black point adjustment
            options.push('-black-threshold', '5%');

            // Run ImageMagick with contrast enhancement
            await this.runImageMagickCommand(tempRawPath, absoluteTargetPath, options);

            // Convert the file to base64 for return
            const convertedData = await fs.readFile(absoluteTargetPath);
            result = `data:image/png;base64,${convertedData.toString('base64')}`;

            return result;
        } catch (error) {
            if (error instanceof Error) {
                const code = (error as any).code;
                if (code === 'ENAMETOOLONG') {
                    console.error('ENAMETOOLONG error details:', {
                        inputFile: {
                            path: file.path,
                            length: file.path.length
                        },
                        targetPath: targetPath ? {
                            path: targetPath,
                            length: targetPath.length
                        } : undefined,
                        tempFiles: tempFiles.map(t => ({
                            path: t,
                            length: t.length
                        }))
                    });
                }
                console.error('Conversion failed:', {
                    error: error.message,
                    code: (error as any).code,
                    stack: error.stack
                });
            }
            throw error;
        } finally {
            // Clean up temporary files
            for (const tempPath of tempFiles) {
                try {
                    await fs.access(tempPath).then(
                        () => fs.unlink(tempPath).catch(e => {
                            console.error('Failed to delete temp file:', e);
                        }),
                        () => { /* File doesn't exist, no need to delete */ }
                    );
                } catch (cleanupError) {
                    console.error('Failed to check/cleanup temp file:', cleanupError);
                }
            }
        }
    }

    private async runImageMagickCommand(inputPath: string, outputPath: string, options: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');

            // Build the ImageMagick command with options
            const command = `"${this.settings.magickPath}" "${inputPath}" ${options.join(' ')} "${outputPath}"`;

            console.log('Debug - ImageMagick command:', command);

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

                // Only log stderr if it contains actual error content
                if (stderr && stderr.trim() !== '') {
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

            const transferSyntax = dicomData.string(DicomTags.TransferSyntaxUID);

            // Create a typed array directly from the buffer with proper offset handling
            const dataView = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.length);
            const pixelCount = rows * columns;
            const pixels = new Int16Array(pixelCount);

            // Read pixels with proper endianness handling
            const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2'; // Everything except Explicit VR Big Endian
            for (let i = 0; i < pixelCount; i++) {
                pixels[i] = dataView.getInt16(i * 2, littleEndian);
            }

            // Apply rescale slope and intercept
            const rescaleSlope = dicomData.floatString(DicomTags.RescaleSlope) || 1;
            const rescaleIntercept = dicomData.floatString(DicomTags.RescaleIntercept) || 0;

            // Convert to floating point values
            const values = new Float32Array(pixelCount);
            let min = Number.MAX_VALUE;
            let max = Number.MIN_VALUE;

            for (let i = 0; i < pixelCount; i++) {
                const value = pixels[i] * rescaleSlope + rescaleIntercept;
                values[i] = value;
                min = Math.min(min, value);
                max = Math.max(max, value);
            }

            // Create histogram
            const histogramBins = 256;
            const histogram = new Uint32Array(histogramBins);
            const range = max - min;

            for (let i = 0; i < pixelCount; i++) {
                const bin = Math.min(
                    histogramBins - 1,
                    Math.max(0, Math.floor((values[i] - min) * (histogramBins - 1) / range))
                );
                histogram[bin]++;
            }

            // Calculate cumulative histogram
            const cdf = new Float32Array(histogramBins);
            cdf[0] = histogram[0];
            for (let i = 1; i < histogramBins; i++) {
                cdf[i] = cdf[i - 1] + histogram[i];
            }

            // Normalize CDF to [0,1]
            for (let i = 0; i < histogramBins; i++) {
                cdf[i] /= pixelCount;
            }

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

            // Create image data
            const scanlineLength = columns + 1;
            const imageData = Buffer.alloc(rows * scanlineLength);

            // Apply advanced contrast enhancement
            let pixelIndex = 0;
            const clipLimit = 0.1; // Clip histogram at 10% of total pixels per bin
            const maxClip = pixelCount * clipLimit / histogramBins;

            for (let y = 0; y < rows; y++) {
                imageData[y * scanlineLength] = 0; // Filter type 0 (None)
                for (let x = 0; x < columns; x++) {
                    const value = values[pixelIndex++];

                    // Get normalized value using histogram equalization
                    const bin = Math.min(
                        histogramBins - 1,
                        Math.max(0, Math.floor((value - min) * (histogramBins - 1) / range))
                    );

                    // Use CDF for intensity mapping, but apply contrast limiting
                    let mappedValue = cdf[bin];

                    // Apply non-linear contrast enhancement
                    const contrast = 2.0; // Increase contrast
                    mappedValue = Math.pow(mappedValue, 1 / contrast);

                    // Apply brightness boost
                    mappedValue = Math.min(1, mappedValue * 1.8); // 80% brightness boost

                    // Convert to 8-bit
                    const intensity = Math.round(mappedValue * 255);
                    imageData[y * scanlineLength + x + 1] = intensity;
                }
            }

            // Compress and finish PNG
            const deflate = require('zlib').deflateSync;
            const compressedData = deflate(imageData);
            const idatChunk = this.createPNGChunk('IDAT', compressedData);
            const iendChunk = this.createPNGChunk('IEND', Buffer.alloc(0));

            const finalPngData = Buffer.concat([
                pngSignature,
                ihdrChunk,
                idatChunk,
                iendChunk
            ]);

            return `data:image/png;base64,${finalPngData.toString('base64')}`;
        } catch (error) {
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
        if (!this.settings.createAnimatedGif || !this.settings.imagemagickPath) {
            return;
        }

        try {
            console.log(`Starting GIF creation - Input path: ${imagesPath}, Output path: ${outputPath}`);
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

            console.log(`Found ${pngFiles.length} PNG files for GIF creation`);

            if (pngFiles.length < this.settings.minImagesForGif) {
                console.log(`Skipping GIF creation - Not enough images (${pngFiles.length} < ${this.settings.minImagesForGif})`);
                return;
            }

            // Get the vault path for constructing absolute paths
            const vaultPath = (this.app.vault.adapter as any).basePath;

            return new Promise((resolve, reject) => {
                console.log('Executing ImageMagick command for GIF creation');
                const { exec } = require('child_process');

                // Use wildcards for input and normalize paths
                const inputPattern = path.join(vaultPath, imagesPath, '*.png').replace(/\\/g, '/');
                const absoluteOutputPath = path.join(vaultPath, outputPath).replace(/\\/g, '/');

                // ImageMagick command with wildcard pattern
                const command = `"${this.settings.imagemagickPath}" -delay ${this.settings.gifFrameDelay / 10} "${inputPattern}" -loop 0 "${absoluteOutputPath}"`;

                console.log('Debug - Command:', command);
                exec(command, {
                    windowsHide: true,
                    maxBuffer: 1024 * 1024 * 100,
                    env: {
                        ...process.env,
                        MAGICK_CONFIGURE_PATH: path.dirname(this.settings.imagemagickPath)
                    }
                }, (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        console.error(`GIF creation failed - ImageMagick error: ${error.message}`);
                        if (stderr) console.error(`ImageMagick stderr: ${stderr}`);
                        reject(new Error(`Failed to create animated GIF: ${error.message}`));
                        return;
                    }
                    console.log('GIF creation completed successfully');
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