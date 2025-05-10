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
    opjPath: string;
    archiveDicomFiles: boolean;    // Whether to archive original DICOM files
    subdirectoryFormat: string;    // Format string for date-based subdirectories
}

export const DEFAULT_SETTINGS: DICOMHandlerSettings = {
    imageFormat: 'png',
    autoConvert: false,
    sourceFolderPath: '',
    destinationFolderPath: '',
    dicomIdentification: 'extension',
    dicomExtension: 'dcm',
    galleryImageWidth: 150,
    opjPath: '',
    archiveDicomFiles: false,
    subdirectoryFormat: ''  // Empty string means no date-based subdirectories
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

        // OpenJPEG Configuration
        containerEl.createEl('h2', { text: 'OpenJPEG Configuration' });

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

        // DICOM identification settings
        containerEl.createEl('h2', { text: 'DICOM File Identification' });

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


        // Folder Settings
        containerEl.createEl('h2', { text: 'Folder Settings' });

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

        new Setting(containerEl)
            .setName('Subdirectory Format')
            .setDesc('Format string for date-based subdirectories (e.g., "YYYY/YYYY-MM"). Leave empty to disable.')
            .addText(text => text
                .setPlaceholder('YYYY/YYYY-MM')
                .setValue(this.plugin.settings.subdirectoryFormat)
                .onChange(async (value) => {
                    this.plugin.settings.subdirectoryFormat = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Import Behavior' });

        new Setting(containerEl)
            .setName('Archive Original DICOM Files')
            .setDesc('Copy original DICOM files to a DICOM folder within each series')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.archiveDicomFiles)
                .onChange(async (value) => {
                    this.plugin.settings.archiveDicomFiles = value;
                    await this.plugin.saveSettings();
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