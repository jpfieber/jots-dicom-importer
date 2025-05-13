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
    imageFormat: 'png';  // Always PNG output
    autoConvert: boolean;
    sourceFolderPath: string;    // External folder with DICOM files
    destinationFolderPath: string; // Vault folder for converted images
    dicomIdentification: 'extension' | 'noExtension';
    dicomExtension: string;
    galleryImageWidth: number;
    opjPath: string;             // OpenJPEG path for JPEG 2000
    magickPath: string;          // ImageMagick path for JPEG Lossless and other formats
    archiveDicomFiles: boolean;    // Whether to archive original DICOM files
    subdirectoryFormat: string;    // Format string for date-based subdirectories
    // Animation settings
    createAnimatedGif: boolean;    // Enable/disable GIF creation
    imagemagickPath: string;       // Path to ImageMagick executable (same as magickPath)
    minImagesForGif: number;       // Minimum number of images required for GIF
    gifFrameDelay: number;         // Delay between frames in milliseconds
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
    magickPath: '',              // ImageMagick path for JPEG Lossless
    archiveDicomFiles: false,
    subdirectoryFormat: '',      // Empty string means no date-based subdirectories
    // Animation settings defaults
    createAnimatedGif: false,
    imagemagickPath: '',         // Will be synced with magickPath
    minImagesForGif: 5,
    gifFrameDelay: 250
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
        containerEl.createEl('h2', { text: 'DICOM Image Converters' });

        new Setting(containerEl)
            .setName('OpenJPEG Path')
            .setDesc('Path to opj_decompress executable for JPEG 2000 DICOM images')
            .addText(text => text
                .setPlaceholder('C:\\OpenJPEG\\bin\\opj_decompress.exe')
                .setValue(this.plugin.settings.opjPath)
                .onChange(async (value) => {
                    const normalizedPath = value.replace(/\//g, '\\');
                    this.plugin.settings.opjPath = normalizedPath;
                    await this.plugin.saveSettings();
                }))
            .addButton(button =>
                button
                    .setButtonText('Browse...')
                    .onClick(() => {
                        // @ts-ignore
                        const { dialog } = require('electron').remote;
                        dialog.showOpenDialog({
                            properties: ['openFile'],
                            filters: [
                                { name: 'Executable', extensions: ['exe'] }
                            ]
                        }).then(async (result: OpenDialogReturnValue) => {
                            if (!result.canceled && result.filePaths.length > 0) {
                                const exePath = result.filePaths[0];
                                this.plugin.settings.opjPath = exePath;
                                await this.plugin.saveSettings();
                                this.display();
                            }
                        });
                    }));

        new Setting(containerEl)
            .setName('ImageMagick Path')
            .setDesc('Path to ImageMagick convert executable (required for JPEG Lossless conversion)')
            .addText(text => text
                .setPlaceholder('C:\\Program Files\\ImageMagick\\magick.exe')
                .setValue(this.plugin.settings.magickPath)
                .onChange(async (value) => {
                    const normalizedPath = value.replace(/\//g, '\\');
                    this.plugin.settings.magickPath = normalizedPath;
                    await this.plugin.saveSettings();
                }))
            .addButton(button =>
                button
                    .setButtonText('Browse...')
                    .onClick(() => {
                        // @ts-ignore
                        const { dialog } = require('electron').remote;
                        dialog.showOpenDialog({
                            properties: ['openFile'],
                            filters: [
                                { name: 'Executable', extensions: ['exe'] }
                            ]
                        }).then(async (result: OpenDialogReturnValue) => {
                            if (!result.canceled && result.filePaths.length > 0) {
                                const exePath = result.filePaths[0];
                                this.plugin.settings.magickPath = exePath;
                                await this.plugin.saveSettings();
                                this.display();
                            }
                        });
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
                    // Refresh the display to update dependent settings
                    this.display();
                }));

        const dicomExtensionSetting = new Setting(containerEl)
            .setName('DICOM Extension')
            .setDesc('File extension to identify DICOM files (when using extension method)')
            .addText(text => text
                .setPlaceholder('dcm')
                .setValue(this.plugin.settings.dicomExtension)
                .onChange(async (value) => {
                    this.plugin.settings.dicomExtension = value;
                    await this.plugin.saveSettings();
                }));

        // Set disabled state based on current identification method
        if (this.plugin.settings.dicomIdentification === 'noExtension') {
            dicomExtensionSetting.setDisabled(true);
        }

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

        containerEl.createEl('h2', { text: 'Animation Settings' });

        new Setting(containerEl)
            .setName('Create Animated GIFs')
            .setDesc('Enable creation of animated GIFs from DICOM series')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createAnimatedGif)
                .onChange(async (value) => {
                    this.plugin.settings.createAnimatedGif = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide dependent settings
                }));

        // Create a container for animation-dependent settings
        const animationSettingsContainer = containerEl.createDiv();
        animationSettingsContainer.style.display = this.plugin.settings.createAnimatedGif ? 'block' : 'none';

        new Setting(animationSettingsContainer)
            .setName('ImageMagick Path')
            .setDesc('Path to ImageMagick convert executable')
            .addText(text => text
                .setPlaceholder('C:\\Program Files\\ImageMagick\\magick.exe')
                .setValue(this.plugin.settings.imagemagickPath)
                .onChange(async (value) => {
                    const normalizedPath = value.replace(/\//g, '\\');
                    this.plugin.settings.imagemagickPath = normalizedPath;
                    await this.plugin.saveSettings();
                }))
            .addButton(button =>
                button
                    .setButtonText('Browse...')
                    .onClick(() => {
                        // @ts-ignore
                        const { dialog } = require('electron').remote;
                        dialog.showOpenDialog({
                            properties: ['openFile'],
                            filters: [
                                { name: 'Executable', extensions: ['exe'] }
                            ]
                        }).then(async (result: OpenDialogReturnValue) => {
                            if (!result.canceled && result.filePaths.length > 0) {
                                const exePath = result.filePaths[0];
                                this.plugin.settings.imagemagickPath = exePath;
                                await this.plugin.saveSettings();
                                this.display();
                            }
                        });
                    }));

        new Setting(animationSettingsContainer)
            .setName('Minimum Images for GIF')
            .setDesc('Minimum number of images required to create an animated GIF')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.minImagesForGif))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.minImagesForGif = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(animationSettingsContainer)
            .setName('Frame Delay')
            .setDesc('Delay between frames in milliseconds (1000 = 1 second)')
            .addText(text => text
                .setPlaceholder('250')
                .setValue(String(this.plugin.settings.gifFrameDelay))
                .onChange(async (value) => {
                    const delay = parseInt(value);
                    if (!isNaN(delay) && delay > 0) {
                        this.plugin.settings.gifFrameDelay = delay;
                        await this.plugin.saveSettings();
                    }
                }));
    }
}