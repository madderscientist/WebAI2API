import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ChildProcess } from "node:child_process";
import { Browser, BrowserContext, chromium, Page, type Request, type Response } from "playwright-core";
import { getDefaultCdpUrl, launchChromeForDebugging, waitForDebuggerUrl } from "./browser.js";
import { isDirectRun } from "./utils.js";
import { parseArgs } from "node:util";

// 从浏览器中获取数据
export async function getLocalStorage(page: Page) {
    return await page.evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) data[key] = localStorage.getItem(key) || "";
        } return data;
    });
}

export async function readCookieString(
    context: BrowserContext,
    urls: string | readonly string[] | undefined
) {
    const cookies = await context.cookies(urls);
    if (cookies.length === 0) return "";
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export interface DeepSeekCredentials {
    cookie: string;
    bearer: string;
    userAgent: string;
}

export function saveCredentials(credentials: DeepSeekCredentials, outputPath: string) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
}

export function loadCredentials(inputPath: string): DeepSeekCredentials {
    return JSON.parse(fs.readFileSync(inputPath, "utf8")) as DeepSeekCredentials;
}

export function getDefaultCredentialPath() {
    return path.join(process.cwd(), ".data", "deepseek-credentials.json");
}

/**
 * 唤起浏览器获取凭证
 */
export async function auth(params?: {
    launchBrowser?: boolean;    // 是否启动浏览器; true: 自动唤起; false: 自己根据给定的端口启动调试浏览器
    cdp?: string | number;
    onProgress?: (message: string) => void;
    userDataDir?: string;   // 如果 launchBrowser 为 true，可以指定浏览器数据路径
    closeAfterAuth?: boolean;   // 是否在获取到凭证后关闭浏览器，默认为 true
}): Promise<DeepSeekCredentials> {
    const onProgress = params?.onProgress ?? (() => { });
    let cdpUrl, cdpPort;
    if (params?.cdp !== void 0) {
        if (typeof params.cdp === "number") {
            // 是端口 进入启动浏览器分支
            cdpPort = params.cdp;
            cdpUrl = `http://127.0.0.1:${cdpPort}`;
        } else {
            cdpUrl = params.cdp ?? getDefaultCdpUrl();
        }
    } else {
        cdpUrl = getDefaultCdpUrl();
    }
    let close: null | (() => Promise<void>) = null;

    // 启动浏览器 等到调试端口准备就绪
    if (params?.launchBrowser) {
        onProgress("Launching a dedicated browser profile for DeepSeek...");
        const launchedBrowser = await launchChromeForDebugging({ cdpPort, userDataDir: params.userDataDir });
        cdpUrl = launchedBrowser.cdpUrl;
        onProgress(`Launched browser with debugging port at ${cdpUrl}`);
        close = async () => {
            try {
                // 先通过 CDP 请求浏览器优雅退出，让用户数据有机会完整落盘
                const cdpSession = await browser.newBrowserCDPSession();
                await cdpSession.send("Browser.close");
                // 等待子进程自然退出；超时后再强制结束，避免长期残留
                await waitForProcessExit(launchedBrowser.process, 5000);
                if (!launchedBrowser.process.killed && launchedBrowser.process.exitCode === null) {
                    launchedBrowser.process.kill();
                }
            } catch { }
        };
    } else {
        onProgress(`Waiting for browser debugger at ${cdpUrl}...`);
        await waitForDebuggerUrl(cdpUrl);
    }

    var browser = await chromium.connectOverCDP(cdpUrl);
    console.log('Connected to browser');
    try {
        return await captureDeepSeekCredentials(browser, onProgress);
    } finally {
        if (params?.closeAfterAuth !== false) await close?.();
    }
}

async function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
        let finished = false;
        const done = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        proc.once("exit", done);
    });
}

/**
 * 通过监听获取凭证
 * 监听到就返回，不管有没有跳转
 */
export async function captureDeepSeekCredentials(
    browser: Browser,
    onProgress?: (message: string) => void,
    checkLocalStorage = true
): Promise<DeepSeekCredentials> {
    const context = browser.contexts()[0] || (await browser.newContext());  // 浏览器新账户
    let page = context.pages().find((p) => p.url().includes("deepseek.com")) ?? (await context.newPage());

    const { promise, resolve, reject } = Promise.withResolvers<DeepSeekCredentials>();
    let finished = false;

    // 监听获取 token
    var finish = async (bearer: string, userAgent?: string, info?: string) => {
        if (finished || !bearer) return;
        finished = true;
        cleanup();
        if (info) onProgress?.(info);
        userAgent ||= await page.evaluate(() => navigator.userAgent);
        // 之所以不用传递的cookie是因为请求里的cookie会加上很多临时的
        const cookie = await readCookieString(context, "https://chat.deepseek.com");
        resolve({
            cookie,
            bearer,
            userAgent,
        });
    };
    var onRequest = (request: Request) => {
        if (!request.url().includes("/api/v0/")) return;
        const h = request.headers();
        const auth = h.authorization;
        const userAgent = h["user-agent"];
        if (auth?.startsWith("Bearer ")) {
            finish(auth.slice(7), userAgent, `Captured credentials from a request to ${request.url()}`);
        }
    };
    var onResponse = async (response: Response) => {
        if (!response.url().includes("/api/v0/users/current") || !response.ok()) return;
        try {
            const body = (await response.json()) as {
                data?: { biz_data?: { token?: string } };
            };
            if (body.data?.biz_data?.token) {
                const h = response.request().headers();
                const userAgent = h["user-agent"];
                await finish(body.data.biz_data.token, userAgent, `Captured credentials from a response of ${response.url()}`);
            }
        } catch { }
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    var cleanup = () => {
        page.off("request", onRequest);
        page.off("response", onResponse);
    };
    page.on("close", () => {
        cleanup();
        reject(new Error("Browser page closed before credentials were captured."));
    });
    // getDSWasm(page, "./deepseek.wasm").then((wasmPath) => {}).catch(() => {});

    await page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" });    // 强制刷新

    // 检查localStorage
    if (checkLocalStorage) getLocalStorage(page).then((lc) => {
        const userToken = JSON.parse(lc["userToken"]).value;
        if (!userToken || typeof userToken !== "string") throw new Error("Invalid userToken in localStorage");
        if (finished) return promise; // 已经通过其他方式获取到token了
        finish(userToken, "Found an existing DeepSeek token in localStorage.");
    }).catch(() => {
        onProgress?.("Please finish logging into DeepSeek in the opened browser window.");
    });

    return promise;
}

/**
 * 监听wasm请求，并将结果下载到本地
 * @param page Playwright Page 实例
 * @returns Promise<string> wasm文件保存的本地路径
 */
function getDSWasm(page: Page, outputPath: string = './deepseek.wasm'): Promise<string> {
    return new Promise((resolve, reject) => {
        const onResponse = async (response: Response) => {
            try {
                const url = response.url();
                if (url.endsWith('.wasm')) {
                    const buffer = await response.body();
                    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                    fs.writeFileSync(outputPath, buffer);
                    page.off('response', onResponse);
                    resolve(path.resolve(outputPath));
                }
            } catch (err) {
                page.off('response', onResponse);
                reject(err);
            }
        };
        page.on('response', onResponse);
        page.on('close', () => {
            page.off('response', onResponse);
            reject(new Error("Browser page closed before wasm was captured."));
        });
    });
}

// 以下是cli
async function runAuthCli() {
    const args = parseArgs({
        args: process.argv.slice(2),
        options: {
            output: { type: "string", short: "o" },
            launch: { type: "boolean", short: "l" },
            cdp: { type: "string" },
            'user-data-dir': { type: "string" },
            keep: { type: "boolean", short: "k" },
        },
        allowPositionals: false,
        strict: true
    }).values;
    const output = args.output ?? getDefaultCredentialPath();
    let cdp: string | number | undefined = args.cdp;
    if (cdp !== undefined && /^\d+$/.test(cdp)) cdp = Number(cdp);
    const credentials = await auth({
        cdp,
        launchBrowser: args.launch === true,
        onProgress: (message: string) => console.log(`[auth] ${message}`),
        userDataDir: args['user-data-dir'],
        closeAfterAuth: args.keep !== true,
    });
    saveCredentials(credentials, output);
    console.log(`Saved credentials to ${output}`);
    return credentials;
}


if (isDirectRun(import.meta.url)) {
    console.log("Starting DeepSeek authentication...");
    runAuthCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}