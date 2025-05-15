export interface ImageConverter {
    utility: string;
    outputFormat: string;
    args: string[];
}

export const TransferSyntaxMap = new Map<string, ImageConverter>([
    // JPEG 2000 Part 1
    ['1.2.840.10008.1.2.4.90', {
        utility: 'opj_decompress',
        outputFormat: 'png',
        args: ['-i', '{input}', '-o', '{output}']
    }],
    // Add more transfer syntaxes here if needed
    ['default', {
        utility: 'opj_decompress',
        outputFormat: 'png',
        args: ['-i', '{input}', '-o', '{output}']
    }]
]);

export function getDicomConverter(transferSyntaxUID: string): ImageConverter {
    return TransferSyntaxMap.get(transferSyntaxUID) || TransferSyntaxMap.get('default')!;
}