import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import Stream from "node:stream";
import process from "node:process";
import { parseArgs } from "node:util";
import { getDefaultCredentialPath } from "../auth.js";
import { parseResultFromStream } from "../deepseekStreamParser.js";
import {
    getAllowedIpSummary,
    isAllowlistedClient,
    readRequestJson,
    sendJson,
    sendSseData,
    sendSseDone,
    sendSseHeaders,
    errorResponse
} from "./httpUtils.js";
import { createServerClient, type ServerClient } from "./serverClient.js";
import { buildResponseId } from "./responseId.js";
import { MODEL_LIST, getModelConfig } from "./models.js";
import { buildCompletionsChunk, ChatCompletionsResponse, message2CompletionsMessage, normalizeChatCompletionsRequest, type ChatCompletionsRequest } from "./completions/completionsType.js";
import { estimateUsage, message2ResponsesOutput, normalizeResponsesRequest, ResponseOutputMessage, type ResponsesCreateRequest, type ResponsesResponse } from "./responses/responsesType.js";
import { shouldUseToolPrompt } from "./toolPrompt.js";
import { streamEventsFromStream } from "./responses/stream.js";
import { WebSocketSessionManager } from "./responses/websocketHandler.js";

const DEFAULT_PORT = 8787;

async function handleModels(res: ServerResponse) {
    sendJson(res, 200, {
        object: "list",
        data: MODEL_LIST.map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "localhost",
        })),
    });
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, client: ServerClient) {
    const rawInput = await readRequestJson(req) as ChatCompletionsRequest;
    const normalized = normalizeChatCompletionsRequest(rawInput);
    const modelConfig = getModelConfig(rawInput.model || 'deepseek');
    const useTool = shouldUseToolPrompt(rawInput.tools, rawInput.tool_choice);

    if (!normalized.message.trim()) {
        sendJson(res, 400, errorResponse("messages must include at least one non-empty message."));
        return;
    }

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    let sessionId: string | null = null;
    try {
        const runResult = await client.runChatCompletion({
            ...normalized,
            modelType: modelConfig.modelType,
            fileIds: [],
            searchEnabled: modelConfig.searchEnabled,
            thinkingEnabled: modelConfig.thinkingEnabled,
            signal: abortController.signal,
        });

        const requestId = sessionId = runResult.sessionId;

        if (!rawInput.stream) {
            const parsed = await parseResultFromStream(runResult.body);
            const thinking = parsed.thinking.trim();
            const msg = message2CompletionsMessage(parsed.text, useTool);
            if (thinking) {
                msg.thinking_content = thinking;
            }
            sendJson(res, 200, {
                id: requestId,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: modelConfig.model,
                choices: [{
                    index: 0,
                    message: msg,
                }],
                usage: {
                    total_tokens: parsed.accumulated_token_usage,
                },
            } as ChatCompletionsResponse);
            return;
        }

        // 处理流式返回
        sendSseHeaders(res);
        sendSseData(
            res,
            buildCompletionsChunk({
                requestId,
                model: modelConfig.model,
                delta: { role: "assistant" },
                finishReason: null,
            }),
        );

        await parseResultFromStream(runResult.body, (type, delta) => {
            if (abortController.signal.aborted || res.writableEnded) return;
            if (type === "THINK") {
                sendSseData(
                    res,
                    buildCompletionsChunk({
                        requestId,
                        model: modelConfig.model,
                        delta: { reasoning_content: delta },
                        finishReason: null,
                    }),
                );
                return;
            }
            sendSseData(
                res,
                buildCompletionsChunk({
                    requestId,
                    model: modelConfig.model,
                    delta: { content: delta },
                    finishReason: null,
                }),
            );
        });

        sendSseData(
            res,
            buildCompletionsChunk({
                requestId,
                model: modelConfig.model,
                delta: {},
                finishReason: "stop",
            }),
        );
        sendSseDone(res);
    } catch (error) {
        if (abortController.signal.aborted || res.writableEnded) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Unsupported model:")) {
            sendJson(res, 400, errorResponse(message));
            return;
        }
        sendJson(res, 500, errorResponse(message, 500, "server_error"));
    } finally {
        // completions 为无状态接口，请求结束后删除会话。
        if (sessionId) {
            try {
                await client.deleteSession(sessionId);
            } catch (cleanupError) {
                const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
                console.warn(`[myds] Failed to delete completion session ${sessionId}: ${msg}`);
            }
        }
    }
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, client: ServerClient) {
    const rawInput = await readRequestJson(req) as ResponsesCreateRequest;
    const modelConfig = getModelConfig(rawInput.model);
    const useTool = shouldUseToolPrompt(rawInput.tools, rawInput.tool_choice);
    const normalized = normalizeResponsesRequest(rawInput);
    if (!normalized.message) {
        sendJson(res, 400, errorResponse("input must include at least one non-empty message."));
        return;
    }

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    try {
        const runResult = await client.runChatCompletion({
            ...normalized,
            signal: abortController.signal,
            modelType: modelConfig.modelType,
            searchEnabled: modelConfig.searchEnabled,
            thinkingEnabled: modelConfig.thinkingEnabled,
        });
        const requestId = runResult.sessionId;

        if (rawInput.stream === true) {
            sendSseHeaders(res);
            await streamEventsFromStream(
                runResult.body,
                useTool,
                requestId,
                modelConfig.model,
                normalized.message.length,
                (data) => {
                    if (abortController.signal.aborted || res.writableEnded) return;
                    sendSseData(res, data);
                }
            );
            sendSseDone(res);
        } else {
            // 一次性解析完
            const parsed = await parseResultFromStream(runResult.body);
            const id = buildResponseId(requestId, parsed.messageId);
            const output = message2ResponsesOutput(parsed.text, id, useTool);
            if (parsed.thinking.trim()) {   // 添加思考字段
                output.push({
                    type: 'reasoning',
                    content: [{
                        type: 'output_text',
                        text: parsed.thinking.trim(),
                        annotations: [],
                    }],
                    role: 'assistant',
                    id: `thinking_${id}`,
                    status: 'completed',
                } as ResponseOutputMessage);
            }
            const result: ResponsesResponse = {
                id,
                object: "response",
                created_at: Math.floor(Date.now() / 1000),
                status: "completed",
                model: modelConfig.model,
                output,
                usage: estimateUsage(parsed.accumulated_token_usage, normalized.message.length, parsed.text.length + parsed.thinking.length),
            };
            sendJson(res, 200, result);
        }
    } catch (error) {
        if (abortController.signal.aborted || res.writableEnded) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Unsupported model:")) {
            sendJson(res, 400, errorResponse(message));
            return;
        }
        sendJson(res, 500, errorResponse(message, 500, "server_error"));
    }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, client: ServerClient) {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (!isAllowlistedClient(req)) {
        sendJson(res, 403, errorResponse("Forbidden: client IP is not in allowlist.", 403, "forbidden"));
        return;
    }

    if (method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        });
        res.end();
        return;
    }

    if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (method === "GET" && url.pathname === "/v1/models") {
        await handleModels(res);
        return;
    }

    if (method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletions(req, res, client);
        return;
    }

    if (method === "POST" && url.pathname === "/v1/responses") {
        await handleResponses(req, res, client);
        return;
    }

    sendJson(res, 404, errorResponse(`Route not found: ${method} ${url.pathname}`, 404, "not_found"));
}

function handleWebSocketUpgrade(
    req: IncomingMessage,
    socket: Stream.Duplex,
    head: Buffer,
    wss: WebSocketServer,
    client: ServerClient
) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (!isAllowlistedClient(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
    }

    // 只有 /v1/responses 支持 WebSocket
    if (url.pathname === "/v1/responses") {
        wss.handleUpgrade(req, socket, head, (ws) => {
            console.log(`[WebSocket] New connection from ${req.socket.remoteAddress}`);
            new WebSocketSessionManager(ws, client);
        });
        return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
}

async function main() {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
            port: { type: "string", short: "p", default: String(DEFAULT_PORT) },
            browser: { type: "boolean" },
            "user-data-dir": { type: "string" },
            credentials: { type: "string", short: "c" },
        },
        allowPositionals: false,
        strict: true,
    });

    const browserMode = parsed.values.browser ?? false;
    const credentialPath = parsed.values.credentials ?? getDefaultCredentialPath();
    const userDataDir = parsed.values["user-data-dir"];

    const client = await createServerClient({
        browserMode,
        credentialPath,
        userDataDir,
    });

    const shutdown = async () => {
        try {
            await client.close();
        } catch {
            // ignore shutdown errors
        }
    };

    process.on("SIGINT", () => {
        shutdown().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
        shutdown().finally(() => process.exit(0));
    });

    // 处理 HTTP 请求
    const server = createServer((req, res) => {
        handleRequest(req, res, client).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!res.headersSent) {
                sendJson(res, 500, errorResponse(message, 500, "server_error"));
                return;
            }
            res.end();
        });
    });

    // 处理 WebSocket 升级请求
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        handleWebSocketUpgrade(req, socket, head, wss, client);
    });

    const port = Number(parsed.values.port) || DEFAULT_PORT;
    server.listen(port, () => {
        console.log(`[WebAI2API] HTTP server listening on http://127.0.0.1:${port}`);
        console.log(`[WebAI2API] WebSocket support enabled on ws://127.0.0.1:${port}/v1/responses`);
        console.log(`[WebAI2API] Client mode: ${client.mode}`);
        console.log(`[WebAI2API] Allowed client IPs: ${getAllowedIpSummary()}`);
        if (client.mode === "browser" && userDataDir) {
            console.log(`[WebAI2API] Browser user-data-dir: ${userDataDir}`);
        }
    });
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
