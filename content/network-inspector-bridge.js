/**
 * Network Inspector Bridge
 * Content script 层：注入 network-inspector.js 到页面上下文，
 * 监听网络信号并转发给 background.js
 */

(function () {
    if (window.__networkInspectorBridgeLoaded) return;
    window.__networkInspectorBridgeLoaded = true;

    // 注入 network-inspector.js 到页面上下文（绕过 CSP）
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/network-inspector.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);

    // 最新信号缓存
    let latestSignal = null;

    // 监听来自页面上下文的网络信号
    window.addEventListener('__bla_network_signal', (event) => {
        const detail = event.detail;
        if (!detail || !detail.type) return;

        latestSignal = detail;
        console.log(`[BLA Bridge] Network signal: ${detail.type}`, detail);

        // 转发给 background
        chrome.runtime.sendMessage({
            action: 'networkSignal',
            signal: detail
        }).catch(() => {});
    });

    // 响应来自 comment-publisher 的查询
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'getNetworkSignal') {
            sendResponse({ signal: latestSignal });
            latestSignal = null; // 读后清除
            return true;
        }
    });
})();
