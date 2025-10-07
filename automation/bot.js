/* eslint-disable no-constant-condition */
const config = require('./config');
const { createContext } = require('./session');
const {
    ensureActiveOrderTab,
    readCurrentPrice,
    readPosition,
    readActiveOrders,
    placeLimitOrder,
    cancelOrder
} = require('./pageActions');
const { getDecision } = require('./aiClient');
const indicators = require('./indicators');
const { createTradingState } = require('./state');

let priceHistory = [];
let historyReady = false;
const tradingState = createTradingState(config);

function computeTradePrice(side, price, offset) {
    if (side === 'buy') {
        return price * (1 - offset);
    }
    if (side === 'sell') {
        return price * (1 + offset);
    }
    return price;
}

function clampIntervalMinutes() {
    const min = Math.max(config.minIntervalMin, 0);
    const max = Math.max(config.maxIntervalMin, min);
    return { min, max };
}

function pickNextDelaySeconds(isCollecting) {
    if (isCollecting) {
        return Math.max(config.collectIntervalSec, 1);
    }
    const { min, max } = clampIntervalMinutes();
    const minSec = min * 60;
    const maxSec = max * 60;
    if (maxSec <= minSec) {
        return Math.max(minSec, 1);
    }
    const delta = maxSec - minSec;
    return Math.floor(Math.random() * delta) + minSec;
}

function formatDelay(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
        return `${mins}分${secs.toString().padStart(2, '0')}秒`;
    }
    return `${secs}秒`;
}

function formatMetric(value, digits = 2) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 'NA';
    return num.toFixed(digits);
}

function logIndicatorSummary(indicators) {
    const summary = [
        `RSI14=${formatMetric(indicators.rsi14)}`,
        `MACD=${formatMetric(indicators.macd)}`,
        `Signal=${formatMetric(indicators.macdSignal)}`,
        `Hist=${formatMetric(indicators.macdHistogram)}`,
        `ROC5=${formatMetric(indicators.roc5)}`,
        `Vol=${formatMetric(indicators.volatility)}%`
    ].join(' | ');
    console.log(`[bot] 指标速览: ${summary}`);
}

async function loop(page) {
    await ensureActiveOrderTab(page);
    const price = await readCurrentPrice(page);
    if (!Number.isFinite(price)) {
        console.warn('[bot] 未获取到最新价格，10秒后重试');
        await page.waitForTimeout(10_000);
        return;
    }

    priceHistory = indicators.appendPrice(priceHistory, price, config.priceHistoryLength);
    const isCollecting = priceHistory.length < config.priceHistoryLength;
    if (isCollecting) {
        console.log(`[bot] 正在采集历史数据 ${priceHistory.length}/${config.priceHistoryLength}`);
    } else if (!historyReady) {
        historyReady = true;
        console.log('[bot] 历史数据已满，进入交易阶段');
    }
    const stats = indicators.calculate(priceHistory);
    const position = await readPosition(page);
    const currentOrders = await readActiveOrders(page);
    const stateSnapshot = tradingState.getStats();
    tradingState.syncPositionState(position, price);
    tradingState.updateOrdersSnapshot(currentOrders);

    if (isCollecting) {
        const delaySec = pickNextDelaySeconds(true);
        console.log(`[bot] 采集阶段，下一轮 ${formatDelay(delaySec)} 后执行`);
        await page.waitForTimeout(delaySec * 1000);
        return;
    }

    const riskStatus = tradingState.evaluateGlobalRisk();
    if (riskStatus.paused) {
        console.warn(`[bot] 风控触发：${riskStatus.reason}`);
    }

    if (!tradingState.canTrade()) {
        const delaySec = pickNextDelaySeconds(false);
        console.log(`[bot] 风险暂停中，下一轮 ${formatDelay(delaySec)} 后检查`);
        await page.waitForTimeout(delaySec * 1000);
        return;
    }

    const staleOrders = tradingState.findStaleOrders();
    for (const order of staleOrders) {
        if (await cancelOrder(page, order.index)) {
            tradingState.clearPendingOrder(order.side);
            console.warn(`[bot] 撤销超时委托 ${order.side} @ ${order.price.toFixed(2)}`);
        }
    }

    const payload = {
        symbol: config.ticker,
        currentPrice: price,
        priceHistory,
        indicators: stats,
        position: position ? { hasPosition: true, ...position } : { hasPosition: false },
        tradingStats: {
            totalTrades: stateSnapshot.tradeCount,
            totalVolume: Number(stateSnapshot.totalVolume?.toFixed?.(2) ?? stateSnapshot.totalVolume ?? 0),
            realizedPnl: Number(stateSnapshot.pnl?.realized?.toFixed?.(2) ?? stateSnapshot.pnl?.realized ?? 0),
            dailyRealized: Number(stateSnapshot.pnl?.dailyRealized?.toFixed?.(2) ?? stateSnapshot.pnl?.dailyRealized ?? 0),
            consecutiveLosses: stateSnapshot.pnl?.consecutiveLosses ?? 0,
            riskPauseUntil: stateSnapshot.riskPauseUntil ?? 0
        },
        timestamp: Date.now()
    };

    const decision = await getDecision(payload);
    tradingState.updateSignalHistory(decision);
    logIndicatorSummary(stats);

    const offset = config.priceOffset;
    const nextDelaySec = pickNextDelaySeconds(false);
    const delayText = formatDelay(nextDelaySec);
    const riskExit = tradingState.evaluateRiskExit(price);

    if (riskExit) {
        const targetPrice = computeTradePrice(riskExit.side, price, offset);
        console.log(`[bot] 风险退出触发(${riskExit.reason}) -> 限价${riskExit.side} @ ${targetPrice.toFixed(2)}`);
        const success = await placeLimitOrder(page, {
            side: riskExit.side,
            price: targetPrice,
            size: riskExit.size
        });
        if (success) {
            tradingState.recordTradeSubmission({
                side: riskExit.side,
                price: targetPrice,
                size: riskExit.size,
                type: 'close'
            });
            console.log(`[bot] 风险退出委托已提交，下一轮 ${delayText} 后复查`);
        } else {
            console.warn('[bot] 风险退出委托提交失败，将在下一轮重试');
        }
        await page.waitForTimeout(nextDelaySec * 1000);
        return;
    }

    if (position && position.direction) {
        if ((position.direction === 'long' && decision === 'sell') ||
            (position.direction === 'short' && decision === 'buy')) {
            const closeSide = position.direction === 'long' ? 'sell' : 'buy';
            const targetPrice = computeTradePrice(closeSide, price, offset);
            console.log(`[bot] 平仓 ${position.direction} -> ${closeSide} @ ${targetPrice.toFixed(2)}`);
            const success = await placeLimitOrder(page, {
                side: closeSide,
                price: targetPrice,
                size: position.size
            });
            if (success) {
                tradingState.recordTradeSubmission({
                    side: closeSide,
                    price: targetPrice,
                    size: position.size,
                    type: 'close'
                });
                console.log(`[bot] 平仓委托已提交，下一轮 ${delayText} 后跟进`);
            }
        } else {
            console.log(`[bot] 有持仓 ${position.direction}，AI 给出 ${decision}，下一轮 ${delayText} 后再评估`);
        }
    } else {
        if (currentOrders.length > 0 || tradingState.hasOutstandingOrders()) {
            console.log(`[bot] 存在 ${currentOrders.length} 个挂单，下一轮 ${delayText} 后复查`);
        } else if (decision === 'buy' || decision === 'sell') {
            if (!tradingState.hasRequiredConfirmation(decision)) {
                const required = config.riskManagement?.signalConfirmationCount || 1;
                const history = tradingState.state.signalHistory.count;
                console.log(`[bot] ${decision.toUpperCase()} 信号尚未达到确认次数 (${history}/${required})，下一轮 ${delayText} 后再确认`);
                await page.waitForTimeout(nextDelaySec * 1000);
                return;
            }
            const targetPrice = computeTradePrice(decision, price, offset);
            console.log(`[bot] 下限价单 ${decision} @ ${targetPrice.toFixed(2)} 数量 ${config.quantity}`);
            const success = await placeLimitOrder(page, {
                side: decision,
                price: targetPrice,
                size: config.quantity
            });
            if (success) {
                tradingState.recordTradeSubmission({
                    side: decision,
                    price: targetPrice,
                    size: config.quantity,
                    type: 'open'
                });
                console.log(`[bot] 限价单已提交，下一轮 ${delayText} 后跟进`);
            }
        } else {
            console.log(`[bot] AI 建议观望，下一轮 ${delayText} 后执行`);
        }
    }

    await page.waitForTimeout(nextDelaySec * 1000);
}

async function main() {
    const session = await createContext();
    const { page } = session;

    try {
        await page.goto(config.edgexUrl, { waitUntil: 'domcontentloaded' });
        console.log('[bot] 页面已打开，开始执行策略循环');

        while (true) {
            await loop(page);
        }
    } catch (error) {
        console.error('[bot] 执行异常:', error);
    } finally {
        if (session.close) {
            await session.close();
        }
    }
}

process.once('SIGINT', () => {
    console.log('\n[bot] 收到 SIGINT，准备退出');
    process.exit(0);
});
process.once('SIGTERM', () => {
    console.log('\n[bot] 收到 SIGTERM，准备退出');
    process.exit(0);
});

main().catch(error => {
    console.error('[bot] 启动失败:', error);
    process.exit(1);
});
