import { PluginSettingTab, App, Setting } from 'obsidian';

export class DICOMHandlerSettingsTab extends PluginSettingTab {
    private plugin: any;

    constructor(app: App, plugin: any) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl('h2', { text: 'DICOM Handler Settings' });

        new Setting(containerEl)
            .setName('Setting 1')
            .setDesc('Description for setting 1')
            .addText(text => text
                .setPlaceholder('Enter value...')
                .setValue(this.plugin.settings.setting1)
                .onChange(async (value) => {
                    this.plugin.settings.setting1 = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Setting 2')
            .setDesc('Description for setting 2')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.setting2)
                .onChange(async (value) => {
                    this.plugin.settings.setting2 = value;
                    await this.plugin.saveSettings();
                }));
    }
}