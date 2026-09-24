//#region Messages
const messages = {
    // Info
    "info.creatingArchive": "Creating archive {{path}} ...",
    "info.doneIn": "Done in {{time}} s",
    "info.addedFiles": "Added {{count}} files to archive",

    // Success
    "success.archiveCreated": "Archive created at {{path}} with {{size}}",
    "success.archiveDeleted": "Archive deleted at {{path}}",

    // Warning
    "warn.deleteFailed": "Unable to delete {{path}}. Skipping it.",
    "warn.unableToAccessNoneExistPath": "Unable to access {{path}}: it no longer exists. Skipping it.",
    "warn.unableToAccessPath": "Unable to access {{path}}: it cannot be accessed. Skipping it.",
    "warn.unableToProcessUnknownType": "Unable to process {{path}}: unsupported content type. Skipping it.",

    // Error
    "err.sizeMismatch": "File size mismatch after archive creation for {{path}}",
    "err.noneExistDestination": "Destination {{path}} is not a directory or does not exist!",
} as const;
//#endregion

function get(key: keyof typeof messages, params: MessageParams = {}) {
    const message = messages[key].toString();

    let result = message;

    for (const [name, value] of Object.entries(params)) {
        result = result.split(`{{${name}}}`).join(value.toString());
    }

    return result;
}

export type MessageParams = Record<string, string | number>;

export default {
    get,
};
