import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import SftpClient from "ssh2-sftp-client";
import packageJson from "../package.json" with { type: "json" };
import { createLocalArchive, createSftpArchive } from "./archiver.ts";
import { ArchiveDescription } from "./types.ts";
import { generateHelp } from "./utils.ts";

const options = {
    help: {
        type: "boolean",
        short: "h",
    },
    version: {
        type: "boolean",
        short: "v",
    },
    src: {
        type: "string",
        short: "s",
        multiple: true,
        description:
            "Path or glob pattern of a file or directory to back up (repeatable)",
    },
    dst: {
        type: "string",
        short: "d",
        description:
            "Destination directory path where the backup archive will be stored",
    },
    target: {
        type: "string",
        short: "t",
        description: "Backup destination type (default: local)",
    },
    keep: {
        type: "string",
        short: "k",
        description:
            "Number of most recent backups to retain (older archives are deleted)",
    },
    compress: {
        type: "boolean",
        short: "c",
    },
    "archive-prefix": {
        type: "string",
        description:
            "Prefix for the generated archive filename (default: archive)",
    },
    "sftp-host": {
        type: "string",
        description:
            "Hostname or IP address of the SFTP server (required for SFTP target)",
    },
    "sftp-port": {
        type: "string",
        description: "Port number of the SFTP server (default: 22)",
    },
    "sftp-user": {
        type: "string",
        description:
            "Username for SFTP authentication (required for SFTP target)",
    },
    "sftp-password": {
        type: "string",
        description: "Password for SFTP authentication",
    },
    "sftp-key": {
        type: "string",
        description: "Path to private SSH key file for SFTP authentication",
    },
} as const;

const { values } = parseArgs({
    options,
    allowPositionals: true,
});

if (values?.help || Object.keys(values).length === 0) {
    console.log(generateHelp(options, "Anqi - A really simple backup tool"));
    process.exit(0);
}

if (values?.version) {
    console.log(packageJson.version);
    process.exit(0);
}

const keep = Number.parseInt(values.keep ?? "");
if (keep < 0) throw new Error("Keep value must be a positive integer!");

const compress = values?.compress ?? false;

const archiveDescription = new ArchiveDescription(
    values["archive-prefix"] ?? "archive",
    compress ? ".tar.gz" : ".tar",
);

if (!values.src || !values.dst)
    throw new Error(
        "At least one source and one destination need to be specified!",
    );

const start = performance.now();

if (values.target === "local") {
    await createLocalArchive(
        values.src,
        values.dst,
        archiveDescription,
        compress,
        keep,
    );
}

if (values.target === "sftp") {
    if (!values["sftp-host"] || !values["sftp-user"])
        throw new Error(
            "Host and username need to be specified for an sftp connection!",
        );

    let port = Number.parseInt(values["sftp-port"] ?? "");
    if (!port) port = 22;

    const options: SftpClient.ConnectOptions = {
        host: values["sftp-host"],
        port,
        username: values["sftp-user"],
    };

    const password = values["sftp-password"];
    const sftpKey = values["sftp-key"];
    if (sftpKey) {
        options.privateKey = readFileSync(sftpKey);
    } else if (password) {
        options.password = password;
    }

    await createSftpArchive(
        values.src,
        values.dst,
        archiveDescription,
        compress,
        keep,
        options,
    );
}

console.log(`Took ${(performance.now() - start)?.toFixed(2)} ms`);
