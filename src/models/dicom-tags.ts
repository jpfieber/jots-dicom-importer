// Common DICOM tag mappings
export const DicomTags = {
    // Patient Information
    PatientName: 'x00100010',
    PatientID: 'x00100020',
    PatientBirthDate: 'x00100030',
    PatientSex: 'x00100040',
    PatientAge: 'x00101010',
    PatientWeight: 'x00101030',
    PatientAddress: 'x00101040',

    // Study Information
    StudyDate: 'x00080020',
    StudyTime: 'x00080030',
    StudyDescription: 'x00081030',
    StudyID: 'x00200010',
    AccessionNumber: 'x00080050',
    StudyInstanceUID: 'x0020000d',
    StudyPhysician: 'x00080090',

    // Series Information
    Modality: 'x00080060',
    SeriesDescription: 'x0008103e',
    SeriesNumber: 'x00200011',
    SeriesDate: 'x00080021',
    SeriesTime: 'x00080031',
    SeriesInstanceUID: 'x0020000e',
    Manufacturer: 'x00080070',
    InstitutionName: 'x00080080',
    StationName: 'x00081010',
    DeviceSerialNumber: 'x00181000',
    SoftwareVersions: 'x00181020',
    ProtocolName: 'x00181030',

    // Image Information
    ImageType: 'x00080008',
    SOPClassUID: 'x00080016',
    SOPInstanceUID: 'x00080018',
    SamplesPerPixel: 'x00280002',
    PhotometricInterpretation: 'x00280004',
    Rows: 'x00280010',
    Columns: 'x00280011',
    InstanceNumber: 'x00200013', // Add InstanceNumber tag
    PixelSpacing: 'x00280030',
    BitsAllocated: 'x00280100',
    BitsStored: 'x00280101',
    HighBit: 'x00280102',
    PixelRepresentation: 'x00280103',
    WindowCenter: 'x00281050',
    WindowWidth: 'x00281051',
    RescaleIntercept: 'x00281052',
    RescaleSlope: 'x00281053',
    PixelData: 'x7fe00010',

    // Acquisition Information
    SpecificCharacterSet: 'x00080005',
    AcquisitionDate: 'x00080022',
    AcquisitionTime: 'x00080032',
    ContentDate: 'x00080023',
    ContentTime: 'x00080033',
    ImagePositionPatient: 'x00200032',
    ImageOrientationPatient: 'x00200037',
    FrameOfReferenceUID: 'x00200052',
    PositionReferenceIndicator: 'x00201040',
    SliceLocation: 'x00201041',

    // MR-specific Parameters
    ScanningSequence: 'x00180020',
    SequenceVariant: 'x00180021',
    ScanOptions: 'x00180022',
    MRAcquisitionType: 'x00180023',
    RepetitionTime: 'x00180080',
    EchoTime: 'x00180081',
    ImagingFrequency: 'x00180084',
    TriggerTime: 'x00180082',
    NumberOfAverages: 'x00180083',
    MagneticFieldStrength: 'x00180087',
    SpacingBetweenSlices: 'x00180088',
    EchoTrainLength: 'x00180091',
    PixelBandwidth: 'x00180095',
    DeviceID: 'x00181090',
    ReceiveCoilName: 'x00181250',
    TransmitCoilName: 'x00181251',
    PatientPosition: 'x00185100',

    // Enhanced MR Parameters
    DiffusionBValue: 'x00431039',
    DiffusionGradientOrientation: 'x00431040',
    DiffusionDirection: 'x00431041',
    ImageComments: 'x00204000',

    // Presentation Parameters
    PresentationLUTShape: 'x20500020',

    // GEMS Parameters
    GEImageProcessingHistory: 'x00190010',
    GEImageType: 'x00191009',

    // File Meta Information
    FileMetaInformationGroupLength: 'x00020000',
    MediaStorageSOPClassUID: 'x00020002',
    MediaStorageSOPInstanceUID: 'x00020003',
    TransferSyntaxUID: 'x00020010',
    ImplementationClassUID: 'x00020012',
    ImplementationVersionName: 'x00020013',
    SourceApplicationEntityTitle: 'x00020016',

    // Helper function to get descriptive name from tag
    getDescriptiveName(tag: string): string {
        // First check if we have a direct mapping for this tag
        for (const [key, value] of Object.entries(this)) {
            if (value === tag && typeof value === 'string') {
                return 'dicom_' + key.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
            }
        }

        // For unknown tags, return a generic format with the tag number
        return `dicom_tag_${tag.substring(1)}`;
    }
};