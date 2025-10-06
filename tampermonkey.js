// ==UserScript==
// @name         EdgeX AI量化交易机器人 - 完整终极版
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  AI驱动智能量化交易，完整功能集成版
// @author       fxfox
// @match        https://pro.edgex.exchange/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      154.17.228.72
// @connect      api.binance.com
// ==/UserScript==

const AI_PROXY_API = 'http://154.17.228.72:12345/ai-decision';

const config = {
    ticker: 'ETH',
    quantity: '0.02',
    minInterval: 3,
    maxInterval: 20,
    priceHistoryLength: 8,
    enableAI: true,
    debugMode: true,
    sessionCheckInterval: 5,
    keepAliveInterval: 30,
    fastCollectSec: 30,
    confirmWaitMs: 1000,
    priceOffset: 0.001,
    externalMarket: {
        enabled: true,
        symbol: 'ETHUSDT',
        ttl: 60,
        klineInterval: '1m',
        klineLimit: 60
    }
};

const SELECTORS = {
    price: 'span[data-outer-price]',
    buyButton: 'button[class*="bg-[--long]"]',
    sellButton: 'button[class*="bg-[--short]"]',
    limitPriceInput: 'input[placeholder="委托价格"]',
    amountInput: 'input[id="orderSizeValue"]',
    positionTable: '#radix-\\:rf8\\:-content-positions table tbody tr',
    positionDirection: '.inline-flex .text-\\[--long\\], .inline-flex .text-\\[--short\\]',
    positionSize: 'td:nth-child(2)',
    closeLimitBtn: 'button:contains("限价")',
    closeConfirmBtn: '.btn-primary.grow',
    activeOrderTab: 'button[role="tab"][aria-controls$="content-activeOrder"]',
    activeOrderPanel: '[id$="content-activeOrder"]',
    activeOrderRows: '[id$="content-activeOrder"] tbody tr'
};

let priceHistory = [];
let tradeCount = 0;
let totalVolume = 0;
let isRunning = false;
let mainTimer = null;
let keepAliveTimer = null;
let sessionTimer = null;
let startTime = Date.now();
let externalDataCache = { timestamp: 0, payload: null };

function setReactInputValue(input, value) {
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    const setter = descriptor ? descriptor.set : null;
    if (setter) {
        setter.call(input, value);
    } else {
        input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function normalizeText(text) {
    return text ? text.replace(/\s+/g, ' ').trim() : '';
}

function parseQuantityPair(text) {
    if (!text) return { filled: NaN, total: NaN };
    const parts = text.split('/').map(part => parseFloat(part.replace(/[^0-9.+-]/g, '')));
    return {
        filled: Number.isFinite(parts[0]) ? parts[0] : 0,
        total: Number.isFinite(parts[1]) ? parts[1] : 0
    };
}

function gmRequestJSON(url) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            headers: { 'Content-Type': 'application/json' },
            onload: response => {
                try {
                    const data = JSON.parse(response.responseText);
                    resolve(data);
                } catch (err) {
                    reject(err);
                }
            },
            onerror: error => reject(error)
        });
    });
}

async function getExternalMarketSnapshot() {
    if (!config.externalMarket?.enabled) return null;

    const now = Date.now();
    if (externalDataCache.payload && (now - externalDataCache.timestamp) < (config.externalMarket.ttl * 1000)) {
        return externalDataCache.payload;
    }

    const symbol = config.externalMarket.symbol;
    const klineInterval = config.externalMarket.klineInterval;
    const klineLimit = config.externalMarket.klineLimit;

    try {
        const [ticker, klines] = await Promise.all([
            gmRequestJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
            gmRequestJSON(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${klineInterval}&limit=${klineLimit}`)
        ]);

        const formatted = {
            source: 'binance',
            symbol,
            fetchedAt: now,
            ticker: {
                priceChangePercent: parseFloat(ticker.priceChangePercent),
                volume: parseFloat(ticker.volume),
                quoteVolume: parseFloat(ticker.quoteVolume),
                highPrice: parseFloat(ticker.highPrice),
                lowPrice: parseFloat(ticker.lowPrice),
                lastPrice: parseFloat(ticker.lastPrice)
            },
            klines: klines.map(item => ({
                openTime: item[0],
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[5])
            }))
        };

        externalDataCache = { timestamp: now, payload: formatted };
        return formatted;
    } catch (error) {
        if (config.debugMode) log(`外部行情数据获取失败: ${error.message || error}`, 'warn');
        return null;
    }
}

function getActiveOrders() {
    const rows = document.querySelectorAll(SELECTORS.activeOrderRows);
    if (!rows || rows.length === 0) return [];

    return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('th, td');
        if (!cells || cells.length < 4) return null;

        const priceText = normalizeText(cells[1]?.textContent || '');
        const quantityText = normalizeText(cells[2]?.textContent || '');
        const sideText = normalizeText(cells[3]?.textContent || '');
        const orderIdText = normalizeText(cells[5]?.textContent || '');

        const price = parseFloat(priceText.replace(/,/g, ''));
        const { filled, total } = parseQuantityPair(quantityText);

        let side = null;
        if (sideText.includes('买')) side = 'buy';
        else if (sideText.includes('卖')) side = 'sell';

        return {
            row,
            contract: normalizeText(cells[0]?.textContent || ''),
            price: Number.isFinite(price) ? price : NaN,
            filledQty: Number.isFinite(filled) ? filled : 0,
            totalQty: Number.isFinite(total) ? total : 0,
            side,
            orderId: orderIdText
        };
    }).filter(order => order && order.side && Number.isFinite(order.price) && order.totalQty > 0);
}

function findMatchingActiveOrder(direction, price, amount) {
    const orders = getActiveOrders();
    if (orders.length === 0) return null;

    const targetAmount = amount ? parseFloat(amount) : NaN;
    const hasTargetAmount = Number.isFinite(targetAmount);
    const hasTargetPrice = Number.isFinite(price);

    const priceTolerance = hasTargetPrice ? Math.max(0.5, price * 0.0015) : Infinity;
    const amountTolerance = hasTargetAmount ? Math.max(0.0001, targetAmount * 0.05) : Infinity;

    return orders.find(order => {
        if (order.side !== direction) return false;
        if (order.filledQty >= order.totalQty) return false;
        if (hasTargetPrice && Math.abs(order.price - price) > priceTolerance) return false;
        if (hasTargetAmount && Math.abs(order.totalQty - targetAmount) > amountTolerance) return false;
        return true;
    }) || null;
}

function createControlPanel() {
    if (document.getElementById('edgex-ai-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'edgex-ai-panel';
    panel.style.cssText = `
        position: fixed; right: 30px; bottom: 40px; z-index: 999999;
        background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
        border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        padding: 16px; color: #fff; font-size: 14px; min-width: 280px;
        font-family: 'Segoe UI', sans-serif;
    `;
    panel.innerHTML = `
        <div style="font-weight:bold;margin-bottom:12px;text-align:center;">🤖 EdgeX AI机器人</div>
        <div style="display:flex;gap:10px;margin-bottom:10px;">
            <button id="start-btn" style="flex:1;padding:10px;background:#4CAF50;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:bold;">🚀 开始</button>
            <button id="stop-btn" style="flex:1;padding:10px;background:#f44336;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:bold;">⏹️ 停止</button>
        </div>
        <div id="status-area" style="background:rgba(0,0,0,0.2);border-radius:8px;padding:12px;margin-bottom:10px;">
            <div style="font-weight:bold;color:#FFD700;margin-bottom:5px;">📊 状态</div>
            <div id="status-content" style="font-size:12px;">⏸️ 等待启动...</div>
        </div>
        <div id="stats-area" style="background:rgba(0,0,0,0.2);border-radius:8px;padding:12px;">
            <div style="font-weight:bold;color:#FFD700;margin-bottom:5px;">💰 统计</div>
            <div style="font-size:12px;">
                <div>次数: <span id="trade-count" style="color:#4CAF50;">0</span></div>
                <div>累计: $<span id="total-volume" style="color:#4CAF50;">0</span></div>
                <div>时间: <span id="run-time" style="color:#2196F3;">00:00:00</span></div>
                <div>进度: <span id="data-progress" style="color:#FF9800;">0/8</span></div>
                <div>持仓: <span id="position-info" style="color:#FFD700;">无</span></div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('start-btn').onclick = () => startScript();
    document.getElementById('stop-btn').onclick = () => stopScript();
}

function log(msg, type = 'info') {
    const status = document.getElementById('status-content');
    if (status) {
        const timestamp = new Date().toLocaleTimeString();
        status.innerHTML = `${msg}<br><small style="color:#ccc;">${timestamp}</small>`;
    }
    updateStats();
    if (config.debugMode) console.log('[EdgeX-AI]', msg);
}

function updateStats() {
    const elements = {
        count: document.getElementById('trade-count'),
        volume: document.getElementById('total-volume'),
        progress: document.getElementById('data-progress'),
        runTime: document.getElementById('run-time'),
        position: document.getElementById('position-info')
    };

    if (elements.count) elements.count.textContent = tradeCount;
    if (elements.volume) elements.volume.textContent = totalVolume.toFixed(2);
    if (elements.progress) elements.progress.textContent = `${priceHistory.length}/${config.priceHistoryLength}`;

    if (elements.runTime) {
        const elapsed = Date.now() - startTime;
        const h = Math.floor(elapsed / 3600000);
        const m = Math.floor((elapsed % 3600000) / 60000);
        const s = Math.floor((elapsed % 60000) / 1000);
        elements.runTime.textContent = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    }

    if (elements.position) {
        const pos = getCurrentPosition();
        elements.position.textContent = pos ? `${pos.direction} ${pos.size}` : '无';
    }
}

function getCurrentPriceAndUpdateHistory() {
    const priceEl = document.querySelector(SELECTORS.price);
    if (!priceEl) return null;
    const price = parseFloat(priceEl.textContent.replace(/,/g, ''));
    if (!isNaN(price) && price > 0) {
        priceHistory.push(price);
        if (priceHistory.length > config.priceHistoryLength) priceHistory.shift();
        return price;
    }
    return null;
}

function getCurrentPosition() {
    try {
        const posRows = document.querySelectorAll(SELECTORS.positionTable);
        if (posRows.length === 0) return null;

        const row = posRows[0];
        const directionEl = row.querySelector(SELECTORS.positionDirection);
        const sizeEl = row.querySelector(SELECTORS.positionSize);

        if (!directionEl || !sizeEl) return null;

        const direction = directionEl.textContent.includes('做多') ? 'long' : 'short';
        const size = parseFloat(sizeEl.textContent);

        return {
            hasPosition: true,
            direction: direction,
            size: size,
            row: row
        };
    } catch (error) {
        return null;
    }
}

function calculateTechnicalIndicators() {
    const length = priceHistory.length;
    let ma5 = null, ma8 = null;

    if (length >= 5) {
        ma5 = priceHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
    }
    if (length >= 8) {
        ma8 = priceHistory.slice(-8).reduce((a, b) => a + b, 0) / 8;
    }

    let volatility = 0;
    if (length >= 3) {
        const returns = [];
        for (let i = 1; i < length; i++) {
            returns.push((priceHistory[i] - priceHistory[i-1]) / priceHistory[i-1]);
        }
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        volatility = Math.sqrt(variance) * 100;
    }

    // 趋势判断
    let trend = "neutral";
    if (length >= 5) {
        const change = (priceHistory[length-1] - priceHistory[length-5]) / priceHistory[length-5];
        if (change > 0.001) trend = 'bullish';
        else if (change < -0.001) trend = 'bearish';
    }

    return { ma5, ma8, volatility, trend };
}

function getAIDecision(currentPrice) {
    return new Promise((resolve) => {
        if (!config.enableAI || priceHistory.length < config.priceHistoryLength) {
            resolve('hold');
            return;
        }

        const indicators = calculateTechnicalIndicators();
        const position = getCurrentPosition();

        getExternalMarketSnapshot().then(externalMarket => {
            const enhancedData = {
                symbol: config.ticker + 'USD',
                timestamp: Date.now(),
                priceHistory: priceHistory,
                currentPrice: currentPrice,
                priceChange: ((currentPrice - priceHistory[0]) / priceHistory[0]) * 100,
                indicators: indicators,
                position: position ? {
                    hasPosition: true,
                    direction: position.direction,
                    size: position.size
                } : {
                    hasPosition: false
                },
                tradingStats: {
                    totalTrades: tradeCount,
                    totalVolume: totalVolume,
                    sessionDuration: Math.floor((Date.now() - startTime) / 60000)
                },
                externalMarket: externalMarket
            };

            GM_xmlhttpRequest({
                method: "POST",
                url: AI_PROXY_API,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(enhancedData),
                onload: function(response) {
                    try {
                        const result = JSON.parse(response.responseText);
                        const direction = result.direction || 'hold';
                        log(`🤖 AI决策: ${direction.toUpperCase()} (基于${config.ticker})`);
                        resolve(direction);
                    } catch (e) {
                        log(`AI响应解析失败: ${e.message}`);
                        resolve('hold');
                    }
                },
                onerror: function(error) {
                    log(`AI服务连接失败，使用观望策略`);
                    resolve('hold');
                }
            });
        });
    });
}

function clickConfirmButton(direction) {
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 8;

        const findAndClick = () => {
            attempts++;

            // 方法1: 按钮文本匹配
            const allButtons = Array.from(document.querySelectorAll('button'));
            let confirmBtn = null;

            if (direction === 'buy') {
                confirmBtn = allButtons.find(btn =>
                    btn.textContent &&
                    (btn.textContent.includes('确认 买入') ||
                     btn.textContent.includes('确认买入') ||
                     btn.textContent.trim() === '确认买入')
                );
            } else if (direction === 'sell') {
                confirmBtn = allButtons.find(btn =>
                    btn.textContent &&
                    (btn.textContent.includes('确认 卖出') ||
                     btn.textContent.includes('确认卖出') ||
                     btn.textContent.trim() === '确认卖出')
                );
            }

            // 方法2: 通用确认按钮匹配
            if (!confirmBtn) {
                confirmBtn = allButtons.find(btn =>
                    btn.textContent &&
                    btn.textContent.includes('确认') &&
                    btn.classList.contains('btn-primary')
                );
            }

            // 方法3: CSS选择器匹配
            if (!confirmBtn) {
                const dialogs = document.querySelectorAll('[role="alertdialog"], [role="dialog"]');
                for (const dialog of dialogs) {
                    if (dialog.offsetParent !== null) {
                        const primaryBtns = dialog.querySelectorAll('button.btn-primary');
                        if (primaryBtns.length > 0) {
                            confirmBtn = Array.from(primaryBtns).find(btn =>
                                !btn.textContent.includes('取消')
                            ) || primaryBtns[0];
                            break;
                        }
                    }
                }
            }

            if (confirmBtn && confirmBtn.offsetParent !== null && !confirmBtn.disabled) {
                confirmBtn.click();
                log(`✅ 成功确认${direction === 'buy' ? '买入' : '卖出'} (第${attempts}次尝试)`);
                resolve(true);
                return;
            }

            if (attempts < maxAttempts) {
                setTimeout(findAndClick, 500);
            } else {
                log(`❌ ${maxAttempts}次尝试后仍未找到确认按钮`);
                resolve(false);
            }
        };

        setTimeout(findAndClick, 800);
    });
}

function switchToLimitOrder() {
    return new Promise((resolve) => {
        const limitTab = Array.from(document.querySelectorAll('div')).find(el =>
            el.textContent && el.textContent.trim() === '限价' &&
            el.getAttribute('data-state') !== 'active'
        );

        if (limitTab) {
            limitTab.click();
            log('已切换到限价模式');
            setTimeout(resolve, 600);
        } else {
            resolve();
        }
    });
}

async function executeLimitOrder(direction, price, amount) {
    log(`准备限价${direction === 'buy' ? '买入' : '卖出'}: ${amount} @ ${price.toFixed(2)}`);

    try {
        const existingOrder = findMatchingActiveOrder(direction, price, amount);
        if (existingOrder) {
            log(`⚠️ 已存在未成交的${direction === 'buy' ? '买入' : '卖出'}委托 (${existingOrder.totalQty.toFixed(4)} @ ${existingOrder.price.toFixed(2)})，跳过重复下单`);
            return false;
        }

        // 1. 切换到限价模式
        await switchToLimitOrder();

        // 2. 填写限价价格
        const priceInput = document.querySelector(SELECTORS.limitPriceInput);
        if (priceInput) {
            priceInput.focus();
            priceInput.select();
            setReactInputValue(priceInput, price.toFixed(2));
            log(`✏️ 已设置价格: ${price.toFixed(2)}`);
        } else {
            log('❌ 找不到价格输入框');
            return false;
        }

        // 3. 填写数量
        const amountInput = document.querySelector(SELECTORS.amountInput);
        if (amountInput) {
            amountInput.focus();
            amountInput.select();
            setReactInputValue(amountInput, amount);
            log(`✏️ 已设置数量: ${amount}`);
        } else {
            log('❌ 找不到数量输入框');
            return false;
        }

        // 4. 等待表单输入生效
        await new Promise(resolve => setTimeout(resolve, 1200));

        // 5. 点击买入/卖出按钮
        const button = direction === 'buy' ?
            document.querySelector(SELECTORS.buyButton) :
            document.querySelector(SELECTORS.sellButton);

        if (button) {
            button.click();
            log(`📝 ${direction === 'buy' ? '买入' : '卖出'}按钮已点击`);

            // 6. 自动处理确认弹窗
            const confirmSuccess = await clickConfirmButton(direction);

            if (confirmSuccess) {
                tradeCount += 1;
                totalVolume += parseFloat(amount) * price;
                log(`🎉 限价${direction === 'buy' ? '买入' : '卖出'}成功 #${tradeCount}`);
                return true;
            } else {
                log(`⚠️ 限价${direction === 'buy' ? '买入' : '卖出'}确认失败`);
                return false;
            }
        } else {
            log(`❌ 找不到${direction === 'buy' ? '买入' : '卖出'}按钮`);
            return false;
        }

    } catch (error) {
        log(`限价开仓异常: ${error.message}`);
        return false;
    }
}

async function executeLimitClose(position, price) {
    log(`准备限价平${position.direction === 'long' ? '多' : '空'}: ${position.size} @ ${price.toFixed(2)}`);

    try {
        const closeLimitBtn = position.row.querySelector(SELECTORS.closeLimitBtn);
        if (closeLimitBtn) {
            closeLimitBtn.click();
            log('已点击限价平仓按钮');

            setTimeout(() => {
                const closeConfirmBtn = document.querySelector(SELECTORS.closeConfirmBtn);
                if (closeConfirmBtn) {
                    closeConfirmBtn.click();
                    tradeCount += 1;
                    totalVolume += position.size * price;
                    log(`🎉 限价平仓成功 #${tradeCount}`);
                } else {
                    log('❌ 找不到平仓确认按钮');
                }
            }, 1200);

            return true;
        } else {
            log('❌ 找不到限价平仓按钮');
            return false;
        }
    } catch (error) {
        log(`限价平仓异常: ${error.message}`);
        return false;
    }
}

async function executeSmartTrade(aiSignal, currentPrice) {
    const position = getCurrentPosition();

    const buyPrice = currentPrice * (1 - config.priceOffset);
    const sellPrice = currentPrice * (1 + config.priceOffset);

    if (position && position.hasPosition) {
        if ((position.direction === 'long' && aiSignal === 'sell') ||
            (position.direction === 'short' && aiSignal === 'buy')) {
            const closePrice = position.direction === 'long' ? sellPrice : buyPrice;
            log(`持有${position.direction}仓位，AI建议${aiSignal}，执行平仓`);
            return await executeLimitClose(position, closePrice);
        } else {
            log(`持有${position.direction}仓位，AI建议${aiSignal}，暂不操作`);
            return false;
        }
    } else {
        if (aiSignal === 'buy') {
            return await executeLimitOrder('buy', buyPrice, config.quantity);
        } else if (aiSignal === 'sell') {
            return await executeLimitOrder('sell', sellPrice, config.quantity);
        }
    }

    return false;
}

function getRandomDelay(isFast) {
    if (isFast) return config.fastCollectSec;
    const min = config.minInterval * 60;
    const max = config.maxInterval * 60;
    return Math.floor(Math.random() * (max - min)) + min;
}

async function mainTradingLoop() {
    if (!isRunning) return;

    const price = getCurrentPriceAndUpdateHistory();
    const isCollecting = priceHistory.length < config.priceHistoryLength;

    if (!price) {
        log('未能获取行情，30秒后重试');
        mainTimer = setTimeout(mainTradingLoop, 30000);
        return;
    }

    if (isCollecting) {
        log(`数据采集中...${priceHistory.length}/${config.priceHistoryLength}`);
    } else {
        const aiDecision = await getAIDecision(price);

        if (aiDecision !== 'hold') {
            await executeSmartTrade(aiDecision, price);
        } else {
            log('AI建议观望');
        }
    }

    const nextDelay = getRandomDelay(isCollecting);
    const minutes = Math.floor(nextDelay / 60);
    const seconds = nextDelay % 60;

    log(`${isCollecting ? '采集阶段' : '交易阶段'}，下轮 ${minutes}分${seconds}秒后`);
    mainTimer = setTimeout(mainTradingLoop, nextDelay * 1000);
}

function setupKeepAlive() {
    keepAliveTimer = setInterval(() => {
        document.dispatchEvent(new MouseEvent('mousemove', {
            clientX: Math.random() * 100,
            clientY: Math.random() * 100,
            bubbles: true
        }));
        updateStats();
    }, config.keepAliveInterval * 1000);
}

function setupSessionCheck() {
    sessionTimer = setInterval(() => {
        const elements = [
            document.querySelector(SELECTORS.price),
            document.querySelector(SELECTORS.buyButton),
            document.querySelector(SELECTORS.sellButton),
            document.querySelector(SELECTORS.amountInput)
        ];

        const missing = elements.filter(el => !el).length;
        if (missing > 0) {
            log(`⚠️ ${missing}个页面元素丢失，可能需重新登录`);
        }
    }, config.sessionCheckInterval * 60 * 1000);
}

function startScript() {
    if (isRunning) {
        log('脚本已在运行中');
        return;
    }

    const elements = [
        document.querySelector(SELECTORS.price),
        document.querySelector(SELECTORS.buyButton),
        document.querySelector(SELECTORS.sellButton),
        document.querySelector(SELECTORS.amountInput)
    ];

    if (elements.some(el => !el)) {
        log('❌ 页面元素检测失败，请确认已登录EdgeX');
        return;
    }

    isRunning = true;
    startTime = Date.now();
    log('🚀 EdgeX AI量化交易机器人已启动');

    setupKeepAlive();
    setupSessionCheck();
    mainTimer = setTimeout(mainTradingLoop, 3000);
}

function stopScript() {
    isRunning = false;
    log('⏹️ 脚本已停止');

    if (mainTimer) clearTimeout(mainTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (sessionTimer) clearInterval(sessionTimer);

    log(`运行总结: 交易${tradeCount}次, 总量$${totalVolume.toFixed(2)}`);
}

(function init() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(createControlPanel, 1000));
    } else {
        setTimeout(createControlPanel, 1000);
    }

    const api = {
        start: startScript,
        stop: stopScript,
        config: config,
        position: getCurrentPosition,
        testOrder: (direction = 'buy', manualPrice, manualAmount) => {
            const priceText = document.querySelector(SELECTORS.price)?.textContent;
            const fallbackPrice = priceText ? parseFloat(priceText.replace(/,/g, '')) : null;
            const basePrice = typeof manualPrice === 'number' ? manualPrice : fallbackPrice;

            if (!basePrice || Number.isNaN(basePrice)) {
                log('❌ 无法获取测试价格');
                return Promise.resolve(false);
            }

            const tradePrice = direction === 'buy'
                ? basePrice * (1 - config.priceOffset)
                : basePrice * (1 + config.priceOffset);

            return executeLimitOrder(direction, tradePrice, manualAmount ?? config.quantity);
        },
        stats: () => console.log(`运行状态: ${isRunning}, 交易: ${tradeCount}次, 总量: $${totalVolume.toFixed(2)}`)
    };

    window.edgexBot = api;
    if (typeof unsafeWindow !== 'undefined') {
        unsafeWindow.edgexBot = api;
    }

    console.log('[EdgeX-AI] 脚本已初始化完成');
})();
