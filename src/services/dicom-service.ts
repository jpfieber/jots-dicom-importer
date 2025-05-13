import { TFile, App, Notice } from 'obsidian';
import dicomParser from 'dicom-parser';
import { DICOMHandlerSettings } from '../settings';
import { DicomTags } from '../models/dicom-tags';
import { getDicomConverter } from '../utils/transfer-syntax';
import * as path from 'path';
import * as fs from 'fs/promises';

export class DICOMService {
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
                    (byteArray[position + 5] << 8) |
                    (byteArray[position + 6] << 16) |
                    (byteArray[position + 7] << 24);

                position += 8;

                const j2kData = Buffer.from(byteArray.buffer, byteArray.byteOffset + position, itemLength);

                return {
                    data: j2kData,
                    needsDecompression: true
                };
            }

            throw new Error('Could not find JPEG2000 stream after Basic Offset Table');
        }

        throw new Error(`Unsupported transfer syntax: ${transferSyntax}`);
    }

    async convertToImage(file: TFile, targetPath?: string): Promise<string> {
        const tempFiles: string[] = [];
        try {
            if (!this.settings.opjPath) {
                throw new Error('OpenJPEG path is not configured');
            }

            // Read DICOM data for metadata
            const arrayBuffer = await this.loadDICOMFile(file);
            const dicomData = this.parseDicomData(arrayBuffer);

            // Check if this is a Structured Report FIRST
            const sopClassUID = dicomData.string(DicomTags.SOPClassUID);
            const isStructuredReport = sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' || // Basic Text SR
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' || // Enhanced SR
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';  // Comprehensive SR

            if (isStructuredReport) {
                throw new Error('This is a Structured Report (SR) document, not an image');
            }

            // Only try to extract pixel data for non-SR documents
            const { data, needsDecompression } = this.extractPixelData(dicomData);

            if (needsDecompression) {
                // Create temporary file in the same directory as the target PNG
                const timestamp = Date.now();
                const targetDir = targetPath ? path.dirname(targetPath) : (file.parent?.path || '');
                const tempJ2kPath = `${targetDir}/temp_${file.basename}_${timestamp}.j2k`;
                tempFiles.push(tempJ2kPath);

                // Ensure the target directory exists before creating temp file
                if (!this.app.vault.getAbstractFileByPath(targetDir)) {
                    await this.app.vault.createFolder(targetDir);
                }

                await this.app.vault.createBinary(tempJ2kPath, data);

                try {
                    // Get absolute paths for OpenJPEG
                    const vaultPath = (this.app.vault.adapter as any).basePath;
                    const absoluteInputPath = path.join(vaultPath, tempJ2kPath);

                    // Create PNG directly in the target location
                    const finalPngPath = targetPath || path.join(file.parent?.path || '', 'Images', `${file.basename}.png`);

                    // Create absolute output path only if the target path is relative
                    const absoluteOutputPath = targetPath?.startsWith('C:') || targetPath?.startsWith('/')
                        ? targetPath
                        : path.join(vaultPath, finalPngPath);

                    // Run OpenJPEG with correct paths
                    await this.runConverter(absoluteInputPath, absoluteOutputPath);

                    // Read the converted image
                    const finalImageFile = this.app.vault.getAbstractFileByPath(finalPngPath);
                    if (!finalImageFile || !(finalImageFile instanceof TFile)) {
                        throw new Error('Failed to read converted image');
                    }

                    const convertedImage = await this.app.vault.readBinary(finalImageFile);
                    return `data:image/png;base64,${Buffer.from(convertedImage).toString('base64')}`;
                } catch (error) {
                    throw error;
                }
            } else {
                // For raw pixel data, convert using our PNG encoder
                const result = await this.convertRawToImage(data, dicomData);

                if (targetPath) {
                    // Extract the base64 data and save it
                    const base64Data = result.replace(/^data:image\/png;base64,/, '');
                    const binaryData = Buffer.from(base64Data, 'base64');

                    // Ensure target directory exists
                    const targetDir = path.dirname(targetPath);
                    const targetDirInVault = this.app.vault.getAbstractFileByPath(targetDir);
                    if (!targetDirInVault) {
                        await this.app.vault.createFolder(targetDir);
                    }

                    // Save the PNG file
                    await this.app.vault.createBinary(targetPath, binaryData);
                }

                return result;
            }
        } catch (error) {
            console.error(`Failed to convert ${file.name}:`, error);
            throw error;
        } finally {
            // Clean up temporary files
            for (const tempPath of tempFiles) {
                try {
                    const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
                    if (tempFile) {
                        await this.app.vault.delete(tempFile);
                    }
                } catch (cleanupError) {
                    console.error(`Failed to clean up temporary file ${tempPath}:`, cleanupError);
                }
            }
        }
    }

    private async runConverter(inputPath: string, outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');

            // Ensure consistent path handling
            const command = `"${this.settings.opjPath}" -i "${inputPath}" -o "${outputPath}"`;

            exec(command, { windowsHide: true }, (error: any, stdout: string, stderr: string) => {
                if (error) {
                    reject(new Error(`OpenJPEG conversion failed: ${error.message}\n${stderr}`));
                    return;
                }

                // Only log stderr if it contains actual error content
                if (stderr && stderr.trim() !== '') {
                    console.error('OpenJPEG stderr:', stderr);
                }

                resolve();
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

            const dicomWindowCenter = dicomData.floatString(DicomTags.WindowCenter) || undefined;
            const dicomWindowWidth = dicomData.floatString(DicomTags.WindowWidth) || undefined;
            const rescaleSlope = dicomData.floatString(DicomTags.RescaleSlope) || 1;
            const rescaleIntercept = dicomData.floatString(DicomTags.RescaleIntercept) || 0;

            // Create a typed array directly from the buffer with proper offset handling
            const dataView = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.length);
            const pixelCount = rows * columns;
            const pixels = new Int16Array(pixelCount); // Always create a new array for consistent handling

            // Read pixels with proper endianness handling
            const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2'; // Everything except Explicit VR Big Endian
            for (let i = 0; i < pixelCount; i++) {
                pixels[i] = dataView.getInt16(i * 2, littleEndian);
            }

            // Calculate window settings if not provided
            let windowCenter = dicomWindowCenter;
            let windowWidth = dicomWindowWidth;

            if (!windowCenter || !windowWidth) {
                // Auto window by scanning min/max values
                let min = Number.MAX_VALUE;
                let max = Number.MIN_VALUE;
                for (let i = 0; i < pixels.length; i++) {
                    const value = pixels[i] * rescaleSlope + rescaleIntercept;
                    min = Math.min(min, value);
                    max = Math.max(max, value);
                }
                windowCenter = (max + min) / 2;
                windowWidth = max - min;
            }

            // Convert 16-bit to 8-bit using window/level
            const lowValue = windowCenter - (windowWidth / 2);
            const highValue = windowCenter + (windowWidth / 2);

            // Create PNG header (IHDR chunk)
            const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            const ihdrChunk = this.createPNGChunk('IHDR', Buffer.from([
                ...this.toBytes(columns, 4),    // Width
                ...this.toBytes(rows, 4),       // Height
                8,                              // Bit depth
                0,                              // Color type (grayscale)
                0,                              // Compression method
                0,                              // Filter method
                0                               // Interlace method
            ]));

            // Create image data with proper filter type handling
            const scanlineLength = columns + 1; // +1 for filter type byte
            const imageData = Buffer.alloc(rows * scanlineLength);

            // Fill image data with normalized pixel values
            let pixelIndex = 0;
            for (let y = 0; y < rows; y++) {
                imageData[y * scanlineLength] = 0; // Filter type 0 (None)
                for (let x = 0; x < columns; x++) {
                    // Apply rescale and window/level transformation
                    const pixelValue = pixels[pixelIndex++] * rescaleSlope + rescaleIntercept;
                    let normalized = (pixelValue - lowValue) / (highValue - lowValue);
                    normalized = Math.max(0, Math.min(1, normalized));

                    // Convert to 8-bit
                    const intensity = Math.round(normalized * 255);
                    imageData[y * scanlineLength + x + 1] = intensity;
                }
            }

            // Compress image data
            const deflate = require('zlib').deflateSync;
            const compressedData = deflate(imageData);
            const idatChunk = this.createPNGChunk('IDAT', compressedData);

            // Create end chunk
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
            console.error(`Error reading DICOM file: ${error}`);
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
}