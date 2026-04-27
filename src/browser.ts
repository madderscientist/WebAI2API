import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type BrowserLaunchResult = {
    process: ChildProcess;
    cdpUrl: string;
    userDataDir: string;
};

const CHROME_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
export const DEFAULT_CDP_PORT = 9222;

export function getDefaultCdpUrl() {
    return `http://127.0.0.1:${DEFAULT_CDP_PORT}`;
}

export function getDefaultUserDataDir() {
    return path.join(process.cwd(), ".data", `profile-${DEFAULT_CDP_PORT}`);
}

// 打开调试浏览器
export async function launchChromeForDebugging(params?: {
    cdpPort?: number;
    userDataDir?: string;   // 数据路径
    headless?: boolean;    // 是否无头模式，默认为 false
    detached?: boolean;    // 是否与当前终端分离，默认 false
}): Promise<BrowserLaunchResult> {
    const cdpPort = params?.cdpPort ?? DEFAULT_CDP_PORT;
    const userDataDir = params?.userDataDir ?? getDefaultUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });

    const child = spawn(
        CHROME_PATH,
        [
            `--remote-debugging-port=${cdpPort}`,
            `--user-data-dir=${userDataDir}`,
            "--no-first-run",   // 禁止显示欢迎页
            "--no-default-browser-check",   // 不要提示设为默认浏览器
            "--disable-sync",
            ...(params?.headless ? ["--headless=new", "--hide-scrollbars"] : []),   // 无头模式
        ],
        {
            stdio: "ignore",    // 不要再控制台打印浏览器日志
            detached: params?.detached ?? false,    // 关闭控制台浏览器页关闭
        },
    );

    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    await waitForDebuggerUrl(cdpUrl, 20000);
    return { process: child, cdpUrl, userDataDir };
}

// 轮询等待浏览器的调试服务完全启动，并获取 WebSocket 调试地址
export async function waitForDebuggerUrl(cdpUrl = getDefaultCdpUrl(), timeoutMs = 15000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(new URL("/json/version", cdpUrl), {
                signal: AbortSignal.timeout(2000),
            });
            if (res.ok) {
                const data = (await res.json()) as { webSocketDebuggerUrl?: string };
                if (data.webSocketDebuggerUrl) {
                    return data.webSocketDebuggerUrl;
                }
            }
        } catch {
            // keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for browser debugger at ${cdpUrl}`);
}