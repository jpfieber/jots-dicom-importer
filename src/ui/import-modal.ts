import { Modal, Setting, Notice } from 'obsidian';
import type DICOMHandlerPlugin from '../main';
import { Progress } from '../models/types';

export class ImportModal extends Modal {
    private plugin: DICOMHandlerPlugin;
    private isCancelled = false;
    private progressBar!: HTMLProgressElement; // Using definite assignment assertion
    private progressText!: HTMLDivElement;     // Using definite assignment assertion
    private cancelButton!: HTMLButtonElement;  // Using definite assignment assertion
    private startButton!: HTMLButtonElement;   // Using definite assignment assertion
    private currentOperation: AbortController | null = null;

    constructor(plugin: DICOMHandlerPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Import DICOM Files' });

        // Source folder display
        new Setting(contentEl)
            .setName('Source Folder')
            .setDesc(this.plugin.settings.sourceFolderPath || 'No folder selected');

        // Destination folder display
        new Setting(contentEl)
            .setName('Destination Folder')
            .setDesc(this.plugin.settings.destinationFolderPath || 'No folder selected');

        // Progress bar container
        const progressContainer = contentEl.createDiv({ cls: 'progress-container' });
        this.progressBar = progressContainer.createEl('progress', {
            attr: { value: '0', max: '100' }
        });
        this.progressBar.style.width = '100%';
        this.progressBar.style.marginTop = '1em';

        // Progress text
        this.progressText = progressContainer.createDiv();
        this.progressText.style.textAlign = 'center';
        this.progressText.style.marginTop = '0.5em';
        this.progressText.setText('Ready to import');

        // Buttons container
        const buttonContainer = contentEl.createDiv({ cls: 'button-container' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        buttonContainer.style.marginTop = '1em';

        // Start button
        this.startButton = buttonContainer.createEl('button', { text: 'Start Import' });
        this.startButton.addEventListener('click', () => this.startImport());

        // Cancel button
        this.cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        this.cancelButton.style.display = 'none';
        this.cancelButton.addEventListener('click', () => this.cancelImport());
    }

    private async startImport() {
        if (!this.plugin.settings.sourceFolderPath || !this.plugin.settings.destinationFolderPath) {
            this.progressText.setText('Please configure source and destination folders in settings');
            return;
        }

        this.isCancelled = false;
        this.currentOperation = new AbortController();
        this.cancelButton.style.display = 'block';
        this.startButton.style.display = 'none';

        try {
            await this.plugin.convertFolder(
                this.plugin.settings.sourceFolderPath,
                this.plugin.settings.destinationFolderPath,
                (progress) => {
                    if (!this.isCancelled) {
                        this.updateProgress(progress);
                    }
                }
            );

            if (!this.isCancelled) {
                setTimeout(() => this.close(), 2000); // Give user time to see completion
            }
        } catch (error) {
            if (this.isCancelled) {
                this.progressText.setText('Import cancelled');
                setTimeout(() => this.close(), 1000);
            } else {
                const message = error instanceof Error ? error.message : 'Unknown error';
                this.progressText.setText(`Error: ${message}`);
                this.startButton.style.display = 'block';
            }
        } finally {
            this.currentOperation = null;
            this.cancelButton.style.display = 'none';
        }
    }

    private cancelImport() {
        if (!this.isCancelled) {
            this.isCancelled = true;
            this.progressText.setText('Cancelling...');
            if (this.currentOperation) {
                this.currentOperation.abort();
            }
            this.startButton.style.display = 'block';
        }
    }

    updateProgress(progress: { percentage: number, message: string }) {
        if (this.isCancelled) return;
        this.progressBar.value = progress.percentage;
        this.progressText.setText(progress.message);
    }

    onClose() {
        if (this.currentOperation) {
            this.cancelImport();
        }
        const { contentEl } = this;
        contentEl.empty();
    }

    onSubmit() {
        try {
            // ...existing code...
        } catch (error) {
            console.error('Error during import:', error);
            new Notice('Error during import. Please check the console for details.');
        }
    }
}