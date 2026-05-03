/**
 * Responses API 流式输出
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 */
import { ResponsesError, ResponsesResponse, ResponseOutputItem, ResponseOutputFuncionCall, ResponseOutputMessage, ResponseOutputMessageContent, ResponseOutputText, ResponseOutputRefusal, estimateUsage } from "./responsesType.js";

// 整个response的生命周期
export interface ResponseCreatedEvent {
    type: 'response.created';
    response: ResponsesResponse & { status: 'in_progress' };
    sequence_number: number;   // The sequence number for this event. 从1开始 全局计数
}

export interface ResponsesStreamInprogress {
    type: 'response.in_progress';
    response: ResponsesResponse & { status: 'in_progress' };
    sequence_number: number;
}

export interface ResponseCompletedEvent {
    type: "response.completed";
    response: ResponsesResponse & { status: 'completed' };  // 官方文档这里发送了完整的响应
    sequence_number: number;
}

export interface ResponseIncompleteEvent {
    type: "response.incomplete";
    response: ResponsesResponse & { status: 'incomplete' };
    sequence_number: number;
}   // 比如 max_tokens

export interface ResponsesStreamFailed {
    type: 'response.failed';
    response: ResponsesResponse & { status: 'failed' } & { error: ResponsesError };
    sequence_number?: number;
}


// ResponseOutputItem的生命周期
export interface ResponseOutputItemAddedEvent {
    type: 'response.output_item.added';
    output_index: number;
    item: ResponseOutputItem & { status: 'in_progress' };
    sequence_number: number;
}

export interface ResponseOutputItemDoneEvent {
    type: 'response.output_item.done';
    output_index: number;
    item: ResponseOutputItem & { status: 'completed' };
    sequence_number: number;
}


// 消息的content的生命周期
export interface ResponseOutputContentPartAddedEvent {
    type: 'response.content_part.added';
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponseOutputMessageContent;
    sequence_number: number;
}

export interface ResponseOutputContentPartDoneEvent {
    type: 'response.content_part.done';
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponseOutputMessageContent;   // 完整内容
    sequence_number: number;
}


// 文本增量
export interface ResponseOutputTextDeltaEvent {
    type: 'response.output_text.delta';
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
    sequence_number: number;
} // 可以直接发done了而不发delta

export interface ResponseOutputTextDoneEvent {
    type: 'response.output_text.done';
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;    // 完整内容
    sequence_number: number;
}

// 虽然有 refusal 但实际没有检测 refusal
export interface ResponseOutputRefusalDeltaEvent {
    type: "response.refusal.delta";
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
    sequence_number: number;
}

export interface ResponseRefusalDoneEvent {
    type: 'response.refusal.done';
    item_id: string;
    output_index: number;
    content_index: number;
    refusal: string;    // 完整内容
    sequence_number: number;
}


// 工具调用增量
// export interface ResponseFunctionCallArgumentsDeltaEvent {
//     type: 'response.function_call_arguments.delta';
//     output_index: number;
//     item_id: string;
//     delta: string;   // json字符串增量
//     sequence_number: number;
// } // 由于本项目call_id是调用源码，因此无法增量发送，不使用此delta

export interface ResponseFunctionCallArgumentsDoneEvent {
    type: 'response.function_call_arguments.done';
    output_index: number;
    item_id: string;
    name: string;
    arguments: string;   // json字符串
    sequence_number: number;
}

type ResponseStreamEvent = ResponseCreatedEvent | ResponsesStreamInprogress | ResponseCompletedEvent | ResponseIncompleteEvent | ResponsesStreamFailed
    | ResponseOutputItemAddedEvent | ResponseOutputItemDoneEvent
    | ResponseOutputContentPartAddedEvent | ResponseOutputContentPartDoneEvent
    | ResponseOutputTextDeltaEvent | ResponseOutputTextDoneEvent
    | ResponseOutputRefusalDeltaEvent | ResponseRefusalDoneEvent
    | ResponseFunctionCallArgumentsDoneEvent;

/* 在已经给出完整响应的情况下，流式输出的流程：
response.created
loop {
    response.in_progress
}

一段文本
response.output_item.added
loop {
    response.content_part.added
    loop {
        response.output_text.delta
    }
    response.output_text.done
    response.content_part.done
}
response.output_item.done

一个工具调用
response.output_item.added
loop {
    response.function_call_arguments.delta
}
response.function_call_arguments.done
response.output_item.done

response.completed

疑似可以先创建好结构再发送内容增量；但按层级发送更好写
还有诸如file_search_call这种是给服务器执行的（比如搜索向量库），不实现
*/

/**
 * 用于一次性将已有的数据转换为流式输出(伪流式)
 * 已经被下面的 streamEventsFromStream 淘汰
 */
export function streamSendRestResponse(sender: (data: any) => void, data: ResponsesResponse, sequence_number = 1): number {
    // 发送初始响应
    sender({
        type: 'response.created',
        response: {
            id: data.id,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000) - 1,
            status: 'in_progress',
            model: data.model,
            output: [],
            usage: null
        },
        sequence_number,
    } as ResponseCreatedEvent);
    sequence_number++;

    // 发送中间的data 必须要有，不然codex不显示（不能直接在response.completed中发完整信息）
    for (let i = 0; i < data.output.length; i++) {
        sequence_number = streamSendOutputItem(sender, data.output[i], i, sequence_number);
    }

    // 发送完整内容
    data.created_at = Math.floor(Date.now() / 1000);
    sender({
        type: 'response.completed',
        response: data,
        sequence_number,
    } as ResponseCompletedEvent);
    return sequence_number + 1;
}
export function streamSendOutputItem(sender: (data: any) => void, item: ResponseOutputItem, idx: number, sequence_number: number) {
    const inner: ResponseOutputItem = { ...item };
    inner.status = 'in_progress';
    const isFunctionCall = inner.type === 'function_call';
    if (isFunctionCall) {
        inner.arguments = '';
    } else {
        inner.content = [];
    }

    sender({
        type: 'response.output_item.added',
        output_index: idx,
        item: inner,
        sequence_number
    } as ResponseOutputItemAddedEvent);
    sequence_number++;

    // 这一块疑似可以省略 直接在 item.done里发完整内容了
    if (isFunctionCall) {
        sequence_number = streamSendFunctionCallArg(sender, item as ResponseOutputFuncionCall, idx, sequence_number);
    } else {
        const m = item as ResponseOutputMessage;
        for (let i = 0; i < m.content.length; i++) {
            sequence_number = streamSendMessageContent(sender, m.content[i], m.id, idx, i, sequence_number);
        }
    }

    sender({
        type: 'response.output_item.done',
        output_index: idx,
        item: item,
        sequence_number
    } as ResponseOutputItemDoneEvent);
    return sequence_number + 1;
}
function streamSendFunctionCallArg(sender: (data: any) => void, item: ResponseOutputFuncionCall, idx: number, sequence_number: number) {
    sender({
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        name: item.name,
        output_index: idx,
        arguments: item.arguments,
        sequence_number
    } as ResponseFunctionCallArgumentsDoneEvent);
    return sequence_number + 1;
}
function streamSendMessageContent(sender: (data: any) => void, content: ResponseOutputMessageContent, item_id: string, output_index: number, content_index: number, sequence_number: number) {
    if (content.type === 'output_text') {
        sender({
            type: 'response.content_part.added',
            item_id,
            output_index,
            content_index,
            part: {
                type: 'output_text',
                text: '',
                annotations: []
            },
            sequence_number
        } as ResponseOutputContentPartAddedEvent);
        sequence_number++;
        // 跳过delta直接发done
        sender({
            type: 'response.output_text.done',
            output_index,
            item_id,
            content_index,
            text: content.text,
            sequence_number
        } as ResponseOutputTextDoneEvent);
        sequence_number++;
    } else {
        sender({
            type: 'response.content_part.added',
            item_id,
            output_index,
            content_index,
            part: {
                type: 'refusal',
                refusal: '',
            },
            sequence_number
        } as ResponseOutputContentPartAddedEvent);
        sequence_number++;

        sender({
            type: 'response.refusal.done',
            item_id,
            output_index,
            content_index,
            refusal: content.refusal,
            sequence_number
        } as ResponseRefusalDoneEvent);
        sequence_number++;
    }
    // 结束content
    sender({
        type: 'response.content_part.done',
        item_id,
        output_index,
        content_index,
        part: content,
        sequence_number
    } as ResponseOutputContentPartDoneEvent);
    return sequence_number + 1;
}

// 流式解析
import { DeepseekStreamParser, toNumberOrNull } from "../../deepseekStreamParser.js";
import { ToolCallDelta, ToolCallParser } from "../toolPrompt.js";
import { buildResponseId } from "../responseId.js";

class StreamResponseBuilder {
    requestId?: string;
    private send: (data: any) => void;
    private stack: ResponseStreamEvent[] = [];

    private sequence_number: number = 2;
    constructor(sendfn: (data: any) => void) {
        this.send = sendfn;
    }

    // deepseek 的 SSE 会先发出 messageId，此时更新
    initSend(id: string, model: string) {
        this.requestId = id;    // codex: 这里的ID可以不填也可以和completed不一样 以最终的为准
        const e: ResponseCreatedEvent = {
            type: 'response.created',
            response: {
                id: this.requestId,
                object: 'response',
                created_at: Math.floor(Date.now() / 1000),
                status: 'in_progress',
                model,
                output: [],
                usage: null,
            },
            sequence_number: 1,
        }
        this.send(e);
        this.stack.unshift(e);
    }

    // usage和最终的id需要外部提供，故暴露此接口
    get response() {
        return this.stack[0] as ResponseCreatedEvent;
    }

    private static level = {
        '': -1,
        'response.created': 0,
        'response.output_item.added': 1,
        'response.content_part.added': 2,
    };

    close(until: keyof typeof StreamResponseBuilder.level) {
        const level = StreamResponseBuilder.level[until] ?? -1;
        while (this.stack.length > 0) {
            const top = this.stack[this.stack.length - 1];
            const l = StreamResponseBuilder.level[top.type as keyof typeof StreamResponseBuilder.level] ?? -1;
            if (l <= level) return;
            this.stack.pop();
            switch (top.type) {
                case 'response.created':
                    this.send({
                        type: 'response.completed',
                        response: {
                            ...top.response,
                            created_at: Math.floor(Date.now() / 1000),
                            status: 'completed',
                        },
                        sequence_number: this.sequence_number++
                    } as ResponseCompletedEvent);
                    // (top.response as ResponsesResponse).status = 'completed';
                    break;
                case 'response.output_item.added':
                    (top.item as ResponseOutputMessage).status = 'completed';
                    this.send({
                        type: 'response.output_item.done',
                        output_index: top.output_index,
                        item: {
                            ...top.item,
                        },
                        sequence_number: this.sequence_number++
                    } as ResponseOutputItemDoneEvent);
                    break;
                case 'response.content_part.added':
                    // 先关闭文本，再关闭content_part
                    switch (top.part.type) {
                        case 'output_text':
                            this.send({
                                type: 'response.output_text.done',
                                output_index: top.output_index,
                                item_id: top.item_id,
                                text: (top.part as ResponseOutputText).text,
                                sequence_number: this.sequence_number++
                            } as ResponseOutputTextDoneEvent);
                            break;
                        case 'refusal':
                            this.send({
                                type: 'response.refusal.done',
                                output_index: top.output_index,
                                item_id: top.item_id,
                                refusal: (top.part as ResponseOutputRefusal).refusal,
                                sequence_number: this.sequence_number++
                            } as ResponseRefusalDoneEvent);
                            break;
                        default:
                            break;
                    }
                    this.send({
                        type: 'response.content_part.done',
                        item_id: top.item_id,
                        output_index: top.output_index,
                        content_index: top.content_index,
                        part: top.part,
                        sequence_number: this.sequence_number++
                    } as ResponseOutputContentPartDoneEvent);
                    break;
                default:
                    break;
            }
        }
    }

    addMessageItem(type: 'message' | 'reasoning') {
        this.close('response.created');
        const response = (this.stack[0] as ResponseCreatedEvent).response;
        const itemEvent: ResponseOutputItemAddedEvent = {
            type: 'response.output_item.added',
            output_index: response.output.length,
            item: {
                type,
                content: [],
                role: 'assistant',
                id: `msg_${this.requestId}_${response.output.length}`,
                status: 'in_progress',
            } as ResponseOutputMessage & { status: 'in_progress' },
            sequence_number: this.sequence_number++,
        }
        response.output.push(itemEvent.item);
        this.send(itemEvent);
        this.stack.push(itemEvent);
    }

    addContent(type: 'output_text' | 'refusal') {
        this.close('response.content_part.added');
        let item = this.stack[this.stack.length - 1];
        if (item.type !== 'response.output_item.added') {
            this.addMessageItem('message');
        }
        item = this.stack[this.stack.length - 1] as ResponseOutputItemAddedEvent;
        const msg = item.item as ResponseOutputMessage;
        let part: ResponseOutputMessageContent;
        if (type === 'output_text') {
            part = {
                type: 'output_text',
                text: '',
                annotations: [],
            } as ResponseOutputText;
        } else {
            part = {
                type: 'refusal',
                refusal: '',
            } as ResponseOutputRefusal;
        }
        const contentEvent: ResponseOutputContentPartAddedEvent = {
            type: 'response.content_part.added',
            item_id: item.item.id,
            output_index: item.output_index,
            content_index: msg.content.length,
            part,
            sequence_number: this.sequence_number++,
        };
        msg.content.push(part);
        this.send(contentEvent);
        this.stack.push(contentEvent);
    }

    // call_id 为调用源码，因此无法增量
    sendToolCall(item: ResponseOutputFuncionCall) {
        this.close('response.created');
        const response = (this.stack[0] as ResponseCreatedEvent).response;
        const output_index = response.output.length;
        item.id = `func_call_${this.requestId}_${output_index}`;
        item.status = 'completed';
        this.send({
            type: 'response.output_item.added',
            output_index,
            item: {
                ...item,
                status: 'in_progress',
                arguments: '',
            },
            sequence_number: this.sequence_number++
        } as ResponseOutputItemAddedEvent);
        this.send({
            type: 'response.function_call_arguments.done',
            output_index,
            item_id: item.id,
            name: item.name,
            arguments: item.arguments,
            sequence_number: this.sequence_number++
        } as ResponseFunctionCallArgumentsDoneEvent);
        this.send({
            type: 'response.output_item.done',
            output_index,
            item,
            sequence_number: this.sequence_number++
        } as ResponseOutputItemDoneEvent);
        response.output.push(item);
    }

    addTextDelta(delta: string) {
        // 判断上一个是否为可接收文本增量的事件
        let lastEvent = this.stack[this.stack.length - 1];
        if (lastEvent.type !== 'response.content_part.added') {
            this.addContent('output_text');
            lastEvent = this.stack[this.stack.length - 1];
        }
        lastEvent = lastEvent as ResponseOutputContentPartAddedEvent;
        switch (lastEvent.part.type) {
            case 'output_text':
                (lastEvent.part as ResponseOutputText).text += delta;
                this.send({
                    type: 'response.output_text.delta',
                    output_index: lastEvent.output_index,
                    item_id: lastEvent.item_id,
                    content_index: lastEvent.content_index,
                    delta,
                    sequence_number: this.sequence_number++,
                } as ResponseOutputTextDeltaEvent);
                break;
            case 'refusal':
                (lastEvent.part as ResponseOutputRefusal).refusal += delta;
                this.send({
                    type: 'response.refusal.delta',
                    output_index: lastEvent.output_index,
                    item_id: lastEvent.item_id,
                    content_index: lastEvent.content_index,
                    delta,
                    sequence_number: this.sequence_number++,
                } as ResponseOutputRefusalDeltaEvent);
                break;
            default:
                throw new Error('Unknown content part type');
        }
    }
}

/**
 * 从流式数据中提取事件 真流式，有打字机效果
 */
export async function streamEventsFromStream(
    stream: ReadableStream<Uint8Array>,
    useTool: boolean,
    requestId: string,
    model: string,
    inputLength: number,
    send: (data: any) => void
) {
    const toolParser = useTool ? (new ToolCallParser()) : null;
    let typeMode = '';
    const streamBuilder = new StreamResponseBuilder(send);
    function parseToolEvent(ev: ToolCallDelta, type: string) {
        switch (ev.type) {
            case 'tool_call_name':
            case 'tool_call_parameters_delta':
                // 这两种增量事件不处理 直接等到tool_call事件
                // 因为call_id是调用源码，因此无法增量发送
                break;
            case 'tool_call':
                streamBuilder.sendToolCall({
                    type: 'function_call',
                    name: ev.data.name,
                    arguments: ev.data.parameters,
                    id: '', // 函数内会替换
                    call_id: ToolCallParser.buildCallId(ev.data.name, ev.data.parameters),
                    status: 'completed',
                });
                typeMode = "FUNC";  // 为了触发下面的新建
                break;
            case 'text_delta':
                if (typeMode !== type) {
                    streamBuilder.addMessageItem(type === "THINK" ? 'reasoning' : 'message');
                    streamBuilder.addContent('output_text');
                } typeMode = type;
                streamBuilder.addTextDelta(ev.data);
                break;
            default:
                break;
        }
    }
    const parser = new DeepseekStreamParser(
        (type, delta) => {
            if (type === "THINK") {
                // THINK 无工具调用
                if (typeMode !== "THINK") {
                    streamBuilder.addMessageItem('reasoning');
                    streamBuilder.addContent('output_text');
                } typeMode = "THINK";
                streamBuilder.addTextDelta(delta);  // 发增量
            } else if (type === "RESPONSE") {
                if (toolParser) {
                    const e = toolParser.push(delta);
                    for (const ev of e) {
                        parseToolEvent(ev, type);
                    } return;
                }
                if (typeMode !== "RESPONSE") {
                    streamBuilder.addMessageItem('message');
                    streamBuilder.addContent('output_text');
                } typeMode = "RESPONSE";
                streamBuilder.addTextDelta(delta);
            }
        },
        (event) => {
            if (event.event === 'ready') {
                streamBuilder.initSend(
                    buildResponseId(requestId, event.data?.response_message_id),
                    model
                );
            }
        }
    );
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
        if (e) parseToolEvent(e, "RESPONSE");
    }

    const result = {
        text: parser.text("RESPONSE").trim(),
        thinking: parser.text("THINK").trim(),
        messageId: toNumberOrNull(parser.decoder.state.message.response?.message_id),
        accumulated_token_usage: parser.decoder.state.message.response?.accumulated_token_usage ?? -1
    };
    // 补充缺少的字段
    streamBuilder.response.response.usage = estimateUsage(result.accumulated_token_usage, inputLength, result.text.length + result.thinking.length);
    streamBuilder.response.response.id = buildResponseId(requestId, result.messageId);
    streamBuilder.close('');

    return result;
}