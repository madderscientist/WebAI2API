# 思考、探索过程
起因：QQbot需要，但我是抠逼，不想花钱。于是想到了调用网页中的大模型。

最开始接触到的是 `openclaw-zero-token`，但是 README 中只说Windows要用WSL，虽然看代码里有win的适配，但是不敢用。此外，这是openclaw的分支，而我并不需要智能体（或者说更想自己实现）。

一开始的设计是，使用油猴脚本完成网页端的自动化，通过websocket和nodejs通信，nodejs负责处理openai接口请求。但是油猴脚本触发点击会导致 `Event.isTrusted=false`，很有可能被检测到；而且稳定性会被浏览器的休眠策略限制。于是想使用 `playwright` 这种自动化的UI操作方式。于是了解到 `WebAI2API` ，并顺利跑起来。但它没有利用网页自带的记忆管理（我认为这可以省很多代码），没有工具调用，我不太满意。无奈其体量太大了（适配本地、远程调用，适配多种AI），不好修改。所以只能单独抽离、专门适配deepseek，仅用于Windows本地运行、本地调用。

此时实现上有两条途径：爬API（`openclaw-zero-token`）和网页模拟（`WebAI2API`）。下面分述实现。

## API: `deepseekWebClient.ts`
通过观察浏览器控制台的网络信息，基本可以得到所有常用的API。有很多我认为很必要的API在上面两个项目中都没有体现；而这些API是网页调用和官方API调用最大的区别，比如会话管理。

观察请求，可以确定如下要点：
- 每个请求都带有 `Bear xxxxxxxtokenxxxxxx`，需要凭证。
- 关键请求比如对话、上传文件，需要解决一个计算问题。这个问题需要先通过 `create_pow_challenge` 请求得到，这是一种加密方式。

为了尽可能模拟网页，还需要带上 `cookie` 和 `User-Agent`。于是凭证信息只保存了 `token` `cookie` `User-Agent`。

最难的问题：如何逆向 `pow_challenge` 的解决。好在逆向在`openclaw-zero-token`已经完成了，直接抄就行。观察请求可以发现每次接收问题都会请求一个`wasm`，实际上这个wasm就是解题函数。

于是问题只剩下：请求中payload的每个字段是什么含义？response每个字段是什么含义？为了解决前一个问题，需要篡改请求，此时油猴脚本发挥用途了。deepseek的请求是XHR，因此只需要hook `XMLHttpRequest.prototype.send`。这个方法帮助我确认了很多事情。

而后一个问题需要捕获输出，对于一般的json返回，控制台里直接复制就好了。而对于流式返回，我还是通过油猴脚本整理并输出（控制台里不好复制）。我发现上面两个库对deepseek的SSE处理并不完善：它们是直接提取，而不是先解析后提取：前者只需要专注于每个流事件，进行模式匹配；后者需要理解每个流事件之间的关系，有上下文。就deepseek的流来说，他们目前的直接提取，会丢失思考和搜索信息（因为只匹配了最终结果）。所以我写了几个解析类（`sseStreamParser.ts`和`deepseekStreamParser.ts`），支持流式解析和全量解析。

## 浏览器: `deepseekBrowserClient.ts`
API逆向的缺点是得和厂商保持一致，特别是如果 `pow_challenge` 被更换了，又要重新逆向。所以需要一个兜底的方案，即 `WebAI2API` 的浏览器模拟。

亲测没有发现deepseek网页端的反自动化，所以 `WebAI2API` 那一套人轨迹模拟可以舍弃，直接用 `playwright` 的点击即可；也无需额外下载浏览器，直接用 Edge 即可。

浏览器操作一次只能处理一个请求，所以需要任务队列。

剩下的事就是寻找dom、点击、等待响应。很早之前写过一个dom层面自动删除所有对话的油猴脚本，现在还能用，说明UI基本不会改变，很稳定。

基于浏览器的会话管理稍微不太一样。浏览器中 `api/v0/chat_session/create` 的调用是提前的，也就是始终会有一个空的会话待命，并不是点击“开启新对话”或者发出第一个消息后才请求的。这意味着无法捕获到 `session_id`，只能在后续的对话请求中提取。因此，创建会话只需要将URL设置为 `https://chat.deepseek.com/`，切换会话也只需要改动URL；也不需要处理不存在的会话了，因为URL不合理会自动跳转首页，相当于新建会话。

发送消息的方案：随便写一些什么，发送，拦截请求，篡改内容。篡改请求可以免去很多UI操作（比如有没有点击思考搜索），但我担心以后要是出一个请求的hash校验，篡改就走不通了。目前的做法是，填写prompt仍然UI操作，并用于核对捕获的请求是否为期望请求。其余参数通过篡改请求实现。

网页封装的一个缺点是无法捕获流式返回，只能等到接收完再处理。当然如果硬是要实现也是可以的，比如hook。但是这会污染前端代码，很容易被检测到（如果有的话）；还很麻烦。

## 使用
`chat` 脚本只是为了调试和示例如何使用封装。最理想的情况是直接import用client类。但由于QQbot使用了nonebot架构，是python写的，因此得封装为网络服务，为了兼容性，需要去理解openai的接口规范。

参考的两个项目都只做了 `completions` api，这是调用官方API常见的请求，需要自己维护上下文，很自由。但是网页AI自带上下文管理！所以更新的 `responses` api更适合。比如QQbot只需要为每个群维护一个 `session_id`，不需要存储之前的对话。

只是，要适配两种封装，我已经嫌弃代码量有些多了。以后要是做大了岂不是又是庞然大物、牵一发动全身。。。

此外，还有一点上面两个库都没考虑的是：会话删除。用这种方式使用AI，会导致网页AI中出现很多会话，淹没自己的正常对话。因此本项目的处理是，对于 `completions` api，用完即删。

## Tool Calling
这是实现agent的重要一步。在 `openclaw-zero-token` 中提到了一篇arxiv论文，里面给出了代码，证明了用prompt实现工具调用的可行性。不过这篇文章有颇多问题，甚至有自相矛盾的地方。我结合自己的一点思考完成了prompt的构造，初步测试发现完全可用。

prompt构造时，我选择了XML套JSON。因为这样正则表达式容易定位，我个人认为这样边界也比较清晰，AI可能更容易读（至少我容易读了）。没有进行实验。

我尝试提供了执行代码的tool。实测发现如果模型给出的python容易有缩进问题，所以改成js了。 `completions` 确实不适合toolCall，因为返回中toolcall和message是两个字段，那我到底要不要将message中的toolcall源文本删除呢？我没有删除，因为删除了影响阅读（工具调用可能在文本中间；当然可以用更复杂的判断实现更好的输出，但我懒得做了），此时 `tool_calls` 字段其实工具调用识别结果。

## 接入CodeX
CodeX只接收ResponsesAPI，刚好。捣鼓了半个下午把ResponsesAPI的流式返回写好了，接入CodeX果然可以！

由于本项目是prompt模拟toolcall，所以要先获取所有响应再解析，最后才能将所有结果返回。所以模拟流式响应时，我略过了所有`delta`事件，只保留了结构的创建，数据的填充直接用`done`完成。最后`complete`返回了所有数据。

此时可以在网页对话中看到全过程。观察了CodeX的prompt，发现是markdown、XML混着用。官方文档中，非流式的ResponsesAPI有`ShellCall`这个返回，但是流响应中没有对应的事件；而CodeX是可以用shell的。当时还很疑惑，现在真相揭晓：有一个shell的tool。

CodeX如果配置了`supports_websockets=true`，会复用会话；否则不会（每次发起一个新的对话，包含所有历史）。虽然 responsesAPI本身就支持复用，但是CodeX仅在websocket模式下才会启用复用模式。

阅读文档和[源码](https://github.com/openai/codex/blob/f802f0a3/codex-rs/cli/src/responses_cmd.rs#L58-L62)发现，codex会发起一个 `{type: "responses.create"}` 的socket，期望收到： 
```rs
fn response_event_to_json(event: codex_api::ResponseEvent) -> serde_json::Value {
    match event {
        codex_api::ResponseEvent::Created => {
            json!({ "type": "response.created", "response": {} })
        }
        codex_api::ResponseEvent::OutputItemDone(item) => {
            json!({ "type": "response.output_item.done", "item": item })
        }
        codex_api::ResponseEvent::OutputItemAdded(item) => {
            json!({ "type": "response.output_item.added", "item": item })
        }
        codex_api::ResponseEvent::ServerModel(model) => {
            json!({ "type": "response.server_model", "model": model })
        }
        codex_api::ResponseEvent::ModelVerifications(verifications) => {
            json!({ "type": "response.model_verifications", "verifications": verifications })
        }
        codex_api::ResponseEvent::ServerReasoningIncluded(included) => {
            json!({ "type": "response.server_reasoning_included", "included": included })
        }
        codex_api::ResponseEvent::Completed {
            response_id,
            token_usage,
        } => {
            let response = match token_usage {
                Some(token_usage) => json!({
                    "id": response_id,
                    "usage": {
                        "input_tokens": token_usage.input_tokens,
                        "input_tokens_details": {
                            "cached_tokens": token_usage.cached_input_tokens,
                        },
                        "output_tokens": token_usage.output_tokens,
                        "output_tokens_details": {
                            "reasoning_tokens": token_usage.reasoning_output_tokens,
                        },
                        "total_tokens": token_usage.total_tokens,
                    },
                }),
                None => json!({ "id": response_id }),
            };
            json!({ "type": "response.completed", "response": response })
        }
        codex_api::ResponseEvent::OutputTextDelta(delta) => {
            json!({ "type": "response.output_text.delta", "delta": delta })
        }
        codex_api::ResponseEvent::ToolCallInputDelta {
            item_id,
            call_id,
            delta,
        } => {
            json!({
                "type": "response.tool_call_input.delta",
                "item_id": item_id,
                "call_id": call_id,
                "delta": delta,
            })
        }
        codex_api::ResponseEvent::ReasoningSummaryDelta {
            delta,
            summary_index,
        } => json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": delta,
            "summary_index": summary_index,
        }),
        codex_api::ResponseEvent::ReasoningContentDelta {
            delta,
            content_index,
        } => json!({
            "type": "response.reasoning_text.delta",
            "delta": delta,
            "content_index": content_index,
        }),
        codex_api::ResponseEvent::ReasoningSummaryPartAdded { summary_index } => {
            json!({
                "type": "response.reasoning_summary_part.added",
                "summary_index": summary_index,
            })
        }
        codex_api::ResponseEvent::RateLimits(rate_limits) => {
            json!({ "type": "response.rate_limits", "rate_limits": rate_limits })
        }
        codex_api::ResponseEvent::ModelsEtag(etag) => {
            json!({ "type": "response.models_etag", "etag": etag })
        }
    }
}
```

1. CodeX 发送一个`input=[]`的`response.create`作为预热。
2. 我返回一个空的`response.created`和空的`response.completed`，不进行任何的请求。因为id需要我请求了才能得到（兼容web封装）。不过实际实现的时候还是发了一个占位的id。
3. 用户发送需求后，创建一个有消息的`response.create`。但由于上一轮没收到id，因此没有`previous_session_id`，相当于全量模式。但由于是第一轮，因此全量不会有任何问题。
4. 我先发一个`response.created`，内容为空（源码允许），然后请求，结果包装为`response.completed`（没有delta；发现socket可以这样，但是SSE必须有delta）
5. 在4还没有返回的时候，会给 `gpt-5.4-mini` 发送总结title的请求
6. 我会拦截，改为deepseek总结标题
7. 多轮对话即重复3和4

### 关于instructions
`https://deepwiki.com/openai/openai-python/4.2.2-conversation-and-state-management` 这里说每次会话依然要发送 `instructions`，但是会覆盖系统提示词而不是append。但是本项目的使用环境下，无法替换历史。最偷懒的方式是只有第一次发送，后面就不发送，但这无法体现instructions的更改。因此设置了一个比较，如果相同则每隔一时间注入一次，否则直接发新的。因此，如果想要完整的CodeX体验，建议不开socket。

### 关于压缩
官方文档说有，但我还没做

## token消耗
codex需要token统计。于是我观察了一下deepseek给的`"accumulated_token_usage","v":45`是什么含义。我在一个session进行了如下对话：
```
我:回复一个字
DS:好
我:回复一个字
DS:好
我:回复一个字
DS:好
我:回复一个字
DS:好
我:回复一个字
DS:好
```
这五次的token消耗为：34 56 78 100 122，可见每次增加22，说明一次来回就是22个token，因此系统提示词大概12个token。
实际代码中，用了"四字符一token"的经验值。

## 收获
- 第一次接触 `playwright` ，学了一些浏览器相关的基础
- 第一次和LLM相关的开发，第一次动手写 Agent，第一次了解具体的请求和规范。我觉得这是一个很好的起点（从请求开始，够底层）
- 升级了一波工具(js->ts; ts-node->tsc; npm->pnpm)

我对Agent开发的看法保持不变：原理很简单，实现虽然不容易，但都是脏累活。此类型开发中容错和架构设计更重要。