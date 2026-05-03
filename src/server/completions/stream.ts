import { DeepseekStreamParser, toNumberOrNull } from "../../deepseekStreamParser.js";
import { estimateUsage } from "../responses/responsesType.js";
import { ToolCallDelta, ToolCallParser } from "../toolPrompt.js";
import { ChatCompletionMessageFunctionToolCall, CompletionsFinishReason } from "./completionsType.js";

export interface CompletionsChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: {
        index: number;
        delta: CompletionsDelta;
        finish_reason: CompletionsFinishReason;
        logprobs: null; // 目前不支持logprobs
    }[];
    usage?: {
        total_tokens: number;
        prompt_tokens: number;
        completion_tokens: number;
    } | null;
}

export interface CompletionsDelta {
    content?: string;
    reasoning_content?: string;
    refusal?: string;
    role?: 'assistant';
    tool_calls?: CompletionStreamFunctionToolCall[];
}

export interface CompletionStreamFunctionToolCall extends ChatCompletionMessageFunctionToolCall {
    index: number;  // 调用顺序
}


class StreamResponseBuilder {
    send: (chunk: any) => void;
    requestId: string;
    model: string;
    private toolCallNumber = 0;
    constructor(send: (chunk: any) => void, requestId: string, model: string) {
        this.send = send;
        this.requestId = requestId;
        this.model = model;
    }

    initSend() {
        const chunk = this.buildCompletionsChunk({
            role: 'assistant',
        });
        this.send(chunk);
    }

    buildCompletionsChunk(
        delta: CompletionsDelta,
        finishReason: CompletionsFinishReason = null
    ): CompletionsChunk {
        return {
            id: this.requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [{
                index: 0,
                delta: delta,
                finish_reason: finishReason,
                logprobs: null,
            }],
            usage: null
        };
    }

    sendText(text: string, reason = false) {
        const chunk = this.buildCompletionsChunk(
            reason ? { reasoning_content: text } : { content: text }
        );
        this.send(chunk);
    }

    sendFunctionToolCall(toolCall: ChatCompletionMessageFunctionToolCall) {
        const chunk = this.buildCompletionsChunk({
            tool_calls: [{
                ...toolCall,
                index: this.toolCallNumber++,
            }]
        });
        this.send(chunk);
    }

    finish(usage?: { total_tokens: number; prompt_tokens: number; completion_tokens: number }) {
        const reason = this.toolCallNumber > 0 ? 'tool_calls' : 'stop';
        const chunk = this.buildCompletionsChunk({}, reason);
        if (usage) chunk.usage = usage;
        this.send(chunk);
    }
}

export async function streamEventsFromStream(
    stream: ReadableStream<Uint8Array>,
    useTool: boolean,
    requestId: string,
    model: string,
    inputLength: number,
    send: (data: any) => void
) {
    const toolParser = useTool ? (new ToolCallParser()) : null;
    const builder = new StreamResponseBuilder(send, requestId, model);
    builder.initSend();
    function parseToolEvent(ev: ToolCallDelta) {
        switch (ev.type) {
            case 'tool_call_name':
            case 'tool_call_parameters_delta':
                break;
            case 'tool_call':
                builder.sendFunctionToolCall({
                    id: ToolCallParser.buildCallId(ev.data.name, ev.data.parameters),
                    type: 'function',
                    function: {
                        name: ev.data.name,
                        arguments: ev.data.parameters,
                    }
                });
                break;
            case 'text_delta':
                builder.sendText(ev.data);
                break;
            default:
                break;
        }
    }

    const parser = new DeepseekStreamParser((type, delta) => {
        if (type === "THINK") {
            builder.sendText(delta, true);
        } else if (type === "RESPONSE") {
            if (toolParser) {
                const e = toolParser.push(delta);
                for (const ev of e) parseToolEvent(ev);
                return;
            }
            builder.sendText(delta);
        }
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            parser.finish();
            break;
        }
        parser.push(decoder.decode(value, { stream: true }));
    }
    if (toolParser) {
        const e = toolParser.finish();
        if (e) parseToolEvent(e);
    }

    const result = {
        text: parser.text("RESPONSE").trim(),
        thinking: parser.text("THINK").trim(),
        messageId: toNumberOrNull(parser.decoder.state.message.response?.message_id),
        accumulated_token_usage: parser.decoder.state.message.response?.accumulated_token_usage ?? -1
    };
    const usage = estimateUsage(result.accumulated_token_usage, inputLength, result.text.length + result.thinking.length);
    builder.finish({
        total_tokens: usage.total_tokens,
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
    });
    return result;
}