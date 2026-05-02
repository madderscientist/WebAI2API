// https://developers.openai.com/api/docs/guides/websocket-mode

import { WebSocket } from "ws";
import {
    normalizeResponsesRequest,
    message2ResponsesOutput,
    hasRunnableUserInput,
    type ResponsesCreateRequest,
    ResponsesResponse,
} from "./responsesType.js";
import { buildResponseId, parseResponseId } from "../responseId.js";
import { getModelConfig } from "../models.js";
import { shouldUseToolPrompt } from "../toolPrompt.js";
import type { ServerClient } from "../serverClient.js";
import { parseResultFromStream } from "../../deepseekStreamParser.js";
import { READY_RESPONSE_ID } from "./responsesType.js";
import { streamSendRestResponse } from "./stream.js";

export interface WebSocketMessage {
    type: "response.create";
    data?: ResponsesCreateRequest;
    requestId?: string;
    event_id?: string;
    response?: ResponsesCreateRequest;
}

export interface WebSocketResponse {
    type: "response" | "error";
    requestId?: string;
    data?: unknown;
    error?: Record<string, unknown> | string;
    status?: number;
}

/**
 * 管理 WebSocket 连接的会话状态
 * 一个连接 = 一个会话
 */
export class WebSocketSessionManager {
    private readonly ws: WebSocket;
    private readonly client: ServerClient;
    private sessionId: string | null = null;    // 用于删除对话
    private readonly abortControllers = new Map<string, AbortController>();
    // 管理instructions
    private instructions: string | undefined;   // 防止每次都发送
    private lastInstructionMessageId: number = -114514;

    private getRequestEnvelope(message: WebSocketMessage): {
        request: ResponsesCreateRequest;
        codexProtocol: boolean;
    } | null {
        if (message.type === "response.create") {   // Codex 协议特有的请求类型
            const payload = message as unknown as ResponsesCreateRequest;
            if (!payload) return null;
            if (payload.input === undefined || payload.input === null) {
                console.warn("[WebSocket] response.create payload missing input field");
                return null;
            }
            return {
                request: payload,
                codexProtocol: true,    // 标记为 Codex 的请求
            };
        }
        return null;
    }

    private sendCodexFailed(message: string) {
        this.sendRaw({
            type: "response.failed",
            response: {
                status: "failed",
                error: {
                    type: "server_error",
                    code: "server_error",
                    message,
                }
            }
        });
    }

    constructor(ws: WebSocket, client: ServerClient) {
        this.ws = ws;
        this.client = client;

        ws.on("message", (data) => this.handleMessage(data));
        ws.on("close", (code, reason) => {
            this.cleanup().catch(error => { });
        }); // 连接断开的时机: archive该session或者关闭codex
        ws.on("error", (error) => this.handleError(error));
    }

    private async handleMessage(rawData: unknown) {
        try {
            // 解析payload
            let payloadText: string;
            if (typeof rawData === "string") {
                payloadText = rawData;
            } else if (rawData instanceof Buffer) {
                payloadText = rawData.toString("utf8");
            } else if (Array.isArray(rawData)) {
                payloadText = Buffer.concat(rawData).toString("utf8");
            } else if (rawData instanceof ArrayBuffer) {
                payloadText = Buffer.from(rawData).toString("utf8");
            } else {
                console.warn(`[WebSocket] Unsupported message payload type: ${typeof rawData}`);
                this.sendError("Invalid message format", 400);
                return;
            }
            const message: WebSocketMessage = JSON.parse(payloadText);
            const envelope = this.getRequestEnvelope(message);
            if (envelope) {
                await this.handleRequest(envelope.request, envelope.codexProtocol);
                return;
            }

            console.warn(`[WebSocket] Unknown message type: ${String(message.type)}`);
            this.sendError("Unknown message type", 400);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[WebSocket] Failed to parse/process incoming message: ${msg}`);
            this.sendError(`Failed to parse message: ${msg}`, 400);
        }
    }

    private async handleRequest(
        rawInput: ResponsesCreateRequest,
        codexProtocol = false,
    ) {
        const requestId = Date.now().toString();    // 用于AbortController的管理
        try {
            // codex 会在用户发送消息后请求 gpt-5.4-mini 总结标题，此时改为deepseek
            let modelConfig;
            try {
                modelConfig = getModelConfig(rawInput.model);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!codexProtocol || !message.includes("Unsupported model:")) throw error;
                console.warn(`[WebSocket] Unsupported model in codex mode, fallback to deepseek: ${rawInput.model ?? "<missing>"}`);
                modelConfig = getModelConfig("deepseek");
            }

            // warmup, input是空的, 不请求直接返回空的
            if (!hasRunnableUserInput(rawInput.input)) {
                if (codexProtocol) {
                    this.sendRaw({
                        type: "response.created",
                        response: {}    // codex源码说可以为空
                    });  // 其实created可以不必要
                    this.sendRaw({
                        type: "response.completed",
                        response: {
                            id: READY_RESPONSE_ID
                        }   // 实测不传id也没事
                    });
                    this.sessionId = READY_RESPONSE_ID;
                    return;
                }
                const message = "input must include at least one non-empty user message or function_call_output.";
                this.sendError(message, 400);
                return;
            }

            // 去重 Instructions
            let _tmp = parseResponseId(rawInput.previous_response_id ?? '');
            const rawInputMessageId = _tmp.messageId ?? 0;
            if (rawInput.instructions === this.instructions && rawInputMessageId - this.lastInstructionMessageId < 30) {
                rawInput.instructions = undefined;
            } else {
                this.instructions = rawInput.instructions;
            }
            // 校验 sessionId 是否相同
            if (_tmp.sessionId !== this.sessionId) {
                this.sendError({
                    code: "previous_response_not_found",
                    message: `Previous response with id '${_tmp.sessionId}' not found, expected ${this.sessionId}.`,
                    param: "previous_response_id"
                }, 400);
                return;
            }

            const normalized = normalizeResponsesRequest(rawInput);
            if (!normalized.message) {
                this.sendError("messages must include at least one non-empty message.", 400);
                return;
            }

            const abortController = new AbortController();
            this.abortControllers.set(requestId, abortController);

            try {
                const runResult = await this.client.runChatCompletion({
                    ...normalized,
                    modelType: modelConfig.modelType,
                    searchEnabled: modelConfig.searchEnabled,
                    thinkingEnabled: modelConfig.thinkingEnabled,
                    signal: abortController.signal,
                });

                // 更新会话信息
                this.sessionId = runResult.sessionId;
                // 等待并解析
                const parsed = await parseResultFromStream(runResult.body);

                // socket模式下都是流式的结构
                let input_token_est = normalized.message.length >> 2;
                let output_token_est = (parsed.text.length) >> 2;
                input_token_est = Math.floor(parsed.accumulated_token_usage * input_token_est / (input_token_est + output_token_est));
                output_token_est = parsed.accumulated_token_usage - input_token_est;

                const finalId = buildResponseId(runResult.sessionId, parsed.messageId);
                const result: ResponsesResponse = {
                    id: finalId,
                    object: "response",
                    created_at: Math.floor(Date.now() / 1000),
                    status: "completed",
                    model: modelConfig.model,
                    output: message2ResponsesOutput(parsed.text, finalId, shouldUseToolPrompt(rawInput.tools, rawInput.tool_choice)),
                    usage: {
                        total_tokens: parsed.accumulated_token_usage,
                        input_tokens: input_token_est,
                        output_tokens: output_token_est,
                    },
                };
                if (codexProtocol) {
                    streamSendRestResponse((data) => this.sendRaw(data), result, 1);
                }
                this.lastInstructionMessageId = parsed.messageId ?? -114514;
            } finally {
                this.abortControllers.delete(requestId);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[WebSocket] Request failed requestId=${requestId} error=${message}`);
            if (codexProtocol) {
                this.sendCodexFailed(message);
            }
            if (message.includes("Unsupported model:")) {
                this.sendError(message, 400);
                return;
            }
            this.sendError(message, 500);
        }
    }

    private send(message: WebSocketResponse) {
        if (this.ws.readyState === 1) { // WebSocket.OPEN
            this.ws.send(JSON.stringify(message));
            return;
        }
        console.warn(`[WebSocket] Skip send because socket not open (readyState=${this.ws.readyState})`);
    }

    private sendRaw(message: Record<string, any>) {
        if (this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(message));
            return;
        }
        console.warn(`[WebSocket] Skip raw send because socket not open (readyState=${this.ws.readyState})`);
    }

    private sendError(message: any, code: number = 500) {
        console.warn(`[WebSocket] Send error code=${code} message=${message}`);
        this.send({
            type: "error",
            error: message,
            status: code,
        });
    }

    private handleError(error: Error) {
        console.error(`[WebSocket Error]: ${error.message}`);
    }

    /**
     * 请求结束后的清理
     */
    private async cleanup() {
        // 中止所有待处理请求
        for (const controller of this.abortControllers.values()) {
            controller.abort();
        }
        this.abortControllers.clear();

        // 删除会话
        if (this.sessionId && !this.sessionId.startsWith(READY_RESPONSE_ID)) {
            try {
                await this.client.deleteSession(this.sessionId);
                console.log(`[WebSocket] Session deleted sessionId=${this.sessionId}`);
            } catch (error) {
                console.warn(`[WebSocket] Failed to delete session sessionId=${this.sessionId}:`, error);
            }
        }
        console.log("[WebSocket] Cleanup done");
    }
}
