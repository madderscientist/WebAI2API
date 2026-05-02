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

export interface parsedToolCall {
    tool: string;
    parameters: string;
    start: number;
    raw: string;
}

export const toolCallFormat = `[important]:
YOU MUST CALL USING THE FOLLOWING FORMAT:
\`\`\`
<tool_call>tool1_name<params>{"param1":value1,...}</params></tool_call>
<tool_call>tool2_name<params>{"param2":value2,...}</params></tool_call>
\`\`\`
Prohibit any other output formats!`;
const toolCallPattern = /<tool_call>\s*([\s\S]*?)\s*<params>\s*([\s\S]*?)\s*<\/params>\s*<\/tool_call>/gs

export function parseToolCalls(responseContent: string): parsedToolCall[] {
    const results: Array<parsedToolCall> = [];
    const matches = responseContent.matchAll(toolCallPattern);
    for (const match of matches) {
        results.push({
            tool: match[1],
            parameters: match[2].trim(),
            start: match.index ?? 0,
            raw: match[0],
        });
    }
    return results;
}
