// https://developers.openai.com/api/reference/resources/responses/methods/create
import { ToolChoice } from './completionsType.js';

// ======= 输入 =======
export interface ResponsesCreateRequest {
    model?: string;
    input: string | ResponsesInputItem[];
    stream?: boolean;
    tools?: ResponsesFunctionTool[];
    tool_choice?: ToolChoice;
    // 对话上下文关联 放弃了conversation字段
    previous_response_id?: string; // session_id|message_id
}

// 只选了这几个
export type ResponsesInputItem =
    | EasyInputMessage
    | FunctionCallOutput
    | LocalShellCallOutput;

// 消息类型
export interface EasyInputMessage {
    type?: 'message';   // 缺省类型是message
    role: 'system' | 'developer' | 'user' | 'assistant';
    content: string | ResponseInputContent[];
    // phase?: 'commentary' | 'final_answer'; 不实现
}

export type ResponseInputContent = ResponseInputText | ResponseInputImage | ResponseInputFile;
export interface ResponseInputText {
    text: string;
    type: 'input_text';
}
export interface ResponseInputImage {
    detail: 'auto' | 'low' | 'high' | 'original';
    type: 'input_image';
    file_id?: string;
    image_url?: string;
}
export interface ResponseInputFile {
    detail: 'low' | 'high';
    type: 'input_file';
    file_id?: string;
    file_url?: string;
    file_name?: string;
}

// 调用结果
export interface FunctionCallOutput {
    call_id: string;    // 约定使用 toolcall 的 json
    output: string;
    type: 'function_call_output';
    // id?: string;
    status?: callStatus;
}

export interface LocalShellCallOutput {
    id: string;
    output: string;
    type: 'local_shell_call_output';
    status?: callStatus;
}

export type callStatus = 'Inprogress' | 'Completed' | 'Incomplete';

// tools
export interface ResponsesFunctionTool {
    type: 'function';
    name: string;
    parameters?: Record<string, unknown>;
    description?: string;
}


// ======= 输出 =======
export interface ResponsesCreateResponse {
    id: string; // session_id|message_id
    object: 'response';
    created_at: number;
    status: 'completed' | 'in_progress' | 'failed' | 'cancelled' | 'incomplete' | 'queued';
    model: string;
    output: ResponseOutputItem[];
    usage: {
        total_tokens: number;
    };
}

export type ResponseOutputItem =
    | ResponseOutputMessage
    | ResponseOutputFuncionCall
    | ResponseOutputLocalShellCall;

export interface ResponseOutputMessage {
    type: 'message' | 'reasoning';
    // id: string;  // 统一到 ResponsesCreateResponse.id
    content: string;
    role: 'assistant';
}
export interface ResponseOutputFuncionCall {
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;  // json格式
}
export interface ResponseOutputLocalShellCall {
    type: 'local_shell_call';
    id: string;
    action: {
        command: string[];
        timeout_ms?: number;
        working_directory?: string;
        type: 'exec';
    };
}


// ===== 转为模型输入 =====
import { ServerChatRequest } from './serverClient.js';
import { parseResponseId } from './responseId.js';
import { ToolDescription, buildToolPrompt, parseShellCommands, parseToolCalls } from './toolPrompt.js';

export function normalizeResponsesRequest(x: ResponsesCreateRequest): ServerChatRequest {
    const { sessionId, messageId } = parseResponseId(x.previous_response_id ?? '');

    // 构建prompt
    const toolDescriptions = (x.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    } as ToolDescription));
    const toolprompt = buildToolPrompt(toolDescriptions, x.tool_choice, true);
    const textMessages = messageFromInputItem(x.input, toolprompt.length < 10);

    return {
        message: [toolprompt, textMessages].filter((s): s is string => !!s).join('\n\n').trim(),
        sessionId: sessionId ?? undefined,
        parentMessageId: messageId ?? null,
        preempt: false,
    }
}

// 处理 message function_call_output local_shell_call_output
function messageFromInputItem(items: string | ResponsesInputItem[], dropFirstRole = false): string {
    if (typeof items === 'string') return items;
    if (items.length === 0) return '';

    function easyInputToText(item: EasyInputMessage): string[] {
        const outputs: string[] = [];
        if (typeof item.content === 'string') {
            outputs.push(item.content);
        } else {
            for (const contentItem of item.content) {
                if (contentItem.type === 'input_text') {
                    outputs.push(contentItem.text);
                }
                // 其他的(图片/文件)不处理
            }
        } return outputs;
    }

    const messages: string[] = [];

    for (const item of items) {
        if (!item.type || item.type === 'message') {
            messages.push(`[${item.role}]:`);
            messages.push(...easyInputToText(item as EasyInputMessage));
        } else if (item.type === 'function_call_output') {
            messages.push(`[user tool call result]:\n<call>${item.call_id}</call>\n<output>${item.output}</output>${item.status ? `\n<status>${item.status}</status>` : ''}`);
        } else if (item.type === 'local_shell_call_output') {
            messages.push(`[user local shell call result]:\n<shell>\n${item.id}\n${item.output}\n</shell>`);
        }
    }
    // 如果只有一项且是用户消息则不需要role标签
    if (dropFirstRole && items.length === 1 && (items[0].type === undefined || items[0].type === 'message') && items[0].role === 'user') {
        messages.shift();
    }
    return messages.join('\n\n');
}

// 暂时不处理文件


export function message2ResponsesOutput(msg: string, matchTool = false, matchShell = false): ResponseOutputItem[] {
    const outputs: ResponseOutputItem[] = [];

    type ParsedSegment = {
        start: number;
        end: number;
        output: ResponseOutputItem;
    };

    const segments: ParsedSegment[] = [];

    if (matchTool) {
        const toolCalls = parseToolCalls(msg);
        for (const call of toolCalls) {
            segments.push({
                start: call.start,
                end: call.start + call.raw.length,
                output: {
                    type: 'function_call',
                    call_id: call.raw,  // 【重要】设置为源码
                    name: call.tool,
                    arguments: call.parameters,
                },
            });
        }
    }

    if (matchShell) {
        const shellCommands = parseShellCommands(msg);
        for (const cmd of shellCommands) {
            segments.push({
                start: cmd.start,
                end: cmd.start + cmd.raw.length,
                output: {
                    type: 'local_shell_call',
                    id: cmd.raw,
                    action: {
                        command: [cmd.command],
                        type: 'exec',
                    },
                },
            });
        }
    }

    segments.sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        return b.end - a.end;
    });

    let cursor = 0;
    for (const segment of segments) {
        if (segment.start < cursor) continue;

        const textBefore = msg.slice(cursor, segment.start).trim();
        if (textBefore) {
            outputs.push({
                type: 'message',
                content: textBefore,
                role: 'assistant',
            });
        }

        outputs.push(segment.output);
        cursor = segment.end;
    }

    const tailText = msg.slice(cursor).trim();
    if (tailText) {
        outputs.push({
            type: 'message',
            content: tailText,
            role: 'assistant',
        });
    }

    return outputs;
}