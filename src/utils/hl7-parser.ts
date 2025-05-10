interface HL7Segment {
    type: string;
    fields: string[];
}

export class HL7Parser {
    static parseHL7(text: string): HL7Segment[] {
        // Split into segments (each line is a segment)
        const lines = text.split(/[\r\n]+/).filter(line => line.trim().length > 0);
        return lines.map(line => {
            const fields = line.split('|');
            return {
                type: fields[0],
                fields: fields.slice(1) // Remove segment type from fields
            };
        });
    }

    static formatReport(segments: HL7Segment[]): string {
        let report = '';
        let currentSection = '';

        // Define standard SR sections that should always be level 3 headings
        const standardSections = new Set([
            'PROCEDURE',
            'TECHNIQUE',
            'HISTORY',
            'COMPARISONS',
            'FINDINGS',
            'IMPRESSION',
            'UTERUS',  // Common subsection in ultrasound reports
        ]);

        // Process OBX segments which contain the report content
        segments.filter(seg => seg.type === 'OBX').forEach(obx => {
            // OBX field 3 contains the observation identifier
            const observationType = obx.fields[2];
            // OBX field 5 contains the observation value
            const value = obx.fields[4];

            if (!value) return; // Skip empty values

            // Handle different types of observations
            switch (observationType) {
                case '&GDT':
                    // Regular report text
                    const trimmedValue = value.trim();
                    // Check if this is a standard section or appears to be a section header
                    if (standardSections.has(trimmedValue.toUpperCase()) ||
                        (trimmedValue === trimmedValue.toUpperCase() && trimmedValue.length > 3)) {
                        // It's a section header
                        if (currentSection !== trimmedValue) {
                            report += `\n### ${trimmedValue}\n`;
                            currentSection = trimmedValue;
                        }
                    } else if (trimmedValue.includes(':')) {
                        // It's a key-value pair
                        report += `**${trimmedValue.split(':')[0].trim()}:** ${trimmedValue.split(':').slice(1).join(':').trim()}\n`;
                    } else {
                        // Regular content
                        report += trimmedValue + '\n';
                    }
                    break;
                case '&IMP':
                    // Impression/conclusion text
                    if (!report.includes('### IMPRESSION')) {
                        report += '\n### IMPRESSION\n';
                    }
                    report += value.trim() + '\n';
                    break;
            }
        });

        // Add metadata from other segments
        const msh = segments.find(seg => seg.type === 'MSH');
        const pid = segments.find(seg => seg.type === 'PID');
        const obr = segments.find(seg => seg.type === 'OBR');

        if (msh || pid || obr) {
            report += '\n### METADATA\n';

            if (pid) {
                const patientName = pid.fields[4]?.split('^').filter(Boolean).join(' ');
                if (patientName) report += `**Patient:** ${patientName}\n`;

                const dob = pid.fields[6];
                if (dob) {
                    const formattedDOB = `${dob.substring(0, 4)}-${dob.substring(4, 6)}-${dob.substring(6, 8)}`;
                    report += `**DOB:** ${formattedDOB}\n`;
                }
            }

            if (obr) {
                const procedureName = obr.fields[3]?.split('^')[1];
                if (procedureName) report += `**Procedure:** ${procedureName}\n`;

                const orderingProvider = obr.fields[15]?.split('^').slice(1, 3).join(' ');
                if (orderingProvider) report += `**Ordering Provider:** ${orderingProvider}\n`;

                const studyDate = obr.fields[6];
                if (studyDate) {
                    const formattedDate = `${studyDate.substring(0, 4)}-${studyDate.substring(4, 6)}-${studyDate.substring(6, 8)}`;
                    report += `**Study Date:** ${formattedDate}\n`;
                }
            }
        }

        return report.trim();
    }
}