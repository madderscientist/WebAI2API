import { Browser, Page, Route } from "playwright-core";

interface QueuedTask<T> {
    runner: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

interface ChatCompletionResult {
    sessionId: string;
    body: string;
}

export class DeepSeekBrowserClient {
    browser: Browser;
    page: Promise<Page>;
    private running = false;
    private queue: QueuedTask<unknown>[] = [];
    constructor(
        browser: Browser
    ) {
        this.browser = browser;
        this.page = this.initPage();
    }

    private async initPage() {
        const context = this.browser.contexts()[0] || (await this.browser.newContext());  // 浏览器新账户
        const page = context.pages().find((p) => p.url().includes("deepseek.com")) ?? (await context.newPage());
        return page;
    }

    private createAbortError() {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        return error;
    }

    private withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!signal) return promise;
        if (signal.aborted) {
            return Promise.reject(this.createAbortError());
        }
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(this.createAbortError());
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
                (value) => {
                    signal.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                },
            );
        });
    }

    private parseJsonSafely(text: string): Record<string, unknown> | null {
        if (!text) return null;
        try {
            const parsed = JSON.parse(text) as unknown;
            return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
        } catch {
            return null;
        }
    }

    // 任务队列管理
    private enqueueTask<T>(runner: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ runner, resolve, reject } as QueuedTask<unknown>);
            void this.dequeeue();
        });
    }

    async dequeeue() {
        if (this.running) return;
        this.running = true;
        while (this.queue.length > 0) {
            const queued = this.queue.shift();
            if (!queued) break;
            try {
                const value = await queued.runner();
                queued.resolve(value);
            } catch (error) {
                queued.reject(error);
            }
        }
        this.running = false;
    }

    // 跳转到对应的对话 若不存在则新建 新建会话拿不到sessionId
    private async _switchSession(sessionId: string = "") {
        const page = await this.page;
        let url = 'https://chat.deepseek.com';
        if (sessionId?.length > 10) {
            url += `/a/chat/s/${sessionId}`;
        }
        await page.goto(url, { waitUntil: "domcontentloaded" });
        // 等待稳定
        await page.waitForTimeout(300);
        // 读取url
        const currentUrl = page.url();
        sessionId = currentUrl.split('/a/chat/s/')[1]?.split('?')[0] ?? '';
        return sessionId;
    }

    async switchSession(sessionId: string = "") {
        return this.enqueueTask<string>(() => this._switchSession(sessionId));
    }

    // 发送按钮
    private async send(): Promise<boolean> {
        const page = await this.page;
        const coords = await page.evaluate(() => {
            const fileInput = document.querySelector('input[type="file"][multiple]');
            const target = fileInput?.nextElementSibling?.querySelector('[aria-disabled="false"]');
            if (!target) return null;
            const rect = (target as HTMLElement).getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        });
        if (!coords) return false;
        await page.mouse.click(coords.x, coords.y);
        return true;
    }

    // 输入消息
    private async textInput(text: string): Promise<boolean> {
        const page = await this.page;
        return page.locator('textarea[autocomplete="off"]').fill(text).then(() => true).catch(() => false);
    }

    // 删除会话
    private async _deleteSession(sessionId: string): Promise<boolean | null> {
        const page = await this.page;

        // 监听请求，判断是否删除成功
        const {promise, resolve, reject} = Promise.withResolvers<boolean>();
        const onResponse = (response: { url: () => string; request: () => { method: () => string; }; ok: () => boolean; }) => {
            if (!response.url().includes("/api/v0/chat_session/delete")) return;
            page.off("response", onResponse);
            resolve(response.ok());
        };
        page.on("response", onResponse);

        let result = await page.evaluate(async (id: string) => {
            // 1. 打开菜单
            const target = document.querySelector(`[href="/a/chat/s/${id}"]`)
                ?.lastElementChild
                ?.querySelector('[aria-disabled="false"]');
            if (!target) return null;

            (target as HTMLElement).click();
            await new Promise(r => setTimeout(r, 300));

            // 2. 点击删除选项
            let found = false;
            const deleteOptions = document.querySelectorAll('.ds-dropdown-menu-option__label');
            for (let i = 0; i < deleteOptions.length; i += 1) {
                const option = deleteOptions[i];
                if (option.textContent?.includes('删除')) {
                    (option as HTMLElement).click();
                    found = true;
                    await new Promise(r => setTimeout(r, 300));
                    break;
                }
            }
            if (!found) return false;

            // 3. 定位并点击删除确认按钮
            const confirmDeleteBtn = document.querySelector('button[role="button"][aria-disabled="false"].ds-basic-button--danger');
            if (!confirmDeleteBtn) return false;
            (confirmDeleteBtn as HTMLElement).click();
            return true;
        }, sessionId);

        if (!result) {
            page.off("response", onResponse);
            return result;
        }

        const t = setTimeout(() => reject(false), 3000);
        try {
            return await promise;
        } catch {
            return false;
        } finally {
            clearTimeout(t);
            page.off("response", onResponse);
        }
    }

    async deleteSession(sessionId: string): Promise<boolean | null> {
        return this.enqueueTask<boolean | null>(() => this._deleteSession(sessionId));
    }

    async chatCompletions(params: {
        sessionId?: string; // 不填就新建会话
        message: string;
        modelType?: string | null; // 可以是 'expert'; null 为快速模式 'default'
        fileIds?: string[];
        searchEnabled?: boolean;
        thinkingEnabled?: boolean;
        preempt?: boolean;
        parentMessageId?: number | null;   // null为第一句话 此参数影响上下文 超过现有长度会报错
        signal?: AbortSignal;
    }) {
        return this.enqueueTask<ChatCompletionResult>(async () => {
            const page = await this.page;
            const sessionIdFromUrl = await this.withAbort(this._switchSession(params.sessionId ?? ""), params.signal);
            let capturedSessionId = sessionIdFromUrl;
            // 监听请求，篡改参数，并拿到sessionId
            const routePattern = "**/api/v0/chat/completion";
            const routeHandler = async (route: Route) => {
                const request = route.request();
                const payload = this.parseJsonSafely(request.postData() ?? "{}") ?? {};
                // 检查prompt是否和要求的一致，来判断是否为目标请求
                if (!payload.prompt || (payload.prompt as string).trimStart()[0] !== params.message.trimStart()[0]) return;
                // 使用请求的sessionId，因为新建会话拿不到sessionId的情况
                payload.chat_session_id = payload.chat_session_id ?? sessionIdFromUrl;
                if (typeof payload.chat_session_id === "string" && payload.chat_session_id.length > 10) {
                    capturedSessionId = payload.chat_session_id;
                } else {
                    // 一定有
                    throw new Error(`Failed to capture session ID from request payload: ${request.postData()}`);
                }
                if (params.modelType !== undefined) payload.model_type = params.modelType;
                if (params.fileIds !== undefined) payload.ref_file_ids = params.fileIds;
                if (params.searchEnabled !== undefined) payload.search_enabled = params.searchEnabled;
                if (params.thinkingEnabled !== undefined) payload.thinking_enabled = params.thinkingEnabled;
                if (params.parentMessageId !== undefined) payload.parent_message_id = params.parentMessageId;
                if (params.preempt !== undefined) payload.preempt = params.preempt;
                // payload.prompt = params.message;
                await route.continue({ postData: JSON.stringify(payload) });
                await page.unroute(routePattern, routeHandler);
            };
            await page.route(routePattern, routeHandler);
            // 等待结果
            try {
                // 发起请求
                const inputOk = await this.withAbort(this.textInput(params.message), params.signal);
                if (!inputOk) throw new Error("Failed to input message into DeepSeek textbox.");
                const responsePromise = page.waitForResponse((response) => {
                    if (!response.url().includes("/api/v0/chat/completion")) return false;
                    // 用sessionId 核对是否为目标请求
                    const postData = this.parseJsonSafely(response.request().postData() ?? "{}") ?? {};
                    return postData.chat_session_id === capturedSessionId;
                });
                const sent = await this.withAbort(this.send(), params.signal);
                if (!sent) throw new Error("Failed to click DeepSeek send button.");

                const response = await this.withAbort(responsePromise, params.signal);
                const contentType = response.headers()["content-type"] ?? "";
                const raw = await this.withAbort(response.text(), params.signal);
                if (!contentType.includes("text/event-stream")) {
                    throw new Error(`Unexpected content type[${contentType}] for chat completion response: ${raw}`);
                }

                return {
                    sessionId: capturedSessionId,
                    body: raw,  // 框架无法捕获流，只能一次性获取全部文本
                };
            } finally {
                await page.unroute(routePattern, routeHandler);
            }
        });
    }
}