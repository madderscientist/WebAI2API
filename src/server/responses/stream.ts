/**
 * Responses API 流式输出
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 */
import { ResponsesError, ResponsesResponse, ResponseOutputItem, ResponseOutputFuncionCall, ResponseOutputMessage, ResponseOutputMessageContent } from "./responsesType.js";

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
// export interface ResponseOutputTextDeltaEvent {
//     type: 'response.output_text.delta';
//     output_index: number;
//     item_id: string;
//     content_index: number;
//     delta: string;
//     sequence_number: number;
// } // 直接发done了，不发delta了

export interface ResponseOutputTextDoneEvent {
    type: 'response.output_text.done';
    output_index: number;
    item_id: string;
    content_index: number;
    text: string;    // 完整内容
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
// } // 直接发done了，不发delta了

export interface ResponseFunctionCallArgumentsDoneEvent {
    type: 'response.function_call_arguments.done';
    output_index: number;
    item_id: string;
    name: string;
    arguments: string;   // json字符串
    sequence_number: number;
}


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

// 用于一次性将已有的数据转换为流式输出
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

// 通用
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