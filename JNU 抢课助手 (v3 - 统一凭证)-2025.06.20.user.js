// ==UserScript==
// @name         JNU 抢课助手 (v3 - 统一凭证)
// @namespace    http://tampermonkey.net/
// @version      2025.06.20
// @description  【重要更新】统一使用最后一次捕获的Token和Cookie进行发包，以最大程度保证凭证有效性。兼容Fetch和XHR。
// @author       Gemini
// @match        https://jwxk.jnu.edu.cn/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    //================================================================================
    // 1. 核心状态管理与常量
    //================================================================================
    let collectedRequests = JSON.parse(GM_getValue('courseRequests_jnu', '[]'));
    let latestAuth = { token: null, cookie: null }; // <--- v3 新增: 存储最新的凭证
    let isCollecting = false;
    let isSnatchingArmed = false;
    let snatchingIntervalId = null;
    let snatchingTimeoutId = null;
    const TARGET_URL = 'https://jwxk.jnu.edu.cn/xsxkapp/sys/xsxkapp/elective/volunteer.do';

    //================================================================================
    // 2. 核心功能: 请求捕获与凭证更新
    //================================================================================
    function captureRequest(requestData, type) {
        try {
            // 1. 添加请求到列表
            collectedRequests.push(requestData);
            GM_setValue('courseRequests_jnu', JSON.stringify(collectedRequests));

            // 2. v3核心: 更新最新的凭证
            const headers = requestData.options.headers;
            let tokenUpdated = false;
            let cookieUpdated = false;
            for (const key in headers) {
                if (key.toLowerCase() === 'token') {
                    latestAuth.token = headers[key];
                    tokenUpdated = true;
                }
                if (key.toLowerCase() === 'cookie') {
                    latestAuth.cookie = headers[key];
                    cookieUpdated = true;
                }
            }

            // 3. UI反馈 (使用setTimeout确保UI已加载)
            setTimeout(() => {
                logMessage(`通过 [${type}] 捕获请求成功。总数: ${collectedRequests.length}`, 'success');
                if (tokenUpdated) logMessage('成功更新 Token！', 'info');
                if (cookieUpdated) logMessage('成功更新 Cookie！', 'info');
                updateAuthStatus();
                updateRequestDisplay();
            }, 0);
        } catch (e) {
            setTimeout(() => logMessage(`捕获请求时发生错误: ${e.message}`, 'error'), 0);
        }
    }


    //================================================================================
    // 3. 请求拦截 (Fetch & XHR, 与v2相同)
    //================================================================================
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const [url, options] = args;
        if (isCollecting && typeof url === 'string' && url === TARGET_URL && options && options.method.toUpperCase() === 'POST') {
            const capturedOptions = JSON.parse(JSON.stringify(options));
            capturedOptions.headers = {};
            if (options.headers) {
                if (options.headers instanceof Headers) {
                    options.headers.forEach((value, key) => { capturedOptions.headers[key] = value; });
                } else {
                    capturedOptions.headers = options.headers;
                }
            }
            captureRequest({ url, options: capturedOptions }, 'Fetch');
        }
        return originalFetch.apply(this, args);
    };

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._method = method;
        this._url = url;
        this._headers = {};
        return originalXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        this._headers[header.toLowerCase()] = value;
        return originalXhrSetRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
        if (isCollecting && this._url === TARGET_URL && this._method.toUpperCase() === 'POST') {
            const requestData = {
                url: this._url,
                options: { method: this._method, headers: this._headers, body: body }
            };
            captureRequest(requestData, 'XHR');
        }
        return originalXhrSend.apply(this, arguments);
    };


    //================================================================================
    // 4. UI 界面与交互 (部分修改以显示凭证状态)
    //================================================================================
    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'snatcher-panel';
        panel.innerHTML = `
            <div id="snatcher-header">
                JNU 抢课助手 (v3)
                <span id="snatcher-drag-handle"> (拖动)</span>
                <span id="snatcher-toggle-view">[-]</span>
            </div>
            <div id="snatcher-content">
                <div class="control-section">
                    <h4>1. 捕获选课请求</h4>
                    <button id="collect-btn" class="snatcher-btn">开始捕获</button>
                    <button id="clear-btn" class="snatcher-btn">清空列表</button>
                    <p class="info">点击"开始捕获"，然后正常选课。脚本将自动使用最后一次操作的凭证(Token/Cookie)。
                        <span id="auth-status" class="status-bad">凭证未捕获</span>
                    </p>
                </div>
                <div class="control-section">
                    <h4>2. 设置抢课参数</h4>
                    <div class="input-group"><label for="start-time">抢课开始时间:</label><input type="datetime-local" id="start-time"></div>
                    <div class="input-group"><label for="interval-ms">发包间隔(毫秒):</label><input type="number" id="interval-ms" value="200" min="50"></div>
                    <div class="input-group"><label for="duration-s">持续时间(秒):</label><input type="number" id="duration-s" value="10" min="1"></div>
                     <button id="arm-btn" class="snatcher-btn arm-btn">锁定设置 & 准备抢课</button>
                </div>
                <div class="display-section">
                    <h4>捕获的请求 (<span id="request-count">0</span>)</h4>
                    <div id="request-list"></div>
                </div>
                <div class="display-section"><h4>日志输出</h4><div id="log-output"></div></div>
            </div>
        `;
        document.body.appendChild(panel);
        updateRequestCount();
        const now = new Date(); now.setMinutes(now.getMinutes() + 5); now.setSeconds(0);
        const defaultTime = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}T${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        document.getElementById('start-time').value = defaultTime;
    }

    function addStyles() {
        GM_addStyle(`
            #snatcher-panel { position: fixed; top: 100px; left: 20px; z-index: 9999; background-color: #f0f8ff; border: 1px solid #4682b4; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.2); width: 380px; font-family: 'Microsoft YaHei', sans-serif; }
            #snatcher-header { padding: 10px; background-color: #4682b4; color: white; font-weight: bold; border-radius: 8px 8px 0 0; }
            #snatcher-drag-handle { cursor: move; }
            #snatcher-content { padding: 10px; }
            #snatcher-content.hidden { display: none; }
            #snatcher-toggle-view { float: right; cursor: pointer; font-weight: bold; }
            .control-section, .display-section { margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #dcdcdc; }
            h4 { color: #0056b3; margin-top: 0; margin-bottom: 8px; }
            .snatcher-btn { background-color: #5a9bd5; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; margin-right: 5px; }
            .snatcher-btn:hover { background-color: #4a8ac5; }
            #collect-btn.collecting { background-color: #dc3545; }
            #arm-btn.armed { background-color: #28a745; cursor: not-allowed; }
            .input-group { margin-bottom: 8px; display: flex; align-items: center; }
            .input-group label { width: 120px; font-size: 14px; }
            .input-group input { flex-grow: 1; padding: 4px; border-radius: 3px; border: 1px solid #ccc; }
            #request-list, #log-output { height: 100px; overflow-y: auto; background-color: #fff; border: 1px solid #ddd; padding: 5px; font-size: 12px; white-space: pre-wrap; word-wrap: break-word; }
            .info { font-size: 12px; color: #666; margin-top: 5px; }
            #auth-status { font-weight: bold; padding: 2px 5px; border-radius: 3px; margin-left: 5px; }
            .status-ok { color: #155724; background-color: #d4edda; }
            .status-bad { color: #721c24; background-color: #f8d7da; }
        `);
    }

    function updateAuthStatus() {
        const statusEl = document.getElementById('auth-status');
        if (!statusEl) return;
        if (latestAuth.token || latestAuth.cookie) {
            statusEl.textContent = '凭证已捕获';
            statusEl.className = 'status-ok';
        } else {
            statusEl.textContent = '凭证未捕获';
            statusEl.className = 'status-bad';
        }
    }

    // 其他UI交互函数 (与v2相同)
    function setupUIHandlers(){ let isDragging=!1,offsetX,offsetY;const panel=document.getElementById("snatcher-panel"),dragHandle=document.getElementById("snatcher-drag-handle");dragHandle.addEventListener("mousedown",e=>{isDragging=!0,offsetX=e.clientX-panel.offsetLeft,offsetY=e.clientY-panel.offsetTop,document.addEventListener("mousemove",onMouseMove),document.addEventListener("mouseup",onMouseUp)});function onMouseMove(e){isDragging&&(panel.style.left=`${e.clientX-offsetX}px`,panel.style.top=`${e.clientY-offsetY}px`)}function onMouseUp(){isDragging=!1,document.removeEventListener("mousemove",onMouseMove),document.removeEventListener("mouseup",onMouseUp)}document.getElementById("snatcher-toggle-view").addEventListener("click",e=>{const content=document.getElementById("snatcher-content");content.classList.toggle("hidden"),e.target.textContent=content.classList.contains("hidden")?"[+]":"[-]"}),document.getElementById("collect-btn").addEventListener("click",toggleCollection),document.getElementById("clear-btn").addEventListener("click",clearRequests),document.getElementById("arm-btn").addEventListener("click",armSnatcher)}
    function logMessage(e,t="info"){const o=document.getElementById("log-output");if(!o)return;const n=(new Date).toLocaleTimeString(),a="error"===t?"red":"success"===t?"green":"black";o.innerHTML+=`<p style="color:${a}; margin:0;">[${n}] ${e}</p>`,o.scrollTop=o.scrollHeight}
    function updateRequestDisplay(){const e=document.getElementById("request-list");if(!e)return;e.innerHTML="",collectedRequests.forEach((t,o)=>{let n="未知课程";try{const a=new URLSearchParams(t.options.body),s=JSON.parse(a.get("addParam"));n=`课程ID: ${s.data.teachingClassId}`}catch(e){}e.innerHTML+=`<p style="margin:0;">[${o+1}] ${n}</p>`}),updateRequestCount()}
    function updateRequestCount(){const e=document.getElementById("request-count");e&&(e.textContent=collectedRequests.length)}
    function toggleCollection(){const e=document.getElementById("collect-btn");(isCollecting=!isCollecting)?(e.textContent="停止捕获",e.classList.add("collecting"),logMessage("开始捕获选课请求...","success")):(e.textContent="开始捕获",e.classList.remove("collecting"),logMessage("已停止捕获。"))}
    function clearRequests(){confirm("确定要清空所有已捕获的请求吗？")&&(collectedRequests=[],latestAuth={token:null,cookie:null},GM_setValue("courseRequests_jnu","[]"),updateRequestDisplay(),updateAuthStatus(),logMessage("已清空所有捕获的请求和凭证。","info"))}

    //================================================================================
    // 5. 抢课核心逻辑 (已更新为使用最新凭证)
    //================================================================================
    function armSnatcher() {
        if (isSnatchingArmed) { logMessage('任务已锁定，勿重复点击。', 'error'); return; }
        if (!document.getElementById('start-time').value) { alert('请设置抢课开始时间！'); return; }
        if (collectedRequests.length === 0) { alert('捕获列表为空，请先捕获请求！'); return; }
        if (!latestAuth.token && !latestAuth.cookie) { alert('未能捕获到关键凭证(Token/Cookie)，请至少成功捕获一个请求！'); return; }
        const startTime = new Date(document.getElementById('start-time').value).getTime();
        if (startTime - Date.now() <= 0) { alert('设置的开始时间已过！'); return; }
        isSnatchingArmed = true;
        document.getElementById('arm-btn').classList.add('armed');
        document.getElementById('arm-btn').textContent = '已锁定，等待执行...';
        document.querySelectorAll('#snatcher-content input, #collect-btn, #clear-btn').forEach(el => el.disabled = true);
        logMessage(`抢课任务已锁定! 将在 ${new Date(startTime).toLocaleString()} 开始。`, 'success');
        setTimeout(startSnatching, startTime - Date.now());
    }

    function startSnatching() {
        const interval = parseInt(document.getElementById('interval-ms').value, 10);
        const duration = parseInt(document.getElementById('duration-s').value, 10) * 1000;
        logMessage('时间到！开始抢课！将统一使用最新凭证。', 'success');

        let requestIndex = 0;
        snatchingIntervalId = setInterval(() => {
            if (collectedRequests.length === 0) {
                stopSnatching();
                return;
            }
            const requestData = collectedRequests[requestIndex % collectedRequests.length];
            requestIndex++;

            // v3核心: 准备最终发包的 options
            const finalOptions = JSON.parse(JSON.stringify(requestData.options));
            // 统一替换为最新的凭证
            if (latestAuth.token) { finalOptions.headers['token'] = latestAuth.token; }
            if (latestAuth.cookie) { finalOptions.headers['cookie'] = latestAuth.cookie; }

            let courseInfo = `请求 #${requestIndex}`;
            try {
                const bodyParams = new URLSearchParams(finalOptions.body);
                const addParam = JSON.parse(bodyParams.get('addParam'));
                courseInfo = `课程ID: ${addParam.data.teachingClassId}`;
            } catch (e) {}

            logMessage(`发送第 ${requestIndex} 个请求 (${courseInfo})...`);
            originalFetch(requestData.url, finalOptions)
                .then(response => response.json())
                .then(data => {
                    const message = data.msg || JSON.stringify(data);
                    const type = (data.code && data.code === "1") ? 'success' : 'error';
                    logMessage(`响应 (${courseInfo}): ${message}`, type);
                })
                .catch(err => logMessage(`请求失败 (${courseInfo}): ${err.message}`, 'error'));
        }, interval);

        snatchingTimeoutId = setTimeout(stopSnatching, duration);
    }

    function stopSnatching() {
        clearInterval(snatchingIntervalId);
        clearTimeout(snatchingTimeoutId);
        logMessage('抢课结束。', 'info');
        const armBtn = document.getElementById('arm-btn');
        armBtn.textContent = '任务已结束';
        armBtn.disabled = true;
    }

    //================================================================================
    // 6. 脚本初始化
    //================================================================================
    window.addEventListener('DOMContentLoaded', () => {
        try {
            createUI(); addStyles(); setupUIHandlers();
            updateRequestDisplay(); updateAuthStatus();
            logMessage("抢课助手(v3)已加载。");
        } catch (e) { console.error("抢课助手加载失败:", e); alert("抢课助手加载失败。"); }
    });
})();