
// Web Worker for DICOM image decoding
self.importScripts('https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderWebWorker.min.js');
self.importScripts('https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderCodecs.js');

// Initialize the web worker
var config = {
    webWorkerTaskPaths: [],
    taskConfiguration: {
        decodeTask: {
            loadCodecsOnStartup: true,
            initializeCodecsOnStartup: false,
            codecsPath: self.location.origin + '/codecs/cornerstoneWADOImageLoaderCodecs.js',
            usePDFJS: false
        },
    },
};

cornerstoneWADOImageLoaderWebWorker.initialize(config);
