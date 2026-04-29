import type { ChildProcess } from "node:child_process";
import { chromium, type Browser } from "playwright-core";
import { loadCredentials } from "../auth.js";
import { launchChromeForDebugging } from "../browser.js";
import { DeepSeekBrowserClient } from "../deepseekBrowserClient.js";
import { DeepSeekWebClient } from "../deepseekWebClient.js";

export interface ServerClientOptions {
    credentialPath: string;
    browserMode: boolean;
    userDataDir?: string;
}

export interface ServerChatRequest {
    message: string;
    fileIds?: string[];

    sessionId?: string;
    parentMessageId?: number | null;

    modelType?: string | null;
    searchEnabled?: boolean;
    thinkingEnabled?: boolean;

    preempt?: boolean;
    signal?: AbortSignal;
}

export interface ServerChatResult {
    sessionId: string;
    body: ReadableStream<Uint8Array>;
}

export interface ServerClient {
    readonly mode: "api" | "browser";
    runChatCompletion(params: ServerChatRequest): Promise<ServerChatResult>;
    deleteSession(sessionId: string): Promise<void>;
    close(): Promise<void>;
}

function stringToStream(text: string): ReadableStream<Uint8Array> {
    const encoded = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoded);
            controller.close();
        },
    });
}

class ApiServerClient implements ServerClient {
    readonly mode = "api" as const;
    private readonly client: DeepSeekWebClient;

    constructor(credentialPath: string) {
        const credentials = loadCredentials(credentialPath);
        this.client = new DeepSeekWebClient({
            cookie: credentials.cookie,
            bearer: credentials.bearer,
            userAgent: credentials.userAgent,
        });
        this.client.verbose = false;
    }

    async runChatCompletion(params: ServerChatRequest): Promise<ServerChatResult> {
        const sessionId = params.sessionId ?? await this.client.createChatSession();
        const body = await this.client.chatCompletions({
            sessionId,
            message: params.message,
            modelType: params.modelType,
            fileIds: params.fileIds,
            searchEnabled: params.searchEnabled,
            thinkingEnabled: params.thinkingEnabled,
            preempt: params.preempt,
            parentMessageId: params.parentMessageId,
            signal: params.signal,
        });
        return { sessionId, body };
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.client.deleteSession(sessionId);
    }

    async close(): Promise<void> {
        return;
    }
}

class BrowserServerClient implements ServerClient {
    readonly mode = "browser" as const;
    private readonly browser: Browser;
    private readonly launchedProcess: ChildProcess;
    private readonly client: DeepSeekBrowserClient;

    constructor(browser: Browser, processRef: ChildProcess, client: DeepSeekBrowserClient) {
        this.browser = browser;
        this.launchedProcess = processRef;
        this.client = client;
        client.verbose = false;
    }

    static async create(userDataDir?: string): Promise<BrowserServerClient> {
        const launched = await launchChromeForDebugging({
            userDataDir,
            headless: true,
            detached: true,
        });
        const browser = await chromium.connectOverCDP(launched.cdpUrl);
        const client = new DeepSeekBrowserClient(browser);
        return new BrowserServerClient(browser, launched.process, client);
    }

    async runChatCompletion(params: ServerChatRequest): Promise<ServerChatResult> {
        const result = await this.client.chatCompletions({
            sessionId: params.sessionId,
            message: params.message,
            modelType: params.modelType,
            fileIds: params.fileIds,
            searchEnabled: params.searchEnabled,
            thinkingEnabled: params.thinkingEnabled,
            preempt: params.preempt,
            parentMessageId: params.parentMessageId,
            signal: params.signal,
        });
        return {
            sessionId: result.sessionId,
            body: stringToStream(result.body),
        };
    }

    async deleteSession(sessionId: string): Promise<void> {
        const ok = await this.client.deleteSession(sessionId);
        if (!ok) {
            throw new Error(`Failed to delete browser session: ${sessionId}`);
        }
    }

    async close(): Promise<void> {
        try {
            await this.browser.close();
        } finally {
            if (!this.launchedProcess.killed && this.launchedProcess.exitCode === null) {
                this.launchedProcess.kill();
            }
        }
    }
}

export async function createServerClient(options: ServerClientOptions): Promise<ServerClient> {
    if (options.browserMode) {
        return BrowserServerClient.create(options.userDataDir);
    }
    return new ApiServerClient(options.credentialPath);
}
