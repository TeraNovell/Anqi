import dayjs from "dayjs";

export class ArchiveDescription {
    public readonly prefix: string;
    public readonly extension: string;

    public readonly filename: string;
    public readonly fullFilename: string;

    constructor(prefix: string, extension: string) {
        this.prefix = prefix;
        this.extension = extension;

        this.filename = `${this.prefix}-${dayjs().format("YYYYMMDD-HHmmss")}`;
        this.fullFilename = this.filename + this.extension;
    }
}
