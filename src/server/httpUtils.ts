import type { IncomingMessage, ServerResponse } from "node:http";

// 白名单
const DEFAULT_ALLOWED_IPS = ["127.0.0.1", "::1"];
const ENV_ALLOWED_IPS = (process.env.MYDS_IP_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const ALLOWED_IPS = new Set([...DEFAULT_ALLOWED_IPS, ...ENV_ALLOWED_IPS]);

function normalizeIpAddress(address: string | undefined | null): string | null {
    if (!address) return null;
    let normalized = address.trim();
    if (!normalized) return null;
    if (normalized.startsWith("::ffff:")) {
        normalized = normalized.slice(7);
    }
    const zoneIndex = normalized.indexOf("%");
    if (zoneIndex >= 0) {
        normalized = normalized.slice(0, zoneIndex);
    }
    return normalized;
}

export function getAllowedIpSummary(): string {
    return Array.from(ALLOWED_IPS).join(", ");
}

export function isAllowlistedClient(req: IncomingMessage): boolean {
    const clientIp = normalizeIpAddress(req.socket.remoteAddress);
    if (!clientIp) return false;
    return ALLOWED_IPS.has(clientIp);
}

// 以下是一些 HTTP 相关的实用函数
export function readRequestJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(raw) as unknown);
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

export function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
    if (res.headersSent) return;
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.end(JSON.stringify(body));
}

export function sendSseHeaders(res: ServerResponse) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.flushHeaders?.();
}

export function sendSseData(res: ServerResponse, payload: unknown) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sendSseDone(res: ServerResponse) {
    res.write("data: [DONE]\n\n");
    res.end();
}

export function errorResponse(message: string, statusCode = 400, code?: string) {
    const error: Record<string, unknown> = {
        message,
        type: statusCode >= 500 ? "server_error" : "invalid_request_error",
    };
    if (code !== undefined) error.code = code;
    return { error };
}
