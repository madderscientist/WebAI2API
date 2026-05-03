import { SseStreamParser, type SSEvent } from "./sseStreamParser.js";
type DeltaFn = (type: string, delta: string) => void;
/**
 * DeepseekStateDecoder 负责根据 SSE 事件构建一个状态对象，支持基于路径的增量更新和批量操作
 */
export class DeepseekStateDecoder {
    static NUM_RE = /^-?\d+$/;
    state: {
        ready: Record<string, any> | null;
        title: string | null;
        close: Record<string, any> | null;
        updateSession: Record<string, any>[];
        message: Record<string, any>;
    };
    private currentPath: string;
    private currentOp: string;
    onDelta?: DeltaFn;  // 在增量更新时的回调，参数为增量类型和增量内容

    constructor(onDelta?: DeltaFn) {
        this.state = {
            ready: null,
            title: null,
            close: null,
            updateSession: [],
            message: {},
        };
        this.currentPath = 'message';
        this.currentOp = 'SET';
        this.onDelta = onDelta;
    }

    isIntegerToken(token: string) {
        return DeepseekStateDecoder.NUM_RE.test(token);
    }

    /**
     * 根据 message 时获取的 p，构建从 meta 开始的路由路径
     * @returns 统一路由
     */
    normalizePath(path?: string): string {
        if (!path || typeof path !== 'string') return 'message';
        if (path.startsWith('message')) return path;
        return `message/${path}`;
    }

    resolveIndexForRead(arr: Array<any>, token: string): number | null {
        let idx = Number(token);
        if (!Number.isInteger(idx)) return null;
        if (idx < 0) idx = arr.length + idx;
        if (idx < 0 || idx >= arr.length) return null;
        return idx;
    }

    /**
     * 得到索引
     * @param {Array} arr 
     * @param {string} token 疑似索引
     * @returns {number | null} 合法索引或null
     */
    resolveIndexForWrite(arr: Array<any>, token: string): number | null {
        let idx = Number(token);
        if (!Number.isInteger(idx)) return null;    // 说明不是数字
        if (idx < 0) idx += arr.length;
        if (idx < 0) return 0;
        return idx;
    }

    /**
     * 索引到倒数第二层，返回这一层的容器，如果缺少则创建
     * @returns 容器对象或null 后者表示路径不合法
     */
    ensureContainer(root: Record<PropertyKey, any>, pathTokens: string[]): Record<PropertyKey, any> | null {
        let node = root;
        for (let i = 0; i < pathTokens.length - 1; i += 1) {
            const token = pathTokens[i];
            const next = pathTokens[i + 1];
            const nextShouldBeArray = this.isIntegerToken(next);

            if (Array.isArray(node)) {
                // if (!isIntegerToken(token)) return null;
                const idx = this.resolveIndexForWrite(node, token);
                if (idx === null) return null;  // 索引不合法
                if (node[idx] === undefined || node[idx] === null || typeof node[idx] !== 'object') {
                    node[idx] = nextShouldBeArray ? [] : {};
                } node = node[idx];
                continue;
            } else {
                if (node[token] === undefined || node[token] === null || typeof node[token] !== 'object') {
                    node[token] = nextShouldBeArray ? [] : {};
                } node = node[token];
            }
        }
        return node;
    }

    getAtPath(root: Record<PropertyKey, any>, pathTokens: string[]): any {
        let node = root;
        for (const token of pathTokens) {
            if (node === null || node === undefined) return undefined;
            if (Array.isArray(node)) {
                const idx = this.resolveIndexForRead(node, token);
                if (idx === null) return undefined;
                node = node[idx];
            } else {
                node = node[token];
            }
        }
        return node;
    }

    // "o":"SET" 直接设置
    setAtPath(root: Record<PropertyKey, any>, pathTokens: string[], value: any) {
        if (pathTokens.length === 0) return;
        const parent = this.ensureContainer(root, pathTokens);
        if (!parent) return;

        const last = pathTokens[pathTokens.length - 1];
        if (Array.isArray(parent)) {
            const idx = this.resolveIndexForWrite(parent, last);
            if (idx === null) return;
            parent[idx] = value;
            return;
        }

        parent[last] = value;
    }

    // "o":"APPEND" 在原有基础上追加
    appendAtPath(root: Record<PropertyKey, any>, pathTokens: string[], value: any) {
        const prev = this.getAtPath(root, pathTokens);
        // 可追加的只有字符串和数组
        if (typeof value === 'string') {
            const base = typeof prev === 'string' ? prev : '';
            this.setAtPath(root, pathTokens, base + value);
            return;
        }
        if (Array.isArray(value)) {
            if (Array.isArray(prev)) {
                prev.push(...value);
            } else {
                this.setAtPath(root, pathTokens, value);
            }
            return;
        }
        // 其他类型直接覆盖
        this.setAtPath(root, pathTokens, value);
    }

    applyOperation(path: string, op: string, value: any) {
        const normalized = this.normalizePath(path);
        const tokens = normalized.split('/').filter(Boolean);

        if (op === 'BATCH') {
            if (!Array.isArray(value)) return;
            for (const patch of value) {
                if (!patch || typeof patch !== 'object') continue;
                const childPath = patch.p ? `${normalized}/${patch.p}` : normalized;
                const childOp = patch.o || 'SET';
                this.applyOperation(childPath, childOp, patch.v);
            }
            return;
        }

        this.collectDelta(tokens, value);

        if (op === 'APPEND') {
            this.appendAtPath(this.state, tokens, value);
            return;
        }

        this.setAtPath(this.state, tokens, value);
    }

    push(item: SSEvent) {
        const { event, data } = item;
        if (!data || typeof data !== 'object') return;
        switch (event) {
            case 'ready':
                this.state.ready = data;
                return;
            case 'update_session':
                this.state.updateSession.push(data);
                return;
            case 'title':
                this.state.title = data.content || null;
                return;
            case 'close':
                this.state.close = data;
                return;
            case 'message':
                if (typeof data.p === 'string' && data.p.length) {
                    this.currentPath = this.normalizePath(data.p);
                }
                if (typeof data.o === 'string' && data.o.length) {
                    this.currentOp = data.o;
                }
                this.applyOperation(this.currentPath, this.currentOp, data.v);
                return;
        }
    }

    // 增量式
    private emitDelta(type: string | null, delta: string) {
        if (type === null) return;
        if (!delta?.length) return;
        this.onDelta?.(type.toLocaleUpperCase(), delta);
    }
    private emitDeltasFromFragments(fragments: any) {
        if (!Array.isArray(fragments)) return;
        for (const fragment of fragments) {
            if (!fragment || typeof fragment !== 'object') continue;
            this.emitDelta(fragment.type, fragment.content);
        }
    }
    private collectDelta(pathTokens: string[], value: any) {
        if (this.onDelta === null) return;
        const last = pathTokens[pathTokens.length - 1];
        // 第一个message事件
        if (pathTokens.length === 1 && pathTokens[0] === 'message') {
            this.emitDeltasFromFragments(value?.response?.fragments);
            return;
        }
        // BATCH的情况
        if (last === 'fragments' && Array.isArray(value)) {
            this.emitDeltasFromFragments(value);
            return;
        }
        // APPEND
        if (last === 'content' && typeof value === 'string') {
            const fragment = this.getAtPath(this.state, pathTokens.slice(0, -1));
            this.emitDelta(fragment?.type, value);
        }
    }
}

/**
 * DeepseekStreamParser 将 SseStreamParser 和 DeepseekStateDecoder 结合起来，流式解析为DS数据
 */
export class DeepseekStreamParser extends SseStreamParser {
    decoder: DeepseekStateDecoder;
    onEvent?: (event: SSEvent) => void;  // 每当解析出一个事件时的回调，参数为事件对象
    constructor(onDelta?: DeltaFn, onEvent?: (event: SSEvent) => void) {
        super();
        this.decoder = new DeepseekStateDecoder(onDelta);
        this.onEvent = onEvent;
    }
    push(chunk: string): Array<SSEvent> {
        const events = super.push(chunk);
        for (const event of events) {
            this.onEvent?.(event);
            this.decoder.push(event);
        } return events;
    }
    finish(): Array<SSEvent> {
        const tailEvents = super.finish();
        for (const event of tailEvents) {
            this.onEvent?.(event);
            this.decoder.push(event);
        } return tailEvents;
    }
    parseAll(raw: string): Array<SSEvent> {
        const events = super.parseAll(raw);
        for (const event of events) {
            this.onEvent?.(event);
            this.decoder.push(event);
        } return events;
    }
    text(type: string = "response"): string {
        type = type.toLocaleUpperCase();
        const fragments = this.decoder.state.message?.response?.fragments;
        if (Array.isArray(fragments)) {
            return fragments
                .filter((frag) => frag && frag.type.toLocaleUpperCase() === type && typeof frag.content === 'string')
                .map((frag) => frag.content)
                .join('');
        } return '';
    }
}

// 解析流
export async function parseResultFromStream(
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
        text: parser.text("RESPONSE").trim(),
        thinking: parser.text("THINK").trim(),
        messageId: toNumberOrNull(parser.decoder.state.message.response?.message_id),
        accumulated_token_usage: parser.decoder.state.message.response?.accumulated_token_usage ?? -1
    };
}

export function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

// DEMO: Read test.txt, parse, and output state as JSON
// import('fs').then(fs => {
//     fs.readFile('test.txt', 'utf8', (err, data) => {
//         if (err) {
//             console.error('Failed to read test.txt:', err);
//             return;
//         }
//         const parser = new DeepseekStreamParser();
//         parser.parseAll(data);
//         console.log(JSON.stringify(parser.decoder.state, null, 2));
//     });
// });
