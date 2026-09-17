import { styleText } from "node:util";

let debug = false;
export function setDebug(enabled: boolean) {
    debug = enabled;
}

export function logSuccess(message: string) {
    const prefix = process.stdout.isTTY
        ? `${styleText("green", "✔ SUCCESS")}`
        : "SUCCESS";
    console.log(`${prefix} ${message}`);
}

export function logWarning(message: string) {
    const prefix = process.stderr.isTTY
        ? `${styleText("yellow", "⚠ WARNING")}`
        : "WARNING";
    console.warn(`${prefix} ${message}`);
}

export function logError(message: string) {
    const prefix = process.stderr.isTTY
        ? `${styleText("red", "✖ ERROR")}`
        : "ERROR";
    console.error(`${prefix} ${message}`);
}

export function logDebug(message: string) {
    if (debug) console.log(message);
}

export function formatBytes(bytes: number, decimals = 2) {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}
