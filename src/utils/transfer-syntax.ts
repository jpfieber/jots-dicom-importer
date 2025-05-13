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
        outputFormat: 'png',
        args: ['-i', '{input}', '-o', '{output}'],
        tempExtension: 'j2k'
    }],
    // JPEG Lossless, Non-Hierarchical (Process 14)
    ['1.2.840.10008.1.2.4.70', {
        utility: 'magick',  // Use ImageMagick directly for JPEG Lossless
        outputFormat: 'png',
        args: ['{input}', '{output}'],  // Remove 'convert' command in v7
        tempExtension: 'jpg'  // Use .jpg for JPEG Lossless
    }],
    // Add more transfer syntaxes here if needed
    ['default', {
        utility: 'opj_decompress',
        outputFormat: 'png',
        args: ['-i', '{input}', '-o', '{output}'],
        tempExtension: 'j2k'
    }]
]);

export function getDicomConverter(transferSyntaxUID: string): ImageConverter {
    return TransferSyntaxMap.get(transferSyntaxUID) || TransferSyntaxMap.get('default')!;
}