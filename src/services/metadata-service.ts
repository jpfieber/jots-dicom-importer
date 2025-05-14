import { App, TFile, TFolder } from 'obsidian';
import { DicomTags } from '../models/dicom-tags';
import { DicomModalities } from '../models/dicom-modalities';
import { HL7Parser } from '../utils/hl7-parser';
import { PathService } from './path-service';
import { DICOMHandlerSettings } from '../settings';
import * as path from 'path';
import dicomParser from 'dicom-parser';

export class MetadataService {
    constructor(
        private app: App,
        private settings: DICOMHandlerSettings
    ) { }

    private isLikelyName(str: string): boolean {
        str = str.trim();
        if (!/[a-zA-Z]/.test(str)) {
            return false;
        }
        if (/^[\d\s.,/-]+$/.test(str)) {
            return false;
        }
        return true;
    }

    private formatName(name: string): string {
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

    private looksLikeBinaryData(str: string | undefined): boolean {
        if (!str) return false;

        let nonPrintable = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code < 32 || (code > 126 && code < 160)) {
                nonPrintable++;
            }
        }

        if (nonPrintable / str.length > 0.15) {
            return true;
        }

        if (str.length > 100 && !str.includes(' ')) {
            return true;
        }

        return false;
    }

    public async createMetadataNote(dataset: dicomParser.DataSet, folderPath: string): Promise<void> {
        try {
            const sopClassUID = dataset.string(DicomTags.SOPClassUID);
            const isStructuredReport = sopClassUID === '1.2.840.10008.5.1.4.1.1.88.11' ||
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.22' ||
                sopClassUID === '1.2.840.10008.5.1.4.1.1.88.33';

            const elements = dataset.elements;
            const metadata: Record<string, any> = {};
            const tagsToSkip = new Set([
                DicomTags.PixelData,
                'x7fe00010',
                'x00880200',
                'x00880904',
                'x00880906',
                'x00880910',
                'x00880912',
            ]);

            for (const tag in elements) {
                try {
                    if (tagsToSkip.has(tag)) continue;

                    const element = elements[tag];
                    if (!element || element.length > 128) continue;

                    let value;
                    if (element.vr === 'DS' || element.vr === 'FL' || element.vr === 'FD') {
                        value = dataset.floatString(tag);
                        if (typeof value === 'number' && isNaN(value)) continue;
                    } else if (element.vr === 'IS' || element.vr === 'SL' || element.vr === 'SS' || element.vr === 'UL' || element.vr === 'US') {
                        value = dataset.uint16(tag);
                    } else if (element.vr === 'OB' || element.vr === 'OW' || element.vr === 'UN') {
                        continue;
                    } else {
                        value = dataset.string(tag);
                        if (this.looksLikeBinaryData(value)) continue;
                    }

                    if (value !== undefined && value !== null && value !== '') {
                        if (tag === 'x00232080') {
                            try {
                                const stringValue = String(value);
                                const segments = HL7Parser.parseHL7(stringValue);
                                const formattedReport = HL7Parser.formatReport(segments);
                                if (formattedReport) {
                                    metadata['__structuredContent'] = formattedReport;
                                }
                                continue;
                            } catch (e) { }
                        }

                        const descriptiveName = DicomTags.getDescriptiveName(tag);
                        metadata[descriptiveName] = value;
                    }
                } catch (e) { }
            }

            let content = '---\n';
            const sortedKeys = Object.keys(metadata).sort();

            for (const key of sortedKeys) {
                const value = metadata[key];
                if (value === undefined || value === null || key === '__structuredContent') continue;

                if (typeof value === 'string') {
                    const escapedValue = value
                        .replace(/\\/g, '\\\\')
                        .replace(/"/g, '\\"')
                        .replace(/\n/g, ' ')
                        .replace(/\r/g, '');
                    content += `${key}: "${escapedValue}"\n`;
                }
                else if (typeof value === 'number' && !isNaN(value)) {
                    content += `${key}: ${value}\n`;
                }
                else if (typeof value === 'boolean') {
                    content += `${key}: ${value}\n`;
                }
            }
            content += '---\n\n';

            const seriesDesc = dataset.string(DicomTags.SeriesDescription) || 'DICOM Series';
            const studyDate = dataset.string(DicomTags.StudyDate) || '';
            const titleDate = studyDate ? `${studyDate} - ` : '';

            content += `# ${titleDate}${seriesDesc}\n\n`;
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

            if (isStructuredReport) {
                const completionFlag = dataset.string(DicomTags.CompletionFlag);
                const verificationFlag = dataset.string(DicomTags.VerificationFlag);
                if (completionFlag) content += `**Report Status:** ${completionFlag}\n`;
                if (verificationFlag) content += `**Verification Status:** ${verificationFlag}\n`;
            }
            content += '\n';

            if (isStructuredReport) {
                content += `## Report Content\n\n`;
                if (metadata['__structuredContent']) {
                    content += metadata['__structuredContent'] + '\n\n';
                } else {
                    const reportText = dataset.string(DicomTags.DocumentContent) ||
                        dataset.string(DicomTags.TextValue) ||
                        dataset.string(DicomTags.DocumentTitle) ||
                        dataset.string(DicomTags.ProcedureDescription);

                    if (reportText) {
                        content += reportText.replace(/\\n/g, '\n') + '\n\n';
                    }
                }
            }

            if (!isStructuredReport) {
                const seriesName = folderPath.split('/').pop() || 'series';
                const gifPath = path.join(folderPath, `${seriesName}.gif`).replace(/\\/g, '/');
                const gifFile = this.app.vault.getAbstractFileByPath(gifPath);

                if (gifFile instanceof TFile) {
                    content += `## Animation\n\n`;
                    content += `![[${gifFile.name}]]\n\n`;
                }

                const imagesPath = `${folderPath}/Images`.replace(/\\/g, '/');
                const imagesFolder = this.app.vault.getAbstractFileByPath(imagesPath);

                if (imagesFolder instanceof TFolder) {
                    const imageFiles = imagesFolder.children
                        .filter(file => file instanceof TFile && file.extension === 'png')
                        .sort((a, b) => {
                            // Extract numbers from filenames for numeric sorting
                            const aNum = parseInt((a.name.match(/\d+/) || ['0'])[0]);
                            const bNum = parseInt((b.name.match(/\d+/) || ['0'])[0]);
                            return aNum - bNum;
                        });

                    if (imageFiles.length > 0) {
                        content += `## Gallery\n\n`;
                        let lineContent = '';
                        const width = this.settings.galleryImageWidth || 150;

                        imageFiles.forEach((file, index) => {
                            lineContent += `![[${file.name}|${width}]]`;
                            // Add a newline every 4 images for better layout
                            if ((index + 1) % 4 === 0 || index === imageFiles.length - 1) {
                                content += lineContent + '\n';
                                lineContent = '';
                            } else {
                                lineContent += ' ';
                            }
                        });
                        if (lineContent) {
                            content += lineContent + '\n';
                        }
                        content += '\n';
                    }
                }
            }

            const folderName = folderPath.split('/').pop() || 'series';
            const sanitizedFolderName = folderName.replace(/^\d{8}\s*-\s*/, '');
            const notePath = path.join(
                folderPath,
                `${studyDate ? studyDate + ' - ' : ''}${sanitizedFolderName}.md`
            ).replace(/\\/g, '/');

            const parentFolder = this.app.vault.getAbstractFileByPath(folderPath.replace(/\\/g, '/'));
            if (!parentFolder) {
                await this.app.vault.createFolder(folderPath.replace(/\\/g, '/'));
            }

            // Check if file exists first
            const existingFile = this.app.vault.getAbstractFileByPath(notePath);
            if (existingFile instanceof TFile) {
                // Update existing file instead of throwing error
                await this.app.vault.modify(existingFile, content);
            } else {
                await this.app.vault.create(notePath, content);
            }
        } catch (error) {
            console.error('Error creating metadata note:', error);
            throw error;
        }
    }

    public async createStudyMetadataNote(studyInstanceUID: string, studyData: {
        dicomData: dicomParser.DataSet,
        seriesPaths: string[]
    }): Promise<void> {
        try {
            const dicomData = studyData.dicomData;
            const seriesPaths = studyData.seriesPaths;
            const studyPath = path.dirname(seriesPaths[0]);

            let content = '---\n';
            content += `study_instance_uid: "${studyInstanceUID}"\n`;
            if (dicomData.string(DicomTags.StudyDate)) content += `study_date: "${dicomData.string(DicomTags.StudyDate)}"\n`;
            if (dicomData.string(DicomTags.StudyDescription)) content += `study_description: "${dicomData.string(DicomTags.StudyDescription)}"\n`;
            const patientNameStr = dicomData.string(DicomTags.PatientName);
            if (patientNameStr) content += `patient_name: "${this.formatName(patientNameStr)}"\n`;
            if (dicomData.string(DicomTags.PatientID)) content += `patient_id: "${dicomData.string(DicomTags.PatientID)}"\n`;
            if (dicomData.string(DicomTags.AccessionNumber)) content += `accession_number: "${dicomData.string(DicomTags.AccessionNumber)}"\n`;
            content += '---\n\n';

            const studyDate = dicomData.string(DicomTags.StudyDate) || '';
            const studyDesc = dicomData.string(DicomTags.StudyDescription) || 'Study';
            content += `# ${studyDate} - ${studyDesc}\n\n`;

            content += '## Patient Information\n\n';
            const patientName = dicomData.string(DicomTags.PatientName);
            if (patientName) content += `**Patient Name:** ${this.formatName(patientName)}\n`;
            if (dicomData.string(DicomTags.InstitutionName)) content += `**Imaging Site:** ${dicomData.string(DicomTags.InstitutionName)}\n`;
            const studyPhysician = dicomData.string(DicomTags.StudyPhysician);
            if (studyPhysician && this.isLikelyName(studyPhysician)) {
                content += `**Study Physician:** ${this.formatName(studyPhysician)}\n`;
            }
            content += '\n';

            content += '## Series\n\n';
            for (const seriesPath of seriesPaths) {
                const seriesFiles = (await this.app.vault.adapter.list(seriesPath))
                    .files.filter(f => f.endsWith('.md'));

                for (const seriesFile of seriesFiles) {
                    const relPath = path.relative(studyPath, seriesFile).replace(/\\/g, '/');
                    content += `- [[${relPath}|${path.basename(seriesFile, '.md')}]]\n`;
                }
            }

            const studyFileName = `${studyDate} - Study.md`;
            const studyFilePath = path.join(studyPath, studyFileName).replace(/\\/g, '/');
            await this.app.vault.create(studyFilePath, content);

        } catch (error) {
            console.error('Error creating study metadata note:', error);
            throw error;
        }
    }
}