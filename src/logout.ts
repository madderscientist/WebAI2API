import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { getDefaultCredentialPath, loadCredentials } from "./auth.js";
import { getDefaultUserDataDir } from "./browser.js";
import { DeepSeekWebClient } from "./deepseekWebClient.js";
import { isDirectRun } from "./utils.js";

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 注销并清理本地登录数据；执行前需关闭占用 profile 的浏览器和服务 */
export async function logout(params: { credentialsPath?: string; userDataDir?: string } = {}): Promise<void> {
    const profilePath = path.resolve(params.userDataDir ?? getDefaultUserDataDir());
    const credentialsPath = path.resolve(params.credentialsPath ?? getDefaultCredentialPath());

    // 只删 .data 子目录，并校验真实路径，防止目录联接绕过检查
    const profile = fs.lstatSync(profilePath, { throwIfNoEntry: false });
    if (!isInside(path.join(process.cwd(), ".data"), profilePath) || profile?.isSymbolicLink() ||
        (profile && !isInside(path.join(fs.realpathSync(process.cwd()), ".data"), fs.realpathSync(profilePath)))) {
        throw new Error("Refusing to delete a linked profile or a profile outside the project's .data subdirectories.");
    }

    // 注销失败时保留文件；凭证不存在时仍允许继续清理本地数据。
    if (fs.statSync(credentialsPath, { throwIfNoEntry: false })) {
        const credentials = loadCredentials(credentialsPath);
        if (typeof credentials?.bearer !== "string" || !credentials.bearer.trim()) {
            throw new Error(`Invalid credentials in ${credentialsPath}: missing bearer token.`);
        }
        await new DeepSeekWebClient(credentials).logout();
    } else {
        console.warn(`[logout] No credentials found at ${credentialsPath}; server logout skipped. Only local login data will be removed.`);
    }

    // 先删凭证，避免 profile 清理失败后重试时复用已失效的 token
    fs.rmSync(credentialsPath, { force: true });
    console.log(`[logout] Credentials removed (or already absent): ${credentialsPath}`);
    try {
        fs.rmSync(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
        throw new Error(`Failed to remove profile ${profilePath}. Close browsers and services using it, then retry.`, { cause: error });
    }
    console.log(`[logout] Profile removed (or already absent): ${profilePath}`);
}

if (isDirectRun(import.meta.url)) {
    try {
        const { values } = parseArgs({
            options: {
                credentials: { type: "string", short: "c" },
                "user-data-dir": { type: "string" },
            },
        });
        await logout({ credentialsPath: values.credentials, userDataDir: values["user-data-dir"] });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
