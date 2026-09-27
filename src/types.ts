import dayjs from "dayjs";
import path from "node:path";
import constants from "./constants.ts";

export interface Options {
    src: string[];
    dst: string;
    target: "local" | "sftp";
    keep: number;
    archivePrefix: string;
    debug: boolean;
    sftpHost?: string;
    sftpPort: number;
    sftpUser?: string;
    sftpPassword?: string;
    sftpKey?: string;
}

export class ArchiveDescription {
    public readonly prefix: string;
    public readonly timestamp: string;
    public readonly name: string;

    constructor(prefix: string) {
        this.prefix = path.basename(prefix).replaceAll("\\", "");
        this.timestamp = dayjs().format("YYYYMMDD-HHmmss");
        this.name = `${this.prefix}-${this.timestamp}`;
    }

    public get filename(): string {
        return this.name + constants.fileExtension.complete;
    }

    public get partialFilename(): string {
        return this.name + constants.fileExtension.partial;
    }
}

export interface ArchiveManifest {
    timestamp: string;
    hash: string;
    corruptedFiles: string[];
}
