import dayjs from "dayjs";
import path from "node:path";

export interface Options {
    src: string[];
    dst: string;
    target: "local" | "sftp";
    keep: number;
    compress?: "zstd" | "gzip";
    compressLevel?: number;
    archivePrefix: string;
    debug: boolean;
    sftpHost?: string;
    sftpPort: number;
    sftpUser?: string;
    sftpPassword?: string;
    sftpKey?: string;
}

export interface CompressionDescription {
    compressor: "zstd" | "gzip";
    level?: number;
}

export class ArchiveDescription {
    public readonly prefix: string;
    public readonly extension: string;
    public readonly compression?: CompressionDescription;

    public readonly filename: string;
    public readonly fullFilename: string;

    constructor(prefix: string, compression?: CompressionDescription) {
        this.prefix = path.basename(prefix).replaceAll("\\", "");

        switch (compression?.compressor) {
            case "zstd":
                this.extension = ".tar.zst";
                break;

            case "gzip":
                this.extension = ".tar.gz";
                break;

            default:
                this.extension = ".tar";
                break;
        }

        this.compression = compression;
        this.filename = `${this.prefix}-${dayjs().format("YYYYMMDD-HHmmss")}`;
        this.fullFilename = this.filename + this.extension;
    }
}

export class Counters {
    public warnings: number = 0;
}
