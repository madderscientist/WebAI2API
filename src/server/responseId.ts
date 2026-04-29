/**
 * 从字符串中提取sessionId和messageId，格式为"sessionId|messageId"
 * - **sessionId:** null 表示新建, 此时 messageId 也会是 null
 * - **messageId:** null 表示从头开始; 0或负数表示不发送历史消息
 */
export interface ParsedResponseId {
    sessionId: string | null;
    messageId: number | null;
}

export function buildResponseId(sessionId: string | null, messageId: number | null): string {
    if (sessionId === null) return "";
    if (messageId === null) return sessionId.trim();
    return `${sessionId.trim()}|${String(messageId)}`;
}

export function parseResponseId(value: string): ParsedResponseId {
    const raw = value.trim();
    const separatorIndex = raw.indexOf("|");
    if (separatorIndex < 0) {
        if (raw.length < 10) return { sessionId: null, messageId: null };
        return { sessionId: raw, messageId: null };
    }

    const sessionId = raw.slice(0, separatorIndex).trimEnd();
    // ds的sessionId长度很长
    if (sessionId.length < 10) return { sessionId: null, messageId: null };

    let messageId: number | null = null;
    const messageRaw: string | null = raw.slice(separatorIndex + 1).trimStart();
    if (messageRaw) {
        messageId = Number(messageRaw);
        if (!Number.isFinite(messageId)) messageId = null;
        else if (messageId < 0) messageId = null; // 负数不合法，视为null
    }
    return { sessionId, messageId };
}
