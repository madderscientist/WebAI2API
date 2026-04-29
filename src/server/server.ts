import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import { parseArgs } from "node:util";
import { getDefaultCredentialPath } from "../auth.js";
import { DeepseekStreamParser } from "../deepseekStreamParser.js";
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
import { buildCompletionsChunk, ChatCompletionsResponse, message2CompletionsMessage, normalizeChatCompletionsRequest, type ChatCompletionsRequest } from "./completionsType.js";
import { message2ResponsesOutput, normalizeResponsesRequest, type ResponsesCreateRequest, type ResponsesCreateResponse } from "./responsesType.js";
import { shouldUseToolPrompt } from "./toolPrompt.js";

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

function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

async function parseResultFromStream(
    stream: ReadableStream<Uint8Array>,
    onDelta?: (type: string, delta: string) => void,
) {
    const parser = new DeepseekStreamParser(onDelta);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            parser.finish();
            break;
        }
        parser.push(decoder.decode(value, { stream: true }));
    }

    return {
        text: parser.text("RESPONSE"),
        thinking: parser.text("THINK"),
        messageId: toNumberOrNull(parser.decoder.state.message.response?.message_id),
        accumulated_token_usage: parser.decoder.state.message.response?.accumulated_token_usage ?? -1
    };
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

        if (!rawInput.stream) {
            const parsed = await parseResultFromStream(runResult.body);
            sendJson(
                res, 200, {
                    id: buildResponseId(requestId, parsed.messageId),
                    object: "response",
                    created_at: Math.floor(Date.now() / 1000),
                    status: "completed",
                    model: modelConfig.model,
                    output: message2ResponsesOutput(parsed.text, useTool, true),
                    usage: {
                        total_tokens: parsed.accumulated_token_usage,
                    }
                } as ResponsesCreateResponse
            );
            return;
        }

        sendSseHeaders(res);
        sendSseData(res, {
            type: "response.created",
            response: {
                id: buildResponseId(requestId, null),
                object: "response",
                created_at: Math.floor(Date.now() / 1000),
                status: "in_progress",
                model: modelConfig.model,
            },
        });

        const finalParsed = await parseResultFromStream(runResult.body, (type, delta) => {
            if (abortController.signal.aborted || res.writableEnded) return;
            if (type === "THINK") {
                sendSseData(res, {
                    type: "response.reasoning.delta",
                    delta,
                });
                return;
            }
            sendSseData(res, {
                type: "response.output_text.delta",
                delta,
            });
        });

        // 流式输出的最后一条消息 只包含元数据
        sendSseData(res, {
            type: "response.completed",
            response: {
                id: buildResponseId(runResult.sessionId, finalParsed.messageId),
                object: "response",
                created_at: Math.floor(Date.now() / 1000),
                status: "completed",
                model: modelConfig.model,
                ...(finalParsed.accumulated_token_usage >= 0 && { 
                    usage: { total_tokens: finalParsed.accumulated_token_usage } 
                }),
            },
        });
        sendSseDone(res);
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
        void shutdown().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
        void shutdown().finally(() => process.exit(0));
    });

    const server = createServer((req, res) => {
        void handleRequest(req, res, client).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!res.headersSent) {
                sendJson(res, 500, errorResponse(message, 500, "server_error"));
                return;
            }
            res.end();
        });
    });

    const port = Number(parsed.values.port) || DEFAULT_PORT;
    server.listen(port, () => {
        console.log(`[WebAI2API] HTTP server listening on http://127.0.0.1:${port}`);
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
