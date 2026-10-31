/**
 * Responses 的会话级队列：HTTP 和 WebSocket 共用，同一 sessionId 的请求按入队顺序
 * 串行执行，前一个请求完整结束（包括流式输出解析）后才执行下一个；不同会话互不阻塞，
 * 不限制 server 的全局并发。
 * 同一排队批次中，后续请求使用上一成功请求记录的 messageId 作为 parentMessageId，
 * 优先于请求自带的父消息 ID，以衔接连续对话而不是形成分支。
 * 每个会话最多等待 8 个请求（不含正在执行的请求），满时拒绝；单个请求失败不阻塞后续请求。队列耗尽后清理状态，下一批次重新使用请求自带的父消息 ID。
 */

type QueuedRunner<T> = {
    runner: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error?: unknown) => void;
};

interface SessionQueueState {
    running: boolean;
    queue: QueuedRunner<any>[];
    lastMessageId: number | null;
}

const MAX_SESSION_QUEUE_SIZE = 8;
const sessionStates = new Map<string, SessionQueueState>();

function getOrCreateSessionState(sessionId: string): SessionQueueState {
    let state = sessionStates.get(sessionId);
    if (!state) {
        state = {
            running: false,
            queue: [],
            lastMessageId: null,
        };
        sessionStates.set(sessionId, state);
    }
    return state;
}

async function processSessionQueue(sessionId: string): Promise<void> {
    const state = sessionStates.get(sessionId);
    if (!state || state.running) return;
    state.running = true;
    try {
        while (state.queue.length > 0) {
            const item = state.queue.shift()!;
            try {
                const value = await item.runner();
                item.resolve(value);
            } catch (error) {
                item.reject(error);
            }
        }
    } finally {
        state.running = false;
        if (state.queue.length > 0) {
            const error = new Error(`Session ${sessionId} queue processor stopped`);
            for (const pending of state.queue.splice(0)) {
                try {
                    pending.reject(error);
                } catch {
                    // ignore
                }
            }
        }
        if (state.queue.length === 0) clearResponseSessionState(sessionId);
    }
}

export function enqueueResponseSessionRequest<T>(sessionId: string, runner: () => Promise<T>): Promise<T> {
    if (!sessionId) return Promise.reject(new Error("sessionId required for response session queueing"));
    const state = getOrCreateSessionState(sessionId);
    if (state.queue.length >= MAX_SESSION_QUEUE_SIZE) {
        return Promise.reject(new Error(`Session ${sessionId} queue full (max ${MAX_SESSION_QUEUE_SIZE})`));
    }
    return new Promise<T>((resolve, reject) => {
        state.queue.push({ runner, resolve, reject });
        void processSessionQueue(sessionId).catch((error) => {
            console.error(`[ResponsesSessionQueue] queue processor error for ${sessionId}:`, error);
        });
    });
}

export function resolveQueuedParentMessageId(sessionId: string, requestedParentMessageId: number | null | undefined): number | null {
    const state = sessionStates.get(sessionId);
    if (!state) return requestedParentMessageId ?? null;
    // 在队列中的任务默认顺序，不能覆盖
    return state.lastMessageId ?? requestedParentMessageId ?? null;
}

export function rememberResponseSessionMessageId(sessionId: string, messageId: number | null): void {
    if (!sessionId) return;
    const state = getOrCreateSessionState(sessionId);
    state.lastMessageId = messageId;
}

export function clearResponseSessionState(sessionId: string): void {
    sessionStates.delete(sessionId);
}