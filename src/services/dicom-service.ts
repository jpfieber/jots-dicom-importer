import { TFile, App } from 'obsidian';
import * as cornerstone from 'cornerstone-core';
import dicomParser from 'dicom-parser';
import { DICOMHandlerSettings } from '../settings';
import { DicomTags } from '../models/dicom-tags';

interface CornerstoneImage {
    imageId: string;
    width: number;
    height: number;
    minPixelValue: number;
    maxPixelValue: number;
    slope: number;
    intercept: number;
    windowCenter: number;
    windowWidth: number;
    getPixelData: () => Uint8Array;
    rows: number;
    columns: number;
    color: boolean;
    columnPixelSpacing: number;
    rowPixelSpacing: number;
    sizeInBytes: number;
    getCanvas: () => HTMLCanvasElement;
    getImage: () => HTMLImageElement;
    lut: any;
}

export class DICOMService {
    constructor(
        private app: App,
        private settings: DICOMHandlerSettings
    ) {
        this.initializeCornerstone();
    }

    private initializeCornerstone(): void {
        cornerstone.enable(document.body);
    }

    async convertToImage(file: TFile): Promise<string> {
        try {
            const arrayBuffer = await this.loadDICOMFile(file);
            const dicomData = this.parseDicomData(arrayBuffer);
            const imageData = this.extractPixelData(dicomData);

            const rows = dicomData.uint16(DicomTags.Rows);
            const columns = dicomData.uint16(DicomTags.Columns);

            if (!rows || !columns) {
                throw new Error('Invalid DICOM image dimensions');
            }

            const canvas = document.createElement('canvas');
            canvas.width = columns;
            canvas.height = rows;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
                throw new Error('Could not get canvas context');
            }

            const normalizedData = this.normalizePixelData(imageData, dicomData);
            const imageDataObj = new ImageData(
                new Uint8ClampedArray(normalizedData),
                columns,
                rows
            );

            ctx.putImageData(imageDataObj, 0, 0);
            return canvas.toDataURL(`image/${this.settings.imageFormat}`);
        } catch (error) {
            throw error;
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

    private extractPixelData(dataSet: dicomParser.DataSet): Uint16Array | Uint8Array {
        const pixelDataElement = dataSet.elements[DicomTags.PixelData];
        if (!pixelDataElement) {
            throw new Error('No pixel data found in DICOM file');
        }

        const bitsAllocated = dataSet.uint16(DicomTags.BitsAllocated) || 16;

        if (bitsAllocated === 16) {
            return new Uint16Array(
                dataSet.byteArray.buffer,
                pixelDataElement.dataOffset,
                pixelDataElement.length / 2
            );
        } else {
            return new Uint8Array(
                dataSet.byteArray.buffer,
                pixelDataElement.dataOffset,
                pixelDataElement.length
            );
        }
    }

    private normalizePixelData(pixelData: Uint16Array | Uint8Array, dicomData: dicomParser.DataSet): Uint8ClampedArray {
        const rows = dicomData.uint16(DicomTags.Rows) || 0;
        const columns = dicomData.uint16(DicomTags.Columns) || 0;
        const totalPixels = rows * columns;

        if (totalPixels === 0) {
            throw new Error('Invalid image dimensions');
        }

        const windowCenter = dicomData.floatString(DicomTags.WindowCenter) || 127;
        const windowWidth = dicomData.floatString(DicomTags.WindowWidth) || 256;
        const min = windowCenter - windowWidth / 2;
        const max = windowCenter + windowWidth / 2;

        const normalized = new Uint8ClampedArray(totalPixels * 4);
        const pixelsToProcess = Math.min(totalPixels, pixelData.length);

        for (let i = 0; i < totalPixels; i++) {
            const pixelValue = i < pixelsToProcess ? pixelData[i] : 0;
            const normalized8Bit = Math.round(((pixelValue - min) / (max - min)) * 255);

            const idx = i * 4;
            normalized[idx] = normalized8Bit;     // R
            normalized[idx + 1] = normalized8Bit; // G
            normalized[idx + 2] = normalized8Bit; // B
            normalized[idx + 3] = 255;           // A
        }

        return normalized;
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