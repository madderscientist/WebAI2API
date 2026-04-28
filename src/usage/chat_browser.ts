import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { DeepSeekBrowserClient } from "../deepseekBrowserClient.js";
import { DeepseekStreamParser } from "../deepseekStreamParser.js";
import { launchChromeForDebugging } from "../browser.js";
import { isDirectRun } from "../utils.js";

interface ChatResult {
    text: string;
    thinking: string;
    messageId: number | null;
    sessionId: string;
}

async function createBrowserClient(userDataDir?: string) {
    const launched = await launchChromeForDebugging({
        userDataDir: userDataDir,
        headless: true,
        detached: true,
    });
    const browser = await chromium.connectOverCDP(launched.cdpUrl);
    const client = new DeepSeekBrowserClient(browser);

    const close = async () => {
        try {
            await browser.close();
            if (!launched.process.killed && launched.process.exitCode === null) {
                launched.process.kill();
            }
        } catch {
            // ignore
        }
    };

    return { browser, client, close };
}

async function chatWithDeepSeek(
    client: DeepSeekBrowserClient,
    params: {
        message: string;
        sessionId?: string;
        parentMessageId?: number | null;
        onDelta?: (type: string, delta: string) => void,
    },
): Promise<ChatResult> {
    const result = await client.chatCompletions({
        sessionId: params.sessionId,
        message: params.message,
        modelType: null,
        searchEnabled: true,
        thinkingEnabled: false,
        parentMessageId: params.parentMessageId ?? null,
    });
    // 基于浏览器的client，返回结果没有流式
    const parser = new DeepseekStreamParser(params.onDelta);
    parser.parseAll(result.body);

    let messageId = parser.decoder.state.message.response?.message_id;
    if (typeof messageId === "number") {
        if (!Number.isFinite(messageId)) messageId = null;
    } else if (typeof messageId === "string") {
        const parsed = Number(messageId);
        messageId = Number.isFinite(parsed) ? parsed : null;
    } else messageId = null;

    return {
        text: parser.text("RESPONSE"),
        thinking: parser.text("THINK"),
        messageId,
        sessionId: result.sessionId,
    };
}

async function runInteractiveChat(userDataDir?: string, initialMessage?: string, deleteSession = false) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const { client, close } = await createBrowserClient(userDataDir);
    let sessionId: string | undefined;
    let parentMessageId: number | null = null;
    let exiting = false;

    const safeExit = async () => {
        if (exiting) return;
        exiting = true;
        rl.close();
        process.stdout.write("\nExited chat.\n");
        if (deleteSession && sessionId) {
            try {
                await client.deleteSession(sessionId);
                process.stdout.write("Deleted chat session.\n");
            } catch (error) {
                process.stdout.write(`Failed to delete chat session: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
        await close();
        process.exit(0);
    };

    rl.on("SIGINT", () => {
        void safeExit();
    });
    process.once("SIGINT", () => {
        void safeExit();
    });

    process.stdout.write("Interactive browser chat mode. Press Ctrl+C to exit.\n");

    while (true) {
        let message: string;
        if (initialMessage) {
            message = initialMessage;
            initialMessage = undefined;
        } else {
            message = (await rl.question("you> ")).trim();
        }
        if (!message) continue;

        const result = await chatWithDeepSeek(client, {
            message,
            sessionId,
            parentMessageId,
        });
        if (result.thinking) {
            process.stdout.write(`\x1b[90m${result.thinking}\x1b[0m\n`);
        }
        process.stdout.write(result.text);
        if (!result.text.endsWith("\n")) {
            process.stdout.write("\n");
        }

        sessionId = result.sessionId;
        if (typeof result.messageId === "number") {
            parentMessageId = result.messageId;
        } else if (typeof result.messageId === "string") {
            const parsed = Number(result.messageId);
            parentMessageId = Number.isFinite(parsed) ? parsed : null;
        } else {
            parentMessageId = null;
        }
    }
}

async function runSingleChat(message: string, userDataDir?: string, deleteSession = false) {
    if (!message) throw new Error("Missing chat message.");

    const { client, close } = await createBrowserClient(userDataDir);
    try {
        let state: string | null = null;
        const result = await chatWithDeepSeek(client, {
            message,
            onDelta: (type: string, delta) => {
                if (state !== null && type !== state) {
                    process.stdout.write("\n---------\n");
                }
                state = type;
                if (type === "THINK") {
                    process.stdout.write(`\x1b[90m${delta}\x1b[0m`);
                } else {
                    process.stdout.write(delta);
                }
            },
        });

        if (!result.text.endsWith("\n")) {
            process.stdout.write("\n");
        }

        if (deleteSession) {
            await client.deleteSession(result.sessionId);
            process.stdout.write("Deleted chat session.\n");
        }
    } finally {
        await close();
    }
}

async function runChatBrowserCli() {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
            interactive: { type: "boolean", short: "i" },
            delete: { type: "boolean", short: "d" },
            "user-data-dir": { type: "string" },
        },
        allowPositionals: true,
        strict: true,
    });

    const message = parsed.positionals.join(" ").trim();
    const userDataDir = parsed.values["user-data-dir"];

    if (parsed.values.interactive) {
        await runInteractiveChat(userDataDir, message, parsed.values.delete);
        return;
    }
    await runSingleChat(message, userDataDir, parsed.values.delete);
}

if (isDirectRun(import.meta.url)) {
    console.log("Starting DeepSeek browser chat...");
    runChatBrowserCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}

