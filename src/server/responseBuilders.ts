import { buildResponseId } from "./responseId.js";

export function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

export function errorResponse(message: string, statusCode = 400, code?: string) {
    const error: Record<string, unknown> = {
        message,
        type: statusCode >= 500 ? "server_error" : "invalid_request_error",
    };
    if (code !== undefined) error.code = code;
    return { error };
}

export function buildCompletionsChunk(params: {
    requestId: string;
    model: string;
    delta: Record<string, unknown>;
    finishReason: string | null;
}) {
    return {
        id: params.requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: params.model,
        choices: [
            {
                index: 0,
                delta: params.delta,
                finish_reason: params.finishReason,
            },
        ],
    };
}

function buildResponseOutput(text: string, thinking: string, messageId: number | null) {
    const normalizedThinking = thinking.trim();
    return [
        {
            type: "message",
            id: messageId === null ? null : String(messageId),
            status: "completed",
            role: "assistant",
            // 兼容 OpenAI message 结构：保留 content，同时扩展可选 reasoning_content。
            ...(normalizedThinking ? { reasoning_content: normalizedThinking } : {}),
            content: [
                {
                    type: "output_text",
                    text,
                    annotations: [],
                },
            ],
        },
    ];
}

export function buildResponseData(params: {
    model: string;
    text: string;
    thinking: string;
    messageId: string | number | null;
    sessionId: string;
    tokenUsage?: number;
}) {
    const messageId = toNumberOrNull(params.messageId);
    return {
        id: buildResponseId(params.sessionId, messageId),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: params.model,
        output: buildResponseOutput(params.text, params.thinking, messageId),
        ...(params.tokenUsage !== undefined && { usage: { total_tokens: params.tokenUsage } }),
    };
}


