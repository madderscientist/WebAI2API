// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// 以下截取了一些需要的，主要保证了：文本、图片、文件、函数调用

import { ServerChatRequest } from "../serverClient.js";

// ======= 输入 =======
export interface ChatCompletionsRequest {
    model: string;
    messages: ChatCompletionMessageParam[];
    stream?: boolean;
    tools?: ChatCompletionFunctionTool[];
    tool_choice?: ToolChoice;
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
        file_data?: string;
        file_id?: string;
        filename?: string;
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
import { ToolDescription, buildToolPrompt, ToolCallParser, toolCallFormat } from '../toolPrompt.js';

export function normalizeChatCompletionsRequest(req: Partial<ChatCompletionsRequest>): ServerChatRequest {
    if (!Array.isArray(req.messages)) {
        throw new Error('Missing messages array.');
    }
    
    // 构建 prompt 文本
    const toolDescriptions = (req.tools ?? [])
        .filter((tool)=>tool.type === 'function')
        .map(tool => tool.function as ToolDescription);
    const toolprompt = buildToolPrompt(toolDescriptions, req.tool_choice);
    const textMessages = buildPrompt(req.messages);
    let emphasisToolFormat = '';
    if (textMessages.length > 4514) {
        emphasisToolFormat = toolCallFormat;
    }
    return {
        message: [toolprompt, textMessages, emphasisToolFormat].filter((s): s is string => !!s).join('\n\n').trim(),
        sessionId: undefined,
        parentMessageId: null,
        preempt: false,
    };
}

function buildPrompt(messages: ChatCompletionMessageParam[]): string {
    const lines: string[] = [];

    function ChatCompletionContentPart2Text(part: ChatCompletionContentPart): string {
        if (part.type === 'text') return part.text;
        // 别的不管
        if (part.type === 'image_url') return '';
        if (part.type === 'file') return '';
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

// 暂时不处理文件和图片

export function message2CompletionsMessage(msg: string, matchTool = false): ChatCompletionAssistantMessageParam {
    const message: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: msg,
    };
    if (matchTool) {
        const toolCalls = ToolCallParser.parseToolCalls(msg);

        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls.map(call => ({
                id: call.raw,
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
