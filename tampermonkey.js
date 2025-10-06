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
    minInterval: 1,
    maxInterval: 4,
    priceHistoryLength: 20,
    enableAI: true,
    debugMode: true,
    sessionCheckInterval: 5,
    keepAliveInterval: 30,
    fastCollectSec: 5,
    confirmWaitMs: 1000,
    priceOffset: 0.001,
    dynamicOffset: {
        enabled: true,
        minOffset: 0.0002,
        maxOffset: 0.0015,
        volatilityFactor: 0.8,
        fallbackOffset: 0.001
    },
    externalMarket: {
        enabled: true,
        symbol: 'ETHUSDT',
        ttl: 10,
        klineInterval: '1m',
        klineLimit: 60,
        priceDriftThreshold: 0.002
    },
    riskManagement: {
        enabled: true,
        stopLossPct: 0.6,
        takeProfitPct: 1.0,
        maxHoldMinutes: 30,
        maxOrderWaitSeconds: 60,
        signalConfirmationCount: 1,
        dailyLossLimit: -30,
        maxConsecutiveLosses: 3,
        pauseMinutesOnBreach: 60
    },
    dataHealth: {
        enabled: true,
        maxStagnantCycles: 5,
        maxStagnantMs: 120000,
        externalDrift: 0.02,
        reloadDelaySeconds: 5
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
let currentPositionState = null;
let pendingOrders = {
    buy: null,
    sell: null
};
let lastOpenOrdersSnapshot = [];
let signalHistory = {
    last: null,
    count: 0
};
let pnlTracker = {
    realized: 0,
    dailyRealized: 0,
    dailyDate: null,
    consecutiveLosses: 0,
    lastTradePnL: null
};
let riskPauseUntil = 0;
const RELOAD_STATE_KEY = 'edgexBotReloadState';
let lastExternalSnapshot = null;
const healthMonitor = {
    lastPrice: null,
    lastChangeTime: 0,
    stagnantCycles: 0,
    reloading: false,
    lastReason: null
};

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

async function getExternalMarketSnapshot(referencePrice) {
    if (!config.externalMarket?.enabled) return null;

    const now = Date.now();
    const cache = externalDataCache.payload;
    const ttlMs = (config.externalMarket.ttl ?? 10) * 1000;
    const priceThreshold = config.externalMarket.priceDriftThreshold ?? 0.0;

    if (cache) {
        const age = now - externalDataCache.timestamp;
        const cachedPrice = Number.isFinite(cache?.ticker?.lastPrice) ? cache.ticker.lastPrice : null;
        const hasFreshPrice = Number.isFinite(referencePrice) && Number.isFinite(cachedPrice);
        const priceDrift = hasFreshPrice && referencePrice > 0
            ? Math.abs(referencePrice - cachedPrice) / referencePrice
            : 0;

        if (age < ttlMs && (!hasFreshPrice || priceDrift <= priceThreshold)) {
            lastExternalSnapshot = cache;
            return cache;
        }
    }

    const symbol = config.externalMarket.symbol;
    const klineInterval = config.externalMarket.klineInterval;
    const klineLimit = config.externalMarket.klineLimit;

    try {
        const [ticker, klines] = await Promise.all([
            gmRequestJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
            gmRequestJSON(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${klineInterval}&limit=${klineLimit}`)
        ]);

        const lastPrice = parseFloat(ticker.lastPrice);
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
                lastPrice: lastPrice
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
        lastExternalSnapshot = formatted;
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
        const timeText = normalizeText(cells[6]?.textContent || '');

        const price = parseFloat(priceText.replace(/,/g, ''));
        const { filled, total } = parseQuantityPair(quantityText);
        let orderTime = null;
        if (timeText) {
            const parsed = Date.parse(timeText.replace(/-/g, '/'));
            if (!Number.isNaN(parsed)) orderTime = parsed;
        }

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
            orderId: orderIdText,
            orderTime
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

function toleranceForAmount(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return 0.0001;
    return Math.max(0.0001, amount * 0.05);
}

function pendingOrderMaxAgeMs() {
    const waitSec = config.riskManagement?.maxOrderWaitSeconds ?? 120;
    return Math.max(waitSec * 2000, 120000);
}

function isPendingOrderStale(record) {
    if (!record) return true;
    if (Number.isFinite(record.expiresAt) && Date.now() > record.expiresAt) return true;
    return (Date.now() - record.createdAt) > pendingOrderMaxAgeMs();
}

function findMatchingPendingOrder(direction, price, amount) {
    const record = pendingOrders[direction];
    if (!record) return null;

    const priceTolerance = Math.max(0.5, price * 0.0015);
    const amountTolerance = toleranceForAmount(amount);

    if (Math.abs(record.price - price) <= priceTolerance &&
        Math.abs(record.amount - amount) <= amountTolerance) {
        return record;
    }

    return null;
}

function prunePendingOrderByDirection(direction, ordersSnapshot) {
    const record = pendingOrders[direction];
    if (!record) return;

    const match = ordersSnapshot?.find(order => order.side === direction &&
        Math.abs(order.price - record.price) <= Math.max(0.5, record.price * 0.0015) &&
        Math.abs(order.totalQty - record.amount) <= toleranceForAmount(record.amount));

    if (!match) {
        pendingOrders[direction] = null;
    }
}

function reconcilePendingOrders() {
    const orders = getActiveOrders();
    prunePendingOrderByDirection('buy', orders);
    prunePendingOrderByDirection('sell', orders);
    lastOpenOrdersSnapshot = orders;
    return orders;
}

function hasOutstandingOrders() {
    if (pendingOrders.buy || pendingOrders.sell) return true;
    return Array.isArray(lastOpenOrdersSnapshot) && lastOpenOrdersSnapshot.length > 0;
}

function findCancelButton(row) {
    if (!row) return null;
    const buttons = Array.from(row.querySelectorAll('button'));
    return buttons.find(btn => btn.textContent && btn.textContent.includes('取消')) || null;
}

function cancelOrder(order, reason) {
    if (!order || !order.row) return false;
    const cancelBtn = findCancelButton(order.row);
    if (!cancelBtn) {
        log('❌ 找不到撤单按钮，无法取消委托');
        return false;
    }

    cancelBtn.click();
    log(`⚠️ ${reason}，已尝试撤销${order.side === 'buy' ? '买入' : '卖出'}委托 (${order.totalQty.toFixed(4)} @ ${order.price.toFixed(2)})`);
    pendingOrders[order.side] = null;
    return true;
}

function cancelStaleOrders() {
    const riskCfg = config.riskManagement;
    if (!riskCfg?.enabled) return;

    const timeoutSec = Number.isFinite(riskCfg.maxOrderWaitSeconds) ? riskCfg.maxOrderWaitSeconds : null;
    if (!timeoutSec || timeoutSec <= 0) return;

    const maxAge = timeoutSec * 1000;

    ['buy', 'sell'].forEach(direction => {
        const record = pendingOrders[direction];
        if (!record) return;

        const match = lastOpenOrdersSnapshot.find(order =>
            order.side === direction &&
            Math.abs(order.price - record.price) <= Math.max(0.5, record.price * 0.0015) &&
            Math.abs(order.totalQty - record.amount) <= toleranceForAmount(record.amount)
        );

        if (!match) return;

        const age = Date.now() - record.createdAt;
        if (age >= maxAge) {
            cancelOrder(match, `委托等待超过${timeoutSec}秒`);
        }
    });

    const now = Date.now();
    lastOpenOrdersSnapshot.forEach(order => {
        if (!order || !Number.isFinite(order.orderTime)) return;
        const age = now - order.orderTime;
        if (age >= maxAge) {
            cancelOrder(order, `委托超时 (${Math.round(age / 1000)}秒)`);
        }
    });
}

function updateSignalHistory(signal) {
    if (signal === 'buy' || signal === 'sell') {
        if (signalHistory.last === signal) {
            signalHistory.count += 1;
        } else {
            signalHistory.last = signal;
            signalHistory.count = 1;
        }
    } else {
        signalHistory.last = null;
        signalHistory.count = 0;
    }
    return signalHistory.count;
}

function resetSignalHistory() {
    signalHistory.last = null;
    signalHistory.count = 0;
}

function hasRequiredConfirmation(signal) {
    const required = config.riskManagement?.signalConfirmationCount || 1;
    if (required <= 1) return true;
    if (signal !== 'buy' && signal !== 'sell') return false;
    if (signalHistory.last !== signal) return false;
    return signalHistory.count >= required;
}

function clearTimers() {
    if (mainTimer) {
        clearTimeout(mainTimer);
        mainTimer = null;
    }
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    if (sessionTimer) {
        clearInterval(sessionTimer);
        sessionTimer = null;
    }
}

function saveStateForReload(autoRestart, reason) {
    updateDailyPnlState();
    const snapshot = {
        version: '7.0',
        timestamp: Date.now(),
        autoRestart: Boolean(autoRestart),
        tradeCount,
        totalVolume,
        pnlTracker: {
            realized: pnlTracker.realized,
            dailyRealized: pnlTracker.dailyRealized,
            dailyDate: pnlTracker.dailyDate,
            consecutiveLosses: pnlTracker.consecutiveLosses,
            lastTradePnL: pnlTracker.lastTradePnL
        },
        riskPauseUntil,
        reason
    };
    try {
        localStorage.setItem(RELOAD_STATE_KEY, JSON.stringify(snapshot));
    } catch (error) {
        console.warn('[EdgeX-AI] 保存重载状态失败:', error);
    }
}

function restoreStateIfNeeded() {
    let raw;
    try {
        raw = localStorage.getItem(RELOAD_STATE_KEY);
    } catch (error) {
        console.warn('[EdgeX-AI] 读取重载状态失败:', error);
        return;
    }
    if (!raw) return;

    let state = null;
    try {
        state = JSON.parse(raw);
    } catch (error) {
        console.warn('[EdgeX-AI] 重载状态解析失败:', error);
    }

    localStorage.removeItem(RELOAD_STATE_KEY);

    if (!state || !state.timestamp) return;
    const age = Date.now() - state.timestamp;
    if (age > 10 * 60 * 1000) return; // discard if older than 10 minutes

    tradeCount = Number.isFinite(state.tradeCount) ? state.tradeCount : tradeCount;
    totalVolume = Number.isFinite(state.totalVolume) ? state.totalVolume : totalVolume;
    if (state.pnlTracker) {
        pnlTracker.realized = Number.isFinite(state.pnlTracker.realized) ? state.pnlTracker.realized : pnlTracker.realized;
        pnlTracker.dailyRealized = Number.isFinite(state.pnlTracker.dailyRealized) ? state.pnlTracker.dailyRealized : pnlTracker.dailyRealized;
        pnlTracker.dailyDate = state.pnlTracker.dailyDate || pnlTracker.dailyDate;
        pnlTracker.consecutiveLosses = Number.isFinite(state.pnlTracker.consecutiveLosses) ? state.pnlTracker.consecutiveLosses : pnlTracker.consecutiveLosses;
        pnlTracker.lastTradePnL = Number.isFinite(state.pnlTracker.lastTradePnL) ? state.pnlTracker.lastTradePnL : pnlTracker.lastTradePnL;
    }
    riskPauseUntil = Number.isFinite(state.riskPauseUntil) ? state.riskPauseUntil : riskPauseUntil;
    updateStats();

    if (state.autoRestart) {
        log('🔄 检测到自动重载状态，准备恢复运行');
        setTimeout(() => startScript(), 4000);
    }
}

function triggerAutoRecovery(reason) {
    const cfg = config.dataHealth;
    if (!cfg?.enabled || healthMonitor.reloading) return;
    healthMonitor.reloading = true;
    healthMonitor.lastReason = reason;

    const wasRunning = isRunning;
    saveStateForReload(wasRunning, reason);
    stopScript({ silent: true });

    const delayMs = Math.max(1000, (cfg.reloadDelaySeconds ?? 5) * 1000);
    log(`🔁 数据异常(${reason})，${Math.round(delayMs / 1000)}秒后自动刷新`);
    setTimeout(() => {
        try {
            window.location.reload();
        } catch (error) {
            console.error('[EdgeX-AI] 自动刷新失败:', error);
        }
    }, delayMs);
}

function updatePriceHealth(currentPrice, externalPrice) {
    const cfg = config.dataHealth;
    if (!cfg?.enabled || healthMonitor.reloading) return;
    if (!Number.isFinite(currentPrice)) return;

    const now = Date.now();
    const epsilon = Math.abs(currentPrice) * 1e-5;
    if (healthMonitor.lastPrice === null || Math.abs(currentPrice - healthMonitor.lastPrice) > epsilon) {
        healthMonitor.lastPrice = currentPrice;
        healthMonitor.lastChangeTime = now;
        healthMonitor.stagnantCycles = 0;
    } else {
        healthMonitor.stagnantCycles += 1;
    }

    let reason = null;

    if (!reason && cfg.maxStagnantCycles && healthMonitor.stagnantCycles >= cfg.maxStagnantCycles) {
        reason = `价格连续${cfg.maxStagnantCycles}次未更新`;
    }

    if (!reason && cfg.maxStagnantMs && (now - healthMonitor.lastChangeTime) >= cfg.maxStagnantMs) {
        reason = `价格已 ${Math.round((now - healthMonitor.lastChangeTime) / 1000)} 秒无变化`;
    }

    if (!reason && cfg.externalDrift && Number.isFinite(externalPrice) && externalPrice > 0) {
        const drift = Math.abs(externalPrice - currentPrice) / currentPrice;
        if (drift >= cfg.externalDrift) {
            reason = `内外价格偏差 ${(drift * 100).toFixed(2)}%`;
        }
    }

    if (reason) {
        triggerAutoRecovery(reason);
    }
}

function syncPositionState(position, currentPrice) {
    if (!position || !position.hasPosition) {
        currentPositionState = null;
        return;
    }

    const normalizedSize = Number.isFinite(position.size) ? position.size : parseFloat(position.size);
    const size = Number.isFinite(normalizedSize) ? normalizedSize : null;

    if (!currentPositionState || currentPositionState.direction !== position.direction) {
        currentPositionState = {
            direction: position.direction,
            size: Number.isFinite(size) ? size : 0,
            entryPrice: Number.isFinite(currentPrice) ? currentPrice : null,
            openedAt: Date.now(),
            pendingRiskExit: false
        };
        return;
    }

    if (Number.isFinite(size)) {
        currentPositionState.size = size;
    }

    if (!Number.isFinite(currentPositionState.entryPrice) && Number.isFinite(currentPrice)) {
        currentPositionState.entryPrice = currentPrice;
    }
}

function calculateUnrealizedPnlPct(state, currentPrice) {
    if (!state || !Number.isFinite(state.entryPrice) || state.entryPrice <= 0 || !Number.isFinite(currentPrice)) {
        return null;
    }

    const change = (currentPrice - state.entryPrice) / state.entryPrice * 100;
    return state.direction === 'long' ? change : -change;
}

function updateDailyPnlState() {
    const today = new Date().toISOString().slice(0, 10);
    if (pnlTracker.dailyDate !== today) {
        pnlTracker.dailyDate = today;
        pnlTracker.dailyRealized = 0;
        pnlTracker.consecutiveLosses = 0;
    }
}

function applyRiskPauseIfNeeded() {
    const cfg = config.riskManagement;
    if (!cfg?.enabled) return;

    const pauseMinutes = cfg.pauseMinutesOnBreach ?? 60;
    if (pauseMinutes <= 0) return;

    riskPauseUntil = Date.now() + pauseMinutes * 60000;
    log(`⛔ 风险控制：暂停交易 ${pauseMinutes} 分钟`);
}

function evaluateGlobalRisk() {
    const cfg = config.riskManagement;
    if (!cfg?.enabled) return;

    updateDailyPnlState();

    let breached = false;

    if (Number.isFinite(cfg.dailyLossLimit) && pnlTracker.dailyRealized <= cfg.dailyLossLimit) {
        breached = true;
        log(`⛔ 达到当日亏损上限 (${pnlTracker.dailyRealized.toFixed(2)} <= ${cfg.dailyLossLimit})`);
    }

    if (Number.isFinite(cfg.maxConsecutiveLosses) && cfg.maxConsecutiveLosses > 0 &&
        pnlTracker.consecutiveLosses >= cfg.maxConsecutiveLosses) {
        breached = true;
        log(`⛔ 连续亏损次数达到上限 (${pnlTracker.consecutiveLosses})`);
    }

    if (breached) {
        applyRiskPauseIfNeeded();
    }
}

function canTrade() {
    if (Date.now() < riskPauseUntil) return false;
    return true;
}

async function evaluateRiskExit(position, currentPrice, offset = config.priceOffset) {
    const riskCfg = config.riskManagement;
    if (!riskCfg?.enabled || !currentPositionState) {
        return false;
    }

    const closeDirection = position.direction === 'long' ? 'sell' : 'buy';

    if (currentPositionState.pendingRiskExit) {
        const stillPending = findMatchingActiveOrder(closeDirection, currentPrice, currentPositionState.size);
        if (stillPending) {
            return false;
        }
        currentPositionState.pendingRiskExit = false;
    }

    const pnlPct = calculateUnrealizedPnlPct(currentPositionState, currentPrice);
    const elapsedMinutes = (Date.now() - currentPositionState.openedAt) / 60000;

    const stopLoss = Number.isFinite(riskCfg.stopLossPct) ? Math.abs(riskCfg.stopLossPct) : null;
    const takeProfit = Number.isFinite(riskCfg.takeProfitPct) ? Math.abs(riskCfg.takeProfitPct) : null;
    const maxDuration = Number.isFinite(riskCfg.maxHoldMinutes) ? Math.abs(riskCfg.maxHoldMinutes) : null;

    let reason = null;

    if (stopLoss !== null && pnlPct !== null && pnlPct <= -stopLoss) {
        reason = `达到止损 ${pnlPct.toFixed(2)}%`;
    } else if (takeProfit !== null && pnlPct !== null && pnlPct >= takeProfit) {
        reason = `达到止盈 ${pnlPct.toFixed(2)}%`;
    } else if (maxDuration !== null && elapsedMinutes >= maxDuration) {
        reason = `持仓已超过 ${maxDuration} 分钟`;
    }

    if (!reason) return false;

    const existingCloseOrder = findMatchingActiveOrder(closeDirection, currentPrice, currentPositionState.size);
    if (existingCloseOrder) {
        currentPositionState.pendingRiskExit = true;
        return false;
    }

    log(`⚠️ 风险控制触发平仓: ${reason}`);

    const closePrice = position.direction === 'long'
        ? currentPrice * (1 - offset)
        : currentPrice * (1 + offset);

    const success = await executeLimitClose(position, closePrice);
    if (success) {
        currentPositionState.pendingRiskExit = true;
    }
    return success;
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
                <div>盈亏: $<span id="realized-pnl" style="color:#FFEB3B;">0.00</span></div>
                <div>当日盈亏: $<span id="daily-pnl" style="color:#FFEB3B;">0.00</span></div>
                <div>连亏: <span id="loss-streak" style="color:#F44336;">0</span></div>
                <div>时间: <span id="run-time" style="color:#2196F3;">00:00:00</span></div>
                <div>进度: <span id="data-progress" style="color:#FF9800;">0/8</span></div>
                <div>持仓: <span id="position-info" style="color:#FFD700;">无</span></div>
                <div>风险状态: <span id="risk-status" style="color:#FF5722;">正常</span></div>
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
        pnl: document.getElementById('realized-pnl'),
        dailyPnl: document.getElementById('daily-pnl'),
        lossStreak: document.getElementById('loss-streak'),
        riskStatus: document.getElementById('risk-status'),
        progress: document.getElementById('data-progress'),
        runTime: document.getElementById('run-time'),
        position: document.getElementById('position-info')
    };

    if (elements.count) elements.count.textContent = tradeCount;
    if (elements.volume) elements.volume.textContent = totalVolume.toFixed(2);
    if (elements.pnl) elements.pnl.textContent = pnlTracker.realized.toFixed(2);
    if (elements.dailyPnl) elements.dailyPnl.textContent = pnlTracker.dailyRealized.toFixed(2);
    if (elements.lossStreak) elements.lossStreak.textContent = pnlTracker.consecutiveLosses;
    if (elements.riskStatus) {
        if (Date.now() < riskPauseUntil) {
            const remaining = Math.max(0, Math.ceil((riskPauseUntil - Date.now()) / 60000));
            elements.riskStatus.textContent = `暂停中(${remaining}分)`;
        } else {
            elements.riskStatus.textContent = '正常';
        }
    }
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

function computeDynamicOffset(currentPrice, indicators) {
    const cfg = config.dynamicOffset;
    if (!cfg?.enabled || !indicators) {
        return config.priceOffset;
    }

    const volPct = Number.isFinite(indicators.volatility) ? indicators.volatility : null;
    if (!Number.isFinite(volPct) || volPct <= 0) {
        return cfg.fallbackOffset ?? config.priceOffset;
    }

    const normalizedVol = volPct / 100; // convert to decimal fraction
    const rawOffset = normalizedVol * (cfg.volatilityFactor ?? 0.8);
    const minOffset = cfg.minOffset ?? 0.0002;
    const maxOffset = cfg.maxOffset ?? 0.002;
    const safeOffset = Math.min(Math.max(rawOffset, minOffset), maxOffset);
    return Number.isFinite(safeOffset) && safeOffset > 0 ? safeOffset : (cfg.fallbackOffset ?? config.priceOffset);
}

function getAIDecision(currentPrice) {
    return new Promise((resolve) => {
        if (!config.enableAI || priceHistory.length < config.priceHistoryLength) {
            resolve('hold');
            return;
        }

        const indicators = calculateTechnicalIndicators();
        const position = getCurrentPosition();

        getExternalMarketSnapshot(currentPrice).then(externalMarket => {
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
        if (!canTrade()) {
            log('⛔ 处于风险暂停状态，跳过开仓');
            return false;
        }

        const record = pendingOrders[direction];
        if (record) {
            if (!isPendingOrderStale(record)) {
                log(`⚠️ ${direction === 'buy' ? '买入' : '卖出'}委托仍在等待 (本地记录)，跳过重复下单`);
                return false;
            }

            const orders = getActiveOrders();
            const match = orders.find(order =>
                order.side === direction &&
                Math.abs(order.price - record.price) <= Math.max(0.5, record.price * 0.0015) &&
                Math.abs(order.totalQty - record.amount) <= toleranceForAmount(record.amount)
            );

            if (match) {
                cancelOrder(match, '委托超时，自动撤销后再下单');
                return false;
            }

            pendingOrders[direction] = null;
        }

        const numericAmount = parseFloat(amount);
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
                const parsedAmount = parseFloat(amount);
                if (Number.isFinite(parsedAmount)) {
                    currentPositionState = {
                        direction,
                        size: parsedAmount,
                        entryPrice: price,
                        openedAt: Date.now(),
                        pendingRiskExit: false
                    };
                    pendingOrders[direction] = {
                        price,
                        amount: parsedAmount,
                        createdAt: Date.now(),
                        expiresAt: config.riskManagement?.maxOrderWaitSeconds ? Date.now() + (config.riskManagement.maxOrderWaitSeconds * 1000) : null
                    };
                }
                resetSignalHistory();
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
        const closeDirection = position.direction === 'long' ? 'sell' : 'buy';
        const closeAmount = parseFloat(position.size);
        const existingCloseOrder = findMatchingActiveOrder(closeDirection, price, closeAmount);

        if (existingCloseOrder) {
            log(`⚠️ 已存在待平仓委托 (${existingCloseOrder.totalQty.toFixed(4)} @ ${existingCloseOrder.price.toFixed(2)})，跳过重复平仓`);
            return false;
        }

        const closeLimitBtn = position.row.querySelector(SELECTORS.closeLimitBtn);
        if (closeLimitBtn) {
            closeLimitBtn.click();
            log('已点击限价平仓按钮');
            if (currentPositionState) {
                currentPositionState.pendingRiskExit = true;
            }

            setTimeout(() => {
                const closeConfirmBtn = document.querySelector(SELECTORS.closeConfirmBtn);
                if (closeConfirmBtn) {
                    closeConfirmBtn.click();
                    tradeCount += 1;
                    totalVolume += position.size * price;
                    const pnl = position.direction === 'long'
                        ? (price - (currentPositionState?.entryPrice ?? price)) * position.size
                        : ((currentPositionState?.entryPrice ?? price) - price) * position.size;
                    updateDailyPnlState();
                    pnlTracker.realized += pnl;
                    pnlTracker.dailyRealized += pnl;
                    pnlTracker.lastTradePnL = pnl;
                    pnlTracker.consecutiveLosses = pnl < 0 ? pnlTracker.consecutiveLosses + 1 : 0;
                    evaluateGlobalRisk();
                    log(`🎉 限价平仓成功 #${tradeCount}`);
                    const closeDir = position.direction === 'long' ? 'sell' : 'buy';
                    pendingOrders[closeDir] = null;
                    currentPositionState = null;
                } else {
                    log('❌ 找不到平仓确认按钮');
                    if (currentPositionState) {
                        currentPositionState.pendingRiskExit = false;
                    }
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

async function executeSmartTrade(aiSignal, currentPrice, offset = config.priceOffset) {
    const position = getCurrentPosition();

    const openLongPrice = currentPrice * (1 - offset);
    const openShortPrice = currentPrice * (1 + offset);
    const closeLongPrice = currentPrice * (1 - offset);
    const closeShortPrice = currentPrice * (1 + offset);

    if (position && position.hasPosition) {
        if ((position.direction === 'long' && aiSignal === 'sell') ||
            (position.direction === 'short' && aiSignal === 'buy')) {
            const closePrice = position.direction === 'long' ? closeLongPrice : closeShortPrice;
            log(`持有${position.direction}仓位，AI建议${aiSignal}，执行平仓`);
            return await executeLimitClose(position, closePrice);
        } else {
            log(`持有${position.direction}仓位，AI建议${aiSignal}，暂不操作`);
            return false;
        }
    } else {
        if (hasOutstandingOrders()) {
            log('⚠️ 存在未完成的挂单，等待处理后再开新仓');
            return false;
        }
        if (!hasRequiredConfirmation(aiSignal)) {
            const required = config.riskManagement?.signalConfirmationCount || 1;
            log(`⚠️ ${aiSignal.toUpperCase()} 信号尚未达到确认次数 (${signalHistory.count}/${required})`);
            return false;
        }
        if (aiSignal === 'buy') {
            return await executeLimitOrder('buy', openLongPrice, config.quantity);
        } else if (aiSignal === 'sell') {
            return await executeLimitOrder('sell', openShortPrice, config.quantity);
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
    const position = getCurrentPosition();

    if (!price) {
        log('未能获取行情，30秒后重试');
        mainTimer = setTimeout(mainTradingLoop, 30000);
        return;
    }

    evaluateGlobalRisk();

    syncPositionState(position, price);
    reconcilePendingOrders();
    cancelStaleOrders();

    const indicators = calculateTechnicalIndicators();
    const externalPrice = Number.isFinite(lastExternalSnapshot?.ticker?.lastPrice) ? lastExternalSnapshot.ticker.lastPrice : null;
    updatePriceHealth(price, externalPrice);
    const currentOffset = computeDynamicOffset(price, indicators);

    if (position && position.hasPosition) {
        const riskHandled = await evaluateRiskExit(position, price, currentOffset);
        if (riskHandled) {
            const waitMs = Math.max(config.confirmWaitMs || 1000, 4000);
            log('⏳ 风险控制已提交平仓，等待执行后继续');
            mainTimer = setTimeout(mainTradingLoop, waitMs);
            return;
        }
    }

    if (isCollecting) {
        log(`数据采集中...${priceHistory.length}/${config.priceHistoryLength}`);
    } else {
        const aiDecision = await getAIDecision(price);
        updateSignalHistory(aiDecision);

        if (aiDecision !== 'hold') {
            await executeSmartTrade(aiDecision, price, currentOffset);
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
    resetSignalHistory();
    updateDailyPnlState();
    log('🚀 EdgeX AI量化交易机器人已启动');

    setupKeepAlive();
    setupSessionCheck();
    mainTimer = setTimeout(mainTradingLoop, 3000);
}

function stopScript(options = {}) {
    const { silent = false } = options;

    if (!silent) {
        log('⏹️ 脚本已停止');
    }

    isRunning = false;
    clearTimers();

    if (!silent) {
        log(`运行总结: 交易${tradeCount}次, 总量$${totalVolume.toFixed(2)}`);
    }

    pendingOrders.buy = null;
    pendingOrders.sell = null;
    lastOpenOrdersSnapshot = [];
    currentPositionState = null;
    resetSignalHistory();
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

            const indicators = calculateTechnicalIndicators();
            const offset = computeDynamicOffset(basePrice, indicators);
            const tradePrice = direction === 'buy'
                ? basePrice * (1 - offset)
                : basePrice * (1 + offset);

            return executeLimitOrder(direction, tradePrice, manualAmount ?? config.quantity);
        },
        stats: () => console.log(`运行状态: ${isRunning}, 交易: ${tradeCount}次, 总量: $${totalVolume.toFixed(2)}`)
    };

    window.edgexBot = api;
    if (typeof unsafeWindow !== 'undefined') {
        unsafeWindow.edgexBot = api;
    }

    restoreStateIfNeeded();

    console.log('[EdgeX-AI] 脚本已初始化完成');
})();
