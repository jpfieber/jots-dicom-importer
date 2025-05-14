export interface ImageConverter {
    utility: string;
    outputFormat: string;
    args: string[];
    tempExtension: string;  // Add temp extension to handle different input formats
    requiresPipe?: boolean; // Whether the command needs to pipe output through ImageMagick
}

export const TransferSyntaxMap = new Map<string, ImageConverter>([
    // JPEG 2000 Part 1
    ['1.2.840.10008.1.2.4.90', {
        utility: 'opj_decompress',
        outputFormat: 'pgm',
        args: [
            '-i', '{input}',
            '-o', '{output}',
            '-r', '1',          // Use original resolution
            '-l', '40,40,40',   // Lower quality layers for better contrast
            '-p', 'GRAY',       // Force grayscale output
            '-t', '1024,1024',  // Use tile size that matches most medical images
            '-c', '[1,1,0]',    // Use higher precision decoding
            process.platform === 'win32' ? '2>nul' : '2>/dev/null'
        ],
        tempExtension: 'j2k'
    }],
    // JPEG Lossless, Non-Hierarchical (Process 14)
    ['1.2.840.10008.1.2.4.70', {
        utility: 'magick',
        outputFormat: 'png',
        args: ['{input}', '{output}'],
        tempExtension: 'jpg'
    }],
    // Add more transfer syntaxes here if needed
    ['default', {
        utility: 'opj_decompress',
        outputFormat: 'pgm',
        args: [
            '-i', '{input}',
            '-o', '{output}',
            '-r', '1',
            '-l', '40,40,40',
            '-p', 'GRAY',
            '-t', '1024,1024',
            '-c', '[1,1,0]',
            process.platform === 'win32' ? '2>nul' : '2>/dev/null'
        ],
        tempExtension: 'j2k'
    }]
]);

export function getDicomConverter(transferSyntaxUID: string): ImageConverter {
    return TransferSyntaxMap.get(transferSyntaxUID) || TransferSyntaxMap.get('default')!;
}