#!/usr/bin/env node

import { InvalidArgumentError, Option, program } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import { createLocalArchive, createSftpArchive } from "./archiver.ts";
import { logError, setDebug } from "./log/logger.ts";
import msg from "./log/messages.ts";
import { ArchiveDescription, Options } from "./types.ts";

const packageJson: { version: string } = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
);

program
    .name("anqi")
    .description("Anqi - A really simple backup tool")
    .version(packageJson.version, "-v, --version")
    .requiredOption(
        "-s, --src <path>",
        "Path or glob pattern of a file or directory to back up (repeatable)",
        (value: string, previous: string[] = []) => {
            return [...previous, value];
        },
    )
    .requiredOption("-d, --dst <path>", "Destination directory path where the backup archive will be stored")
    .addOption(new Option("-t, --target <type>", "Backup destination type").choices(["local", "sftp"]).default("local"))
    .option(
        "-k, --keep <count>",
        "Number of most recent backups to retain. Older archives are deleted",
        (value: string) => {
            const keep = Number.parseInt(value, 10);
            if (Number.isNaN(keep) || keep < 0) {
                throw new InvalidArgumentError("Keep value must be a non-negative integer!");
            }
            return keep;
        },
        0,
    )
    .addOption(new Option("-c, --compress <type>", "Compress the backup archive").choices(["zstd", "gzip"]))
    .option("--compress-level <level>", "Override compression level", (value: string) => {
        const level = Number.parseInt(value, 10);
        if (Number.isNaN(level) || level <= 0) {
            throw new InvalidArgumentError("Compress level must be a positive integer!");
        }

        return level;
    })
    .option("--archive-prefix <prefix>", "Prefix for the generated archive filename", "archive")
    .option("--debug", "Enable verbose debug logging", false)
    .optionsGroup("SFTP target options:")
    .option("--sftp-host <host>", "Hostname or IP address of the SFTP server")
    .option(
        "--sftp-port <port>",
        "Port number of the SFTP server",
        (value: string) => {
            const port = Number.parseInt(value, 10);
            if (Number.isNaN(port) || port <= 0 || port > 65535) {
                throw new InvalidArgumentError("Port must be a valid port number (1-65535)!");
            }
            return port;
        },
        22,
    )
    .addOption(new Option("--sftp-user <user>", "Username for SFTP authentication").env("ANQI_SFTP_USERNAME"))
    .addOption(new Option("--sftp-password <password>", "Password for SFTP authentication").env("ANQI_SFTP_PASSWORD"))
    .option("--sftp-key <path>", "Path to private SSH key file for SFTP authentication");

program.action(async () => {
    const opts = program.opts<Options>();

    setDebug(opts.debug);

    const archiveDescription = new ArchiveDescription(
        opts.archivePrefix,
        opts.compress ? { compressor: opts.compress, level: opts.compressLevel } : undefined,
    );

    console.log(
        msg.get("info.creatingArchive", {
            path:
                opts.target === "local"
                    ? path.join(opts.dst, archiveDescription.fullFilename)
                    : path.posix.join(opts.dst, archiveDescription.fullFilename),
        }),
    );

    const start = performance.now();

    switch (opts.target) {
        case "local":
            await createLocalArchive(opts.src, opts.dst, archiveDescription, opts.keep);
            break;

        case "sftp":
            if (!opts.sftpHost || !opts.sftpUser) {
                throw new Error("Host and username need to be specified for an sftp connection!");
            }

            const sftpOptions: SftpClient.ConnectOptions = {
                host: opts.sftpHost,
                port: opts.sftpPort,
                username: opts.sftpUser,
            };

            if (opts.sftpKey) {
                sftpOptions.privateKey = readFileSync(opts.sftpKey);
            } else {
                sftpOptions.password = opts.sftpPassword;
            }

            await createSftpArchive(opts.src, opts.dst, archiveDescription, opts.keep, sftpOptions);
            break;

        default:
            break;
    }

    console.log(msg.get("info.doneIn", { time: ((performance.now() - start) / 1000).toFixed(2) }));
});

await program.parseAsync().catch((err: unknown) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
