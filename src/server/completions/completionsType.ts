// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// 以下截取了一些需要的，主要保证了：文本、图片、文件、函数调用

import type { ServerChatRequest } from "../../deepseekWebClient.js";
import { getModelConfig } from "../models.js";

// ======= 输入 =======
export interface ChatCompletionsRequest {
    model: string;
    messages: ChatCompletionMessageParam[];
    stream?: boolean;
    tools?: ChatCompletionFunctionTool[];
    tool_choice: ToolChoice;    // 在 asChatCompletionsRequest 中会自动填充默认值
}

export type ChatCompletionMessageParam =
    | ChatCompletionBasicMessageParam
    | ChatCompletionAssistantMessageParam
    | ChatCompletionToolMessageParam;

export interface ChatCompletionBasicMessageParam {
    role: 'system' | 'developer' | 'user';
    content?: string | ChatCompletionContentPart[];
    name?: string;
};
export interface ChatCompletionToolMessageParam {
    role: 'tool';
    content?: string | ChatCompletionContentPartText[]; // 函数返回
    tool_call_id: string;   // 约定为函数调用 <tool>name<params>{"param1":value1}</params></tool>
}
// 历史 也是输出
export interface ChatCompletionAssistantMessageParam {
    role: 'assistant';
    content?: string | ChatCompletionContentPart[];
    reasoning_content?: string;   // 推理过程文本
    name?: string;
    tool_calls?: ChatCompletionMessageFunctionToolCall[];    // tool_calls 和 content 必有其一
};

// content
export type ChatCompletionContentPart =
    | ChatCompletionContentPartText
    | ChatCompletionContentPartImage
    | FileContentPart;
export interface ChatCompletionContentPartText {
    type: 'text';
    text: string;
}
export interface ChatCompletionContentPartImage {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
    };
}
export interface FileContentPart {
    type: 'file';
    file: {
        file_data?: string; // base64
        file_id?: string;
        filename?: string;
        // completions 没有 file_url. 下面的是我加的
        file_url?: string;
    }
}

// tools
export interface ChatCompletionFunctionTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
export interface ChatCompletionMessageFunctionToolCall {
    id: string; // 是原始调用
    type: 'function';
    function: {
        name: string;
        arguments: string;  // json格式
    };
}
export type ToolChoice =
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } };


// ======= 输出 =======
export interface ChatCompletionsResponse {
    id: string; // sessionId|messageId; 其实没用因为会立即删除对话
    object: 'chat.completion';
    created: number;
    model: string;
    choices: {
        index: number;
        message: ChatCompletionAssistantMessageParam;
        finish_reason?: CompletionsFinishReason;
    }[];
    usage: {
        total_tokens: number;
        prompt_tokens: number;
        completion_tokens: number;
    };
}
export type CompletionsFinishReason = null | 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'function_call';

// ===== 转为模型输入 =====
import { ToolDescription, buildToolPrompt, ToolCallParser, toolCallFormat, autoToolChoice, shouldParseToolCall } from '../toolPrompt.js';

// 类型转换 & 填充默认值
export function asChatCompletionsRequest(req: any): ChatCompletionsRequest {
    if (!Array.isArray(req.messages)) req.messages = [];
    req.tool_choice ??= autoToolChoice(req.tools);
    return req as ChatCompletionsRequest;
}

export function normalizeChatCompletionsRequest(req: ChatCompletionsRequest): ServerChatRequest & { model: string } {
    if (!Array.isArray(req.messages)) throw new Error('Missing messages array.');
    const modelConfig = getModelConfig(req.model);

    // 构建 prompt 文本
    const parsetool = shouldParseToolCall(req.tool_choice, req.tools);
    const toolDescriptions = (req.tools ?? [])
        .filter((tool) => tool.type === 'function')
        .map(tool => tool.function as ToolDescription);
    const toolprompt = buildToolPrompt(req.tool_choice, toolDescriptions);
    const textMessages = buildPrompt(req.messages);
    let emphasisToolFormat = '';
    if (parsetool && textMessages.length > 4514) {
        emphasisToolFormat = toolCallFormat;
    }
    return {
        message: [toolprompt, textMessages, emphasisToolFormat].filter((s): s is string => !!s).join('\n\n').trim(),
        sessionId: undefined,
        parentMessageId: null,
        preempt: false,
        model: modelConfig.model,   // 尽量保留原始model字段
        modelType: modelConfig.modelType,
        searchEnabled: modelConfig.searchEnabled,
        thinkingEnabled: modelConfig.thinkingEnabled,
    };
}

function buildPrompt(messages: ChatCompletionMessageParam[]): string {
    const lines: string[] = [];

    function ChatCompletionContentPart2Text(part: ChatCompletionContentPart): string {
        if (part.type === 'text') return part.text;
        // 只生成占位信息，具体文件需要其他地方上传
        if (part.type === 'image_url') return '<user_image />';
        if (part.type === 'file') {
            const file_str = ['<user_file'];
            if (part.file.filename) file_str.push(`name="${part.file.filename}"`);
        }
        return '';
    }

    for (const message of messages) {
        if (message.role === 'tool') {
            lines.push(`[user tool call result]:`);
            let contentText: string[] = [];
            if (typeof message.content === 'string') {
                contentText.push(message.content);
            } else if (Array.isArray(message.content)) {
                for (const contentItem of message.content) {
                    contentText.push(contentItem.text);
                }
            }
            lines.push(`${message.tool_call_id}\n<output>${contentText.join('\n')}</output>`);
        } else if (message.role === 'assistant') {
            lines.push('[assistant]:');
            if (typeof message.content === 'string') {
                lines.push(message.content);
            } else if (Array.isArray(message.content)) {
                for (const contentItem of message.content) {
                    const t = ChatCompletionContentPart2Text(contentItem);
                    if (t) lines.push(t);
                }
            }
            for (const toolCall of message.tool_calls ?? []) {
                if (toolCall.type !== 'function') continue;
                lines.push(`<tool>${toolCall.function.name}<params>${toolCall.function.arguments}</params></tool>`)
            }
        } else {    // system/developer/user
            lines.push(`[${message.role}]:`);
            if (typeof message.content === 'string') {
                lines.push(message.content);
            } else {
                for (const contentItem of message.content ?? []) {
                    const t = ChatCompletionContentPart2Text(contentItem);
                    if (t) lines.push(t);
                }
            }
        }
    }
    return lines.join("\n\n");
}

export function message2CompletionsMessage(msg: string, matchTool = false): ChatCompletionAssistantMessageParam {
    const message: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: msg,
    };
    if (matchTool) {
        const toolCalls = ToolCallParser.parseToolCalls(msg);

        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls.map(call => ({
                id: ToolCallParser.buildCallId(call.tool, call.parameters),
                type: 'function',
                function: {
                    name: call.tool,
                    arguments: call.parameters,
                }
            }));

            // 从content中删除tool调用的文本，替换为占位符
            const textChunks: string[] = [];
            let cursor = 0;

            for (const call of toolCalls) {
                if (call.start < cursor) continue;

                const textBefore = msg.slice(cursor, call.start).trim();
                if (textBefore) textChunks.push(textBefore);

                textChunks.push(`<tool_call>${call.tool}</tool_call>`);
                cursor = call.start + call.raw.length;
            }

            const tailText = msg.slice(cursor).trim();
            if (tailText) textChunks.push(tailText);

            const cleanedContent = textChunks.join('\n\n').trim();
            if (cleanedContent) {
                message.content = cleanedContent;
            } else {
                delete message.content;
            }
        }
    }

    return message;
}


import { ServerClient } from "../serverClient.js";
import { base642Buffer } from "../../utils.js";

function _uploadFiles(contents: ChatCompletionContentPart[], client: ServerClient, modelType: ServerChatRequest["modelType"]): Promise<string[]> {
    const promises: Promise<string>[] = [];
    for (const part of contents) {
        switch (part.type) {
            case 'file':
                if (part.file.file_id) {
                    promises.push(Promise.resolve(part.file.file_id));
                } else if (part.file.file_data) {
                    const buffer = base642Buffer(part.file.file_data);
                    promises.push(client.uploadFile(buffer, part.file.filename ?? 'file', modelType));
                } else if (part.file.file_url) {
                    promises.push(client.uploadFile(part.file.file_url, part.file.filename ?? 'file', modelType));
                } break;
            case 'image_url':
                promises.push(client.uploadFile(part.image_url.url, 'image', modelType));
                break;
            default:
                break;
        }
    } return Promise.all(promises);
}

export function uploadFiles(req: ChatCompletionsRequest, client: ServerClient, modelType: ServerChatRequest["modelType"]): Promise<string[]> {
    const msgs = req.messages;
    if (!msgs) return Promise.resolve([]);
    const contents: ChatCompletionContentPart[] = [];
    for (const msg of msgs) {
        if (Array.isArray(msg.content)) {
            for (const contentItem of msg.content) {
                if (contentItem.type !== 'text') {
                    contents.push(contentItem);
                }
            }
        }
    }
    return _uploadFiles(contents, client, modelType);
}