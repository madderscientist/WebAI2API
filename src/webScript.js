// ==UserScript==
// @name         deepseek XHR 拦截
// @namespace    local.webai
// @version      0.1.0
// @description  用于网页端尝试篡改请求体和监听流式响应
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    // 劫持XHR
    function hookXHR(api, bodyModifier) {
        const originalSend = XMLHttpRequest.prototype.send;
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._url = url;
            return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
            const xhr = this;
            if (xhr._url && xhr._url.includes(api)) {
                // body 即 负载，可以在这里进行修改
                if (bodyModifier) body = bodyModifier(body);
                let lastLength = 0;
                let done = false;
                xhr.addEventListener('readystatechange', function () {
                    if (done) return;
                    switch (xhr.readyState) {
                        case 3: // 正在接收数据
                            const newText = xhr.responseText;
                            const newChunk = newText.substring(lastLength);
                            if (newChunk) {
                                lastLength = newText.length;
                                console.log('[流式数据]', newChunk);
                            } break;
                        case 4:
                            done = true;
                            console.log('[完整响应]', xhr.responseText);
                            break;
                        default: break;
                    }
                });
                // 中断后不会触发load 所以用readystatechange来检测完成状态，为了在中断后还能保留已有响应
                // xhr.addEventListener('load', function () {
                //     console.log('[流式结束] 请求已完成');
                //     console.log('[完整响应]', xhr.responseText);
                // });
            }
            return originalSend.call(this, body);
        };
    }

    if (location.hostname.includes('deepseek')) {
        hookXHR('/chat/completion', (body) => {
            return body; // 这里可以修改请求体，例如添加调试参数等
        });
    } else return;
})();