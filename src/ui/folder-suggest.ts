import { AbstractInputSuggest, TFolder, App } from 'obsidian';

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
    private textInputEl: HTMLInputElement;

    constructor(
        app: App,
        textInputEl: HTMLInputElement,
        onSelectCallback?: (folder: TFolder) => void
    ) {
        super(app, textInputEl);
        this.textInputEl = textInputEl;
        if (onSelectCallback) {
            this.onSelect((folder) => {
                onSelectCallback(folder);
            });
        }
    }

    getSuggestions(inputStr: string): TFolder[] {
        const folders: TFolder[] = [];
        const lowerCaseInputStr = inputStr.toLowerCase();

        const checkFolder = (folder: TFolder) => {
            if (folder.path.toLowerCase().contains(lowerCaseInputStr)) {
                folders.push(folder);
            }

            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    checkFolder(child);
                }
            }
        };

        // Start from vault root
        checkFolder(this.app.vault.getRoot());

        return folders;
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path);
    }

    selectSuggestion(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.textInputEl.value = folder.path;
        this.textInputEl.trigger("input");
        this.close();
    }
}