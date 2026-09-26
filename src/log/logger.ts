import { AsyncLocalStorage } from "node:async_hooks";
import { styleText } from "node:util";
import { Counters } from "../types.ts";
import msg, { type MessageParams } from "./messages.ts";

export const countersStorage = new AsyncLocalStorage<Counters>();

let debug = false;
export function setDebug(enabled: boolean) {
    debug = enabled;
}

export function logSuccess(message: string) {
    const prefix = process.stdout.isTTY ? `${styleText("green", "✔ SUCCESS")}` : "SUCCESS";
    console.log(`${prefix} ${message}`);
}

export function logWarning(message: string, error?: unknown) {
    const counters = countersStorage.getStore();
    if (counters) counters.warnings++;

    const prefix = process.stderr.isTTY ? `${styleText("yellow", "⚠ WARNING")}` : "WARNING";
    console.warn(`${prefix} ${message}`, ...(error ? [error] : []));
}

export function logError(message: string, error?: unknown) {
    const prefix = process.stderr.isTTY ? `${styleText("red", "✖ ERROR")}` : "ERROR";
    console.error(`${prefix} ${message}`, ...(error ? [error] : []));
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

export function formatKnownError(error: unknown, params: MessageParams = {}) {
    if (error instanceof Error && "code" in error) {
        if (error.code === "ENOENT") {
            return msg.get("warn.unableToAccessNoneExistPath", params);
        } else if (
            error.code === "EACCES" ||
            error.code === "EPERM" ||
            error.code === "EBUSY" ||
            error.code === "ELOOP"
        ) {
            return msg.get("warn.unableToAccessPath", params);
        }
    }
}
