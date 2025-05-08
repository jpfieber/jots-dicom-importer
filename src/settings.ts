import { App, PluginSettingTab, Setting, Notice, TFolder } from 'obsidian';
import type DICOMHandlerPlugin from './main';
import { FolderSuggest } from './ui/folder-suggest';
import * as path from 'path';

// Add Electron types
interface OpenDialogReturnValue {
    canceled: boolean;
    filePaths: string[];
}

// @ts-ignore
const electron = require('electron');

export interface DICOMHandlerSettings {
    imageFormat: 'png';  // Always PNG with OpenJPEG
    autoConvert: boolean;
    sourceFolderPath: string;    // External folder with DICOM files
    destinationFolderPath: string; // Vault folder for converted images
    dicomIdentification: 'extension' | 'noExtension';
    dicomExtension: string;
    galleryImageWidth: number;

    // Folder organization settings
    usePatientFolder: boolean;
    useStudyFolder: boolean;
    useSeriesFolder: boolean;

    // Patient folder settings
    includePatientName: boolean;
    includePatientId: boolean;
    includePatientBirthday: boolean;

    // Study folder settings
    includeStudyModality: boolean;
    includeStudyDescription: boolean;
    includeStudyDate: boolean;
    includeStudyId: boolean;

    // Series folder settings
    includeSeriesNumber: boolean;
    includeSeriesDescription: boolean;
    includeSeriesDate: boolean;

    // OpenJPEG Settings
    opjPath: string;
    tempDirectory: string;  // Directory for temporary processing files
}

export const DEFAULT_SETTINGS: DICOMHandlerSettings = {
    imageFormat: 'png',
    autoConvert: false,
    sourceFolderPath: '',
    destinationFolderPath: '',
    dicomIdentification: 'extension',
    dicomExtension: 'dcm',
    galleryImageWidth: 150,

    // Folder organization defaults
    usePatientFolder: false,
    useStudyFolder: false,
    useSeriesFolder: false,

    // Patient folder defaults
    includePatientName: true,
    includePatientId: true,
    includePatientBirthday: false,

    // Study folder defaults
    includeStudyModality: true,
    includeStudyDescription: true,
    includeStudyDate: true,
    includeStudyId: true,

    // Series folder defaults
    includeSeriesNumber: true,
    includeSeriesDescription: true,
    includeSeriesDate: false,

    // OpenJPEG defaults
    opjPath: '',
    tempDirectory: ''
};

export class DICOMHandlerSettingsTab extends PluginSettingTab {
    plugin: DICOMHandlerPlugin;

    constructor(app: App, plugin: DICOMHandlerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'DICOM Handler Settings' });

        // OpenJPEG Configuration
        containerEl.createEl('h3', { text: 'OpenJPEG Configuration' });

        new Setting(containerEl)
            .setName('opj_decompress Path')
            .setDesc('Path to opj_decompress executable from OpenJPEG')
            .addText(text => text
                .setPlaceholder('C:\\OpenJPEG\\bin\\opj_decompress.exe')
                .setValue(this.plugin.settings.opjPath)
                .onChange(async (value) => {
                    // Convert any forward slashes to backslashes for Windows
                    const normalizedPath = value.replace(/\//g, '\\');
                    this.plugin.settings.opjPath = normalizedPath;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Temporary Directory')
            .setDesc('Directory for temporary processing files')
            .addText(text => text
                .setPlaceholder('C:\\temp\\dicom-work')
                .setValue(this.plugin.settings.tempDirectory)
                .onChange(async (value) => {
                    // Convert any forward slashes to backslashes for Windows
                    const normalizedPath = value.replace(/\//g, '\\');
                    this.plugin.settings.tempDirectory = normalizedPath;
                    await this.plugin.saveSettings();
                }));

        // Folder Settings
        containerEl.createEl('h3', { text: 'Folder Settings' });

        new Setting(containerEl)
            .setName('Source Folder')
            .setDesc('Select the folder containing DICOM files (outside your vault)')
            .addText(text => text
                .setPlaceholder('C:\\DICOM\\input')
                .setValue(this.plugin.settings.sourceFolderPath)
                .onChange(async (value) => {
                    // Convert any forward slashes to backslashes for Windows
                    const normalizedPath = value.replace(/\//g, '\\');
                    this.plugin.settings.sourceFolderPath = normalizedPath;
                    await this.plugin.saveSettings();
                }))
            .addButton(button => 
                button
                    .setButtonText('Browse...')
                    .onClick(() => {
                        // @ts-ignore
                        const { dialog } = require('electron').remote;
                        dialog.showOpenDialog({
                            properties: ['openDirectory']
                        }).then(async (result: OpenDialogReturnValue) => {
                            if (!result.canceled && result.filePaths.length > 0) {
                                const folderPath = result.filePaths[0];
                                this.plugin.settings.sourceFolderPath = folderPath;
                                await this.plugin.saveSettings();
                                this.display(); // Refresh display
                            }
                        });
                    }));

        new Setting(containerEl)
            .setName('Destination Folder')
            .setDesc('Select where to save converted images (in your vault)')
            .addText(text => {
                text.setValue(this.plugin.settings.destinationFolderPath)
                    .onChange(async (value) => {
                        this.plugin.settings.destinationFolderPath = value;
                        await this.plugin.saveSettings();
                    });

                // Initialize folder suggester for destination (vault folders only)
                new FolderSuggest(
                    this.app,
                    text.inputEl,
                    async (folder: TFolder) => {
                        this.plugin.settings.destinationFolderPath = folder.path;
                        await this.plugin.saveSettings();
                    }
                );

                return text;
            });

        // DICOM identification settings
        containerEl.createEl('h3', { text: 'DICOM File Identification' });

        new Setting(containerEl)
            .setName('Identification Method')
            .setDesc('Choose how to identify DICOM files')
            .addDropdown(dropdown => dropdown
                .addOption('extension', 'By File Extension')
                .addOption('noExtension', 'Files Without Extension')
                .setValue(this.plugin.settings.dicomIdentification)
                .onChange(async (value) => {
                    this.plugin.settings.dicomIdentification = value as 'extension' | 'noExtension';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('DICOM Extension')
            .setDesc('File extension to identify DICOM files (when using extension method)')
            .addText(text => text
                .setPlaceholder('dcm')
                .setValue(this.plugin.settings.dicomExtension)
                .onChange(async (value) => {
                    this.plugin.settings.dicomExtension = value;
                    await this.plugin.saveSettings();
                }))
            .setDisabled(this.plugin.settings.dicomIdentification === 'noExtension');

        // Folder Organization Settings
        containerEl.createEl('h3', { text: 'Folder Organization' });

        // Patient Folder Settings
        const patientFolderSetting = new Setting(containerEl)
            .setName('Use Patient Folders')
            .setDesc('Organize files in patient-specific folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.usePatientFolder)
                .onChange(async (value) => {
                    this.plugin.settings.usePatientFolder = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide nested settings
                }));

        if (this.plugin.settings.usePatientFolder) {
            const patientContainer = containerEl.createDiv('settings-indent');
            new Setting(patientContainer)
                .setName('Include Patient Name')
                .setDesc('Include patient name in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includePatientName)
                    .onChange(async (value) => {
                        this.plugin.settings.includePatientName = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(patientContainer)
                .setName('Include Patient ID')
                .setDesc('Include patient ID in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includePatientId)
                    .onChange(async (value) => {
                        this.plugin.settings.includePatientId = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(patientContainer)
                .setName('Include Patient Birthday')
                .setDesc('Include patient birthday in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includePatientBirthday)
                    .onChange(async (value) => {
                        this.plugin.settings.includePatientBirthday = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // Study Folder Settings
        const studyFolderSetting = new Setting(containerEl)
            .setName('Use Study Folders')
            .setDesc('Organize files in study-specific folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useStudyFolder)
                .onChange(async (value) => {
                    this.plugin.settings.useStudyFolder = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide nested settings
                }));

        if (this.plugin.settings.useStudyFolder) {
            const studyContainer = containerEl.createDiv('settings-indent');
            new Setting(studyContainer)
                .setName('Include Study Modality')
                .setDesc('Include modality in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includeStudyModality)
                    .onChange(async (value) => {
                        this.plugin.settings.includeStudyModality = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(studyContainer)
                .setName('Include Study Description')
                .setDesc('Include study description in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includeStudyDescription)
                    .onChange(async (value) => {
                        this.plugin.settings.includeStudyDescription = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(studyContainer)
                .setName('Include Study Date')
                .setDesc('Include study date in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includeStudyDate)
                    .onChange(async (value) => {
                        this.plugin.settings.includeStudyDate = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(studyContainer)
                .setName('Include Study ID')
                .setDesc('Include study ID in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includeStudyId)
                    .onChange(async (value) => {
                        this.plugin.settings.includeStudyId = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // Series Folder Settings
        const seriesFolderSetting = new Setting(containerEl)
            .setName('Use Series Folders')
            .setDesc('Organize files in series-specific folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useSeriesFolder)
                .onChange(async (value) => {
                    this.plugin.settings.useSeriesFolder = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide nested settings
                }));

        if (this.plugin.settings.useSeriesFolder) {
            const seriesContainer = containerEl.createDiv('settings-indent');
            new Setting(seriesContainer)
                .setName('Include Series Number')
                .setDesc('Include series number in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includeSeriesNumber)
                    .onChange(async (value) => {
                        this.plugin.settings.includeSeriesNumber = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(seriesContainer)
                .setName('Include Series Description')
                .setDesc('Include series description in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includeSeriesDescription)
                    .onChange(async (value) => {
                        this.plugin.settings.includeSeriesDescription = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(seriesContainer)
                .setName('Include Series Date')
                .setDesc('Include series date in folder name')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.includeSeriesDate)
                    .onChange(async (value) => {
                        this.plugin.settings.includeSeriesDate = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // Add folder conversion section
        containerEl.createEl('h3', { text: 'Bulk Import' });

        new Setting(containerEl)
            .setName('Import Files')
            .setDesc('Start importing all DICOM files from source to destination folder')
            .addButton(button => button
                .setButtonText('Import All')
                .onClick(async () => {
                    if (!this.plugin.settings.sourceFolderPath) {
                        new Notice('Please select a source folder first');
                        return;
                    }
                    if (!this.plugin.settings.destinationFolderPath) {
                        new Notice('Please select a destination folder first');
                        return;
                    }
                    await this.plugin.convertFolder(
                        this.plugin.settings.sourceFolderPath,
                        this.plugin.settings.destinationFolderPath
                    );
                }));

        containerEl.createEl('h3', { text: 'Display Settings' });

        new Setting(containerEl)
            .setName('Gallery Image Width')
            .setDesc('Set the width in pixels for images in the gallery (default: 150)')
            .addText(text => text
                .setValue(String(this.plugin.settings.galleryImageWidth))
                .onChange(async (value) => {
                    const width = parseInt(value);
                    if (!isNaN(width) && width > 0) {
                        this.plugin.settings.galleryImageWidth = width;
                        await this.plugin.saveSettings();
                    }
                }));
    }
}