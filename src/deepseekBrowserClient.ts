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
    verbose = true;  // 是否输出调试日志

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
        // 依赖input进行定位
        const target = page.locator('input[type="file"][multiple] + * [aria-disabled="false"]').first();
        if (!await target.count()) return false;
        await target.scrollIntoViewIfNeeded();
        await target.click();
        return true;
    }

    // 输入消息
    private async textInput(text: string): Promise<boolean> {
        const page = await this.page;
        return page.locator('textarea[autocomplete="off"]').fill(text).then(() => true).catch(() => false);
    }

    private async _uploadFile(filePath: string): Promise<string> {
        if (this.verbose) console.log(`[DeepSeekBrowserClient] Starting file upload for ${filePath}`);
        const page = await this.page;
        // 如果当前页面不是deepseek则先跳转
        if (!page.url().includes("deepseek.com")) {
            await page.goto('https://chat.deepseek.com');
        }
        let fileId: string | null = null;

        // 监听上传响应获取 fileId
        const uploadHandler = (response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => {
            if (!response.url().includes("/api/v0/file/upload_file")) return;
            if (!response.ok()) return;
            response.json().then((data: unknown) => {
                const parsed = data as { data?: { biz_data?: { id?: string, file_name?: string } } };
                if (parsed.data?.biz_data?.file_name !== filePath.split('/').pop()) {
                    return; // 文件名不匹配，可能不是目标响应
                }
                fileId = parsed.data?.biz_data?.id ?? null;
                page.off("response", uploadHandler);
            }).catch(() => {
                // 忽略解析错误
            });
        };

        page.on("response", uploadHandler);

        try {
            // 触发上传
            await page.setInputFiles('input[type="file"][multiple]', filePath);

            // 等待获取 fileId
            let attempts = 0;
            while (!fileId && attempts < 30) {
                await new Promise((r) => setTimeout(r, 200));
                attempts++;
            }
            page.off("response", uploadHandler);
            if (!fileId) throw new Error("Failed to get fileId from upload response");

            // 监听 fetch_files 响应直到文件处理完成
            const { promise, resolve, reject } = Promise.withResolvers<void>();
            const fetchFilesHandler = (response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => {
                const url = response.url();
                if (!url.includes("fetch_files") || !url.includes(fileId!)) return;
                if (!response.ok()) return;
                response.json().then((data: unknown) => {
                    const parsed = data as { data?: { biz_data?: { files?: Array<{ id: string; status: string }> } } };
                    for (const file of parsed.data?.biz_data?.files ?? []) {
                        if (file.id !== fileId) continue;
                        if (file.status === "PARSING") continue;
                        if (file.status === "SUCCESS") {
                            resolve();
                            return;
                        }
                        if (file.status === "FAILED") {
                            reject(new Error(`File processing failed for fileId ${fileId}`));
                            return;
                        }
                        if (file?.status === "CONTENT_EMPTY") {
                            reject(new Error(`File processing failed due to empty content for fileId ${fileId}`));
                            return;
                        }
                    }
                }).catch(() => {
                    // 忽略解析错误
                });
            };
            page.on("response", fetchFilesHandler);

            try {
                // 等待文件处理完成，超时为60秒
                await Promise.race([
                    promise,
                    new Promise<void>((_, reject) =>
                        setTimeout(() => reject(new Error(`File upload polling timed out for ${fileId}`)), 60000)
                    )
                ]);
                return fileId;
            } catch (error) {
                // 失败则取消上传的文件 其实没必要因为每次对话都会刷新页面 文件是可以跨对话的
                await page.evaluate(() => {
                    const container = document.querySelector('._75e1990');
                    if (!container) window.location.reload(); // 无法找到删除按钮，刷新页面重试
                    // 删除最后一个 由于本函数只上传一个 所以删除最后一个就是刚上传的那个
                    (container!.children[container!.childElementCount - 1]?.querySelector('.ds-icon') as HTMLElement)?.click();
                });
                throw error;
            } finally {
                page.off("response", fetchFilesHandler);
            }
        } finally {
            page.off("response", uploadHandler);
        }
    }

    async uploadFile(filePath: string): Promise<string> {
        return this.enqueueTask<string>(() => this._uploadFile(filePath));
    }

    // 删除会话
    private async _deleteSession(sessionId: string): Promise<boolean | null> {
        if (this.verbose) console.log(`[DeepSeekBrowserClient] Deleting session: ${sessionId}`);
        const page = await this.page;

        // 监听请求，判断是否删除成功
        const { promise, resolve, reject } = Promise.withResolvers<boolean>();
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
            if (this.verbose) console.log(`[DeepSeekBrowserClient] Starting chat completion.`);
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