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

            return {
                data: Buffer.from(dicomData.byteArray.buffer, pixelDataElement.dataOffset, pixelDataElement.length),
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

    async convertToImage(file: TFile): Promise<string> {
        try {
            if (!this.settings.opjPath) {
                throw new Error('OpenJPEG path is not configured');
            }

            if (!this.settings.tempDirectory) {
                throw new Error('Temporary directory is not configured');
            }

            // Read DICOM data for metadata
            const arrayBuffer = await this.loadDICOMFile(file);
            const dicomData = this.parseDicomData(arrayBuffer);

            // Create temporary directory if it doesn't exist
            await fs.mkdir(this.settings.tempDirectory, { recursive: true });

            // Extract pixel data
            const uniqueId = Date.now().toString();
            const { data, needsDecompression } = this.extractPixelData(dicomData);

            if (needsDecompression) {
                // For JPEG2000, use OpenJPEG
                const j2kPath = path.join(this.settings.tempDirectory, `${uniqueId}.j2k`);
                const outputPath = path.join(this.settings.tempDirectory, `${uniqueId}.png`);

                await fs.writeFile(j2kPath, data);
                await this.runConverter(j2kPath, outputPath);

                // Read the converted image
                const convertedImage = await fs.readFile(outputPath);
                const base64Image = convertedImage.toString('base64');

                // Clean up temporary files
                await this.cleanup(j2kPath, outputPath);

                // Show success notification
                new Notice(`Successfully converted ${file.name}`);

                return `data:image/png;base64,${base64Image}`;
            } else {
                // For raw pixel data, convert using our PNG encoder
                const result = await this.convertRawToImage(data, dicomData);

                // Show success notification
                new Notice(`Successfully converted ${file.name}`);

                return result;
            }
        } catch (error) {
            console.error(`Failed to convert ${file.name}:`, error);
            throw error;
        }
    }

    private async runConverter(inputPath: string, outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');

            const command = `"${this.settings.opjPath}" -i "${inputPath}" -o "${outputPath}"`;

            exec(command, { windowsHide: true }, (error: any, stdout: string, stderr: string) => {
                if (error) {
                    reject(new Error(`OpenJPEG conversion failed: ${error.message}`));
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
        const columns = dicomData.uint16(DicomTags.Columns) || 0;
        const rows = dicomData.uint16(DicomTags.Rows) || 0;
        const bitsAllocated = dicomData.uint16(DicomTags.BitsAllocated) || 16;
        const pixelRepresentation = dicomData.uint16(DicomTags.PixelRepresentation) || 0;
        const dicomWindowCenter = dicomData.floatString(DicomTags.WindowCenter) || undefined;
        const dicomWindowWidth = dicomData.floatString(DicomTags.WindowWidth) || undefined;
        const rescaleSlope = dicomData.floatString(DicomTags.RescaleSlope) || 1;
        const rescaleIntercept = dicomData.floatString(DicomTags.RescaleIntercept) || 0;

        // Create a typed array based on pixel representation (signed/unsigned)
        const pixels = pixelRepresentation === 1
            ? new Int16Array(pixelData.buffer, pixelData.byteOffset)
            : new Uint16Array(pixelData.buffer, pixelData.byteOffset);

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

        // Create image data
        const scanlineLength = columns + 1; // +1 for filter type byte
        const imageData = Buffer.alloc(rows * scanlineLength);

        // Fill image data with normalized pixel values
        for (let y = 0; y < rows; y++) {
            imageData[y * scanlineLength] = 0; // Filter type 0 (None)
            for (let x = 0; x < columns; x++) {
                const pixelValue = pixels[y * columns + x] * rescaleSlope + rescaleIntercept;

                // Apply window/level
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
                await fs.unlink(filePath);
            } catch (error) {
                console.error(`Failed to clean up file ${filePath}:`, error);
            }
        }
    }

    private async loadDICOMFile(file: TFile): Promise<ArrayBuffer> {
        return await this.app.vault.readBinary(file);
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
            patientId: dataSet.string(DicomTags.PatientID),
            studyDate: dataSet.string(DicomTags.StudyDate),
            modality: dataSet.string(DicomTags.Modality),
            seriesDescription: dataSet.string(DicomTags.SeriesDescription),
        };
    }
}