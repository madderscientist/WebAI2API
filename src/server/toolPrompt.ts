import { ToolChoice } from "./completionsType.js";

export interface ToolDescription {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export function shouldUseToolPrompt(tools?: Array<any>, toolChoice?: ToolChoice): boolean {
    if (!tools || tools.length === 0 || toolChoice === 'none') return false;
    return true;
}

// 目前保守策略：只有提供了工具才给用shell
export function buildToolPrompt(tools?: ToolDescription[], toolChoice?: ToolChoice, shell = true): string {
    if (!shouldUseToolPrompt(tools, toolChoice)) return '';

    const INSTRUCTION = `
[system instruction]:
You will receive a JSON string containing a list of callable tools. \
Please parse this JSON string and return a XML&JSON object containing the tool name and tool parameters. \
Here is an example of the tool list:

[\
{"name":"plus_one","description":"Add one to a number. Returns the result.", "parameters":{"type":"object","properties":{"x":{"type": "number", "description": "The number that needs to be changed, for example: 1"}},"required": ["x"]}},\
{"name":"x_minus_y","description":"Subtract y from x. Returns the result.","parameters":{"type":"object","properties":{"x":{"type":"number","description":"The number to subtract from."},"y":{"type":"number","description":"The number to subtract.","default":0}},"required":["x"]}}\
]

Based on this tool list, generate a XML&JSON object to call a tool. For example, if you need to add one to number 10, return:

<tool>plus_one<params>{"x":10}</params></tool>

Please note that the above is just an example and does not mean that the plus_one and minus_one tools are currently available.

Now you have access to the following tools:

${JSON.stringify(tools)}

Call using the following format:
\`\`\`
<tool>tool_name<params>{"param1":value1,...}</params></tool>
\`\`\`

${buildToolChoicePrompt(toolChoice)}

${shell ? buildShellPrompt() : ''}

When the user communicates with you in a language other than English, you need to communicate with the user in the same language.`;

    return INSTRUCTION;
}

function buildToolChoicePrompt(toolChoice?: ToolChoice): string {
    if (toolChoice === 'auto') return 'Please choose the appropriate tools according to the user’s question. If you don’t need to call it, please reply directly to the user’s question.';
    if (toolChoice === 'required') return 'You must choose one of the tools according to the user’s question.';
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
        return `You must call the function ${toolChoice.function.name} according to the user’s question.`;
    } return '';
}

export interface parsedToolCall {
    tool: string;
    parameters: string;
    start: number;
    raw: string;
}

const toolCallPattern = /<tool>([\s\S]*?)<params>\s*(\{[\s\S]*?\})\s*<\/params><\/tool>/g;

export function parseToolCalls(responseContent: string): parsedToolCall[] {
    const results: Array<parsedToolCall> = [];
    const matches = responseContent.matchAll(toolCallPattern);
    for (const match of matches) {
        results.push({
            tool: match[1],
            parameters: match[2],
            start: match.index ?? 0,
            raw: match[0],
        });
    }
    return results;
}

function buildShellPrompt(): string {
    return `You can also execute shell commands. Please return the command you want to execute in the following format:
<shell>command_to_execute</shell>
For example, if you want to list the files in the current directory, you can return:
<shell>ls -la</shell>`;
}

const shellCommandPattern = /<shell>([\s\S]*?)<\/shell>/g;
export interface parsedShellCommand {
    command: string;
    start: number;
    raw: string;
}
export function parseShellCommands(responseContent: string): parsedShellCommand[] {
    const results: Array<parsedShellCommand> = [];
    const matches = responseContent.matchAll(shellCommandPattern);
    for (const match of matches) {
        results.push({
            command: match[1],
            start: match.index ?? 0,
            raw: match[0],
        });
    }
    return results;
}