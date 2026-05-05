import { jsonrepair } from 'jsonrepair';    // 有时会少掉尾部的大括号 修复一下
import { ToolChoice } from "./completions/completionsType.js";

export interface ToolDescription {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export function shouldUseToolPrompt(tools?: Array<any>, toolChoice?: ToolChoice): boolean {
    if (!tools || tools.length === 0 || toolChoice === 'none') return false;
    return true;
}

export function buildToolPrompt(tools?: ToolDescription[], toolChoice?: ToolChoice): string {
    if (!tools || tools.length === 0) return '';
    if (toolChoice === 'none') return `[tool instruction]:\n${buildToolChoicePrompt('none')}`;    // 有工具但不让用

    const INSTRUCTION = `
[tool instruction]:
You will receive a JSON string containing a list of callable tools. \
Please parse this JSON string and return a XML&JSON object containing the tool name and parameters.

Here is an example of the tool list:
[\
{"name":"plus_one","description":"Add one to a number. Returns the result.", "parameters":{"type":"object","properties":{"x":{"type": "number", "description": "The number that needs to be changed, for example: 1"}},"required": ["x"]}},\
{"name":"x_minus_y","description":"Subtract y from x. Returns the result.","parameters":{"type":"object","properties":{"x":{"type":"number","description":"The number to subtract from."},"y":{"type":"number","description":"The number to subtract.","default":0}},"required":["x"]}}\
]
If you need to add one to number 10, return:
\`\`\`
<tool_call>plus_one<params>{"x":10}</params></tool_call>
\`\`\`
Please note that the above is just an example and does not mean that the plus_one and minus_one tools are currently available.

Now you have access to the following tools:

${JSON.stringify(tools)}

${toolCallFormat}

${buildToolChoicePrompt(toolChoice)}

When the user communicates with you in a language other than English, you need to communicate with the user in the same language.`;

    return INSTRUCTION;
}

function buildToolChoicePrompt(toolChoice?: ToolChoice): string {
    if (toolChoice === 'auto') return 'Please choose the appropriate tools according to the user’s question. If you don’t need to call it, please reply directly to the user’s question.';
    if (toolChoice === 'required') return 'You must choose one of the tools according to the user’s question.';
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
        return `You must call the function ${toolChoice.function.name} according to the user’s question.`;
    } return 'You can\'t call any tools. Please answer the user\'s question directly in the same language.';
}

// 模型往往犯蠢，不按照格式输出，所以设计了多种标签
// 第一个应该是最长的
const beginTags = ['<tool_call>', '<tool>', '<tool_use>', '<call>'];
const endTags = ['</tool_call>', '</tool>', '</tool_use>', '</call>'];
const paramsBeginTag = '<params>';
const paramsBeginTag2 = '{';
const paramsEndTag = '</params>';

export const toolCallFormat = `[important]:
When you need to use tools, you MUST output EXACTLY in format like these:
\`\`\`
${beginTags[0]}
	tool1_name
	${paramsBeginTag}
		{"param1":value1,...}
	${paramsEndTag}
${endTags[0]}
${beginTags[0]}tool2_name<params>{"param2":value2,...}</params>${endTags[0]}
\`\`\`
RULES:
- Each tool call MUST be wrapped in <tool_call> ... </tool_call>
- Inside, put the tool name, then <params> with JSON`;

const toolCallPattern = /<tool_call>\s*([\s\S]*?)\s*<params>\s*([\s\S]*?)\s*<\/params>\s*<\/tool_call>/gs;

// ===== 流式解析 =====
interface ToolCallDeltaToolInfo {
    type: 'tool_call';
    data: {
        name: string;
        parameters: string;
    };
}
interface ToolCallDeltaStr {
    type: 'tool_call_name' | 'tool_call_parameters_delta' | 'text_delta';
    data: string;
}
export type ToolCallDelta = ToolCallDeltaToolInfo | ToolCallDeltaStr;
// 实际上由于本项目的 call_id 是调用的源码，因此应该忽略 tool_call_name 和 tool_call_parameters_delta 这两种增量事件 直接等到tool_call事件才进行调用
enum ToolCallParseState {
    Normal,         // 普通状态，等待 <tool_call>
    InToolCall,     // 已遇到 <tool_call>，正在收集工具名
    InParams,       // 已遇到 <params>，正在收集参数JSON
    WatchingEndTag  // 已遇到 </params>，等待 </tool_call>
}
interface parsedToolCall {
    tool: string;
    parameters: string;
    start: number;
    raw: string;
}
export class ToolCallParser {
    // 一次性解析出所有工具
    static parseToolCalls(responseContent: string): parsedToolCall[] {
        const results: Array<parsedToolCall> = [];
        const matches = responseContent.matchAll(toolCallPattern);
        for (const match of matches) {
            results.push({
                tool: match[1].trim(),
                parameters: match[2].trim(),
                start: match.index ?? 0,
                raw: match[0],
            });
        }
        return results;
    }
    static buildCallId(toolName: string, parameters: string): string {
        return `${beginTags[0]}${toolName}${paramsBeginTag}${parameters}${paramsEndTag}${endTags[0]}`;
    }

    private buffer = '';
    private name = '';
    private parameters = '';
    private state: ToolCallParseState = ToolCallParseState.Normal;

    push(chunk: string): ToolCallDelta[] {
        if (chunk) this.buffer += chunk;
        const events: ToolCallDelta[] = [];
        switch (this.state) {
            case ToolCallParseState.Normal: {
                let i = -1;
                let beginTag = beginTags[0];
                for (const tag of beginTags) {
                    i = this.buffer.indexOf(tag);
                    if (i >= 0) {
                        beginTag = tag;
                        break;
                    }
                }
                if (i < 0) {
                    if (this.buffer.length >= beginTag.length) {
                        // 前面普通文本直接流出去
                        // 可能存在 <tool_call> 被分成两半的情况，所以需要保留后面部分
                        const normalTextEndIndex = this.buffer.length - beginTag.length + 1;
                        events.push({ type: 'text_delta', data: this.buffer.slice(0, normalTextEndIndex) });
                        this.buffer = this.buffer.slice(normalTextEndIndex);
                    } break;
                }
                this.state = ToolCallParseState.InToolCall;
                const textBefore = this.buffer.slice(0, i);
                if (textBefore) events.push({ type: 'text_delta', data: textBefore });
                this.buffer = this.buffer.slice(i + beginTag.length);
                events.push(...this.push(''));
            } break;

            case ToolCallParseState.InToolCall: {
                let len = paramsBeginTag.length;
                let i = this.buffer.indexOf(paramsBeginTag);
                if (i < 0) {    // 用备选方案：'{'
                    i = this.buffer.indexOf(paramsBeginTag2);
                    if (i < 0) break;   // name没有增量
                    len = paramsBeginTag2.length;
                    i -= len;
                }
                this.state = ToolCallParseState.InParams;
                const toolName = this.name = this.buffer.slice(0, i).trim();
                events.push({ type: 'tool_call_name', data: toolName });
                this.buffer = this.buffer.slice(i + len);
                events.push(...this.push(''));
            } break;

            case ToolCallParseState.InParams: {
                let i = this.buffer.indexOf(paramsEndTag);
                if (i < 0) {
                    let endTag = endTags[0];
                    for (const tag of endTags) {
                        i = this.buffer.indexOf(tag);
                        if (i >= 0) {
                            endTag = tag;
                            break;
                        }
                    }
                    if (i < 0) {
                        // 还没有完整的参数或结束标签，先把参数增量流出去
                        if (this.buffer.length >= paramsEndTag.length) {
                            const paramsDeltaEndIndex = this.buffer.length - paramsEndTag.length + 1;
                            const paramsDelta = this.buffer.slice(0, paramsDeltaEndIndex);
                            events.push({ type: 'tool_call_parameters_delta', data: paramsDelta });
                            this.buffer = this.buffer.slice(paramsDeltaEndIndex);
                            this.parameters += paramsDelta;
                        } break;
                    } else {
                        // 遇到了结束标签但没有参数结束标签 直接进入下一个分支
                    }
                } else {    // 正常遇到参数结束标签
                    this.parameters = jsonrepair(this.parameters + this.buffer.slice(0, i)).trim();
                    events.push({ type: 'tool_call', data: { name: this.name, parameters: this.parameters } });
                    this.name = this.parameters = '';
                    this.buffer = this.buffer.slice(i + paramsEndTag.length);
                    this.state = ToolCallParseState.WatchingEndTag;
                }
            }
            // 进入下面分支的情况：1. 已经遇到</params>但还没有遇到</tool_call>；2. 遇到了</tool_call>但前面没有</params>
            case ToolCallParseState.WatchingEndTag: {
                let i = -1;
                let endTag = '';
                for (const tag of endTags) {
                    i = this.buffer.indexOf(tag);
                    if (i >= 0) {
                        endTag = tag;
                        break;
                    }
                }
                if (i < 0) break;
                if (this.state === ToolCallParseState.InParams) {
                    // 遇到了</tool_call>但前面没有</params> 认为参数就是当前剩余的全部内容
                    this.parameters = jsonrepair(this.parameters + this.buffer.slice(0, i)).trim();
                    events.push({ type: 'tool_call', data: { name: this.name, parameters: this.parameters } });
                    this.name = this.parameters = '';
                }
                // 正常遇到</tool_call>
                this.buffer = this.buffer.slice(i + endTag.length);
                this.state = ToolCallParseState.Normal;
                events.push(...this.push(''));
            } break;
        } return events;
    }

    finish(): ToolCallDelta | null {
        switch (this.state) {
            case ToolCallParseState.Normal:
            case ToolCallParseState.InToolCall:
            case ToolCallParseState.WatchingEndTag:
                // 都认为是普通文本
                if (this.buffer) return { type: 'text_delta', data: this.buffer };
                return null;
            case ToolCallParseState.InParams:
                // 认为参数就是当前剩余的全部内容
                this.parameters += this.buffer;
                return { type: 'tool_call', data: { name: this.name, parameters: this.parameters.trim() } };
        } return null;
    }
}