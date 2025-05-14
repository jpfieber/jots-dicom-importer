import * as path from 'path';

export class PathService {
    private static readonly INVALID_CHARS_REGEX = /[<>:"\/\\|?*\x00-\x1F]/g;
    private static readonly TRAILING_DOTS_SPACES_REGEX = /[. ]+$/;

    static sanitizeFileName(fileName: string): string {
        // Remove dots and spaces from the end of the filename
        let sanitized = fileName.replace(this.TRAILING_DOTS_SPACES_REGEX, '');
        // Replace any other invalid characters
        sanitized = sanitized.replace(this.INVALID_CHARS_REGEX, '_');
        // Ensure we still have a valid filename
        return sanitized || 'unnamed';
    }

    static normalizePath(filePath: string, ensureWindowsLongPath: boolean = false): string {
        let normalized = filePath.replace(/\\/g, '/');

        if (ensureWindowsLongPath && process.platform === 'win32' &&
            normalized.length > 250 && !normalized.startsWith('\\\\?\\')) {
            normalized = `\\\\?\\${normalized}`;
        }

        return normalized;
    }

    static shortenPath(longPath: string): string {
        const ext = path.extname(longPath);
        const dir = path.dirname(longPath);
        const base = path.basename(longPath, ext);

        // If path is too long, truncate the basename while preserving extension
        if (longPath.length >= 260) {
            const maxBaseLength = 260 - (dir.length + ext.length + 1);
            const shortenedBase = base.substring(0, maxBaseLength - 1);
            return path.join(dir, shortenedBase + ext);
        }
        return longPath;
    }

    static joinPath(...parts: string[]): string {
        return parts.join('/').replace(/\/{2,}/g, '/');
    }

    static getRelativePath(from: string, to: string): string {
        const normalizedFrom = this.normalizePath(from);
        const normalizedTo = this.normalizePath(to);

        const fromParts = normalizedFrom.split('/');
        const toParts = normalizedTo.split('/');

        while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
            fromParts.shift();
            toParts.shift();
        }

        const relative = Array(fromParts.length).fill('..').concat(toParts);
        return relative.join('/');
    }
}