import process from "node:process";
import { createInterface } from "node:readline/promises";
import { getDefaultCredentialPath, loadCredentials } from "../auth.js";
import { DeepSeekWebClient } from "../deepseekWebClient.js";
import { DeepseekStreamParser } from "../deepseekStreamParser.js";
import { isDirectRun } from "../utils.js";
import { parseArgs } from "node:util";

interface ChatResult {
    text: string;
    thinking: string;
    messageId: number | null;
    sessionId: string;
}

async function chatWithDeepSeek(
    client: DeepSeekWebClient,
    params: {
        message: string;
        sessionId?: string;
        parentMessageId?: number | null;
        onDelta?: (type: string, delta: string) => void,
    }): Promise<ChatResult> {
    const session = params.sessionId ?? await client.createChatSession();
    const body = await client.chatCompletions({
        sessionId: session,
        message: params.message,
        modelType: null,
        searchEnabled: true,
        thinkingEnabled: false,
        parentMessageId: params.parentMessageId ?? null,
    });
    return await parseDeepSeekSse(body, session, params.onDelta);
}

async function parseDeepSeekSse(
    body: ReadableStream<Uint8Array>,
    sessionId: string,
    onDelta?: (type: string, delta: string) => void,
): Promise<ChatResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new DeepseekStreamParser(onDelta);
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            parser.finish();
            break;
        }
        const chunk = decoder.decode(value, { stream: true });
        parser.push(chunk);
    }

    let messageId = parser.decoder.state.message.response?.message_id;
    if (typeof messageId === "number") {
    } else if (typeof messageId === "string") {
        const parsed = Number(messageId);
        messageId = Number.isFinite(parsed) ? parsed : null;
    } else messageId = null;

    return {
        text: parser.text('RESPONSE'),
        thinking: parser.text('THINK'),
        messageId,
        sessionId,
    };
}

async function runInteractiveChat(credentialsPath?: string, initialMessage?: string, deleteSession = false) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const credentials = loadCredentials(credentialsPath ?? getDefaultCredentialPath());
    const client = new DeepSeekWebClient({
        cookie: credentials.cookie,
        bearer: credentials.bearer,
        userAgent: credentials.userAgent,
    });
    let sessionId: string | undefined;
    let parentMessageId: number | null = null;

    rl.on("SIGINT", async () => {
        rl.close();
        process.stdout.write("\nExited chat.\n");
        if (deleteSession && sessionId) {
            await client.deleteSession(sessionId);
            process.stdout.write("Deleted chat session.\n");
        }
        process.exit(0);
    });

    process.stdout.write("Interactive chat mode. Press Ctrl+C to exit.\n");

    while (true) {
        let message: string;
        if (initialMessage) {
            message = initialMessage;
            initialMessage = undefined;
        } else {
            message = (await rl.question("you> ")).trim();
        }
        if (!message) continue;

        let state: string | null = null;
        const result = await chatWithDeepSeek(client, {
            message,
            sessionId,
            parentMessageId,
            onDelta: (type: string, delta) => {
                if (state !== null && type !== state) {
                    process.stdout.write("\n");
                }
                state = type;
                if (type === "THINK") {
                    process.stdout.write(`\x1b[90m${delta}\x1b[0m`);
                } else if (type === "RESPONSE") {
                    process.stdout.write(delta);
                }
            },
        });

        if (!result.text.endsWith("\n")) {
            process.stdout.write("\n");
        }

        sessionId = result.sessionId;
        parentMessageId = result.messageId;
    }
}

async function runSingleChat(message: string, credentialsPath?: string, deleteSession = false) {
    if (!message) throw new Error("Missing chat message.");

    const credentials = loadCredentials(credentialsPath || getDefaultCredentialPath());
    const client = new DeepSeekWebClient({
        cookie: credentials.cookie,
        bearer: credentials.bearer,
        userAgent: credentials.userAgent,
    });
    // client.logout();
    // return;
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
    }
}

async function runChatCli() {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
            credentials: { type: "string", short: "c" },
            interactive: { type: "boolean", short: "i" },
            delete: { type: "boolean", short: "d" },
        },
        allowPositionals: true,
        strict: true,
    });

    const credentialsPath = parsed.values.credentials;
    const message = parsed.positionals.join(" ").trim();

    if (parsed.values.interactive) {
        await runInteractiveChat(credentialsPath, message, parsed.values.delete);
        return;
    }
    await runSingleChat(message, credentialsPath, parsed.values.delete);
}


if (isDirectRun(import.meta.url)) {
    console.log("Starting DeepSeek chat...");
    runChatCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}

