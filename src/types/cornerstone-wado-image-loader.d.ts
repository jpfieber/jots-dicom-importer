declare module 'cornerstone-wado-image-loader' {
    export const external: {
        cornerstone: any;
        dicomParser: any;
    };
    export const wadouri: {
        fileManager: {
            add: (file: Blob) => string;
        };
    };
}