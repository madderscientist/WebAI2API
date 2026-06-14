type QueuedRunner<T> = {
    runner: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error?: unknown) => void;
};

interface SessionQueueState {
    // running: boolean;   // 这个状态省略了，因为只要 queue 有内容就说明在运行
    queue: QueuedRunner<any>[];
    lastMessageId: number | null;
}

const MAX_SESSION_QUEUE_SIZE = 8;
const sessionStates = new Map<string, SessionQueueState>();

function getOrCreateSessionState(sessionId: string): SessionQueueState {
    let state = sessionStates.get(sessionId);
    if (!state) {
        state = {
            queue: [],
            lastMessageId: null,
        };
        sessionStates.set(sessionId, state);
    }
    return state;
}

async function processSessionQueue(sessionId: string): Promise<void> {
    const state = sessionStates.get(sessionId);
    if (!state) return;
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