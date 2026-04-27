import process from "node:process";
import { pathToFileURL } from "node:url";

export function isDirectRun(meta_url = import.meta.url) {
    const entry = process.argv[1];
    if (!entry) return false;
    return meta_url === pathToFileURL(entry).href;
}