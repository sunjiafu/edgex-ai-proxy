function createTradingState(config) {
    const state = {
        tradeCount: 0,
        totalVolume: 0,
        riskPauseUntil: 0,
        priceHistoryReady: false,
        pendingOrders: {
            buy: null,
            sell: null
        },
        lastOrdersSnapshot: [],
        signalHistory: {
            last: null,
            count: 0
        },
        pnl: {
            realized: 0,
            dailyRealized: 0,
            dailyDate: null,
            consecutiveLosses: 0,
            lastTradePnL: null
        },
        currentPositionState: null
    };

    const riskCfg = config.riskManagement || {};

    function updateDailyPnlState() {
        const today = new Date().toISOString().slice(0, 10);
        if (state.pnl.dailyDate !== today) {
            state.pnl.dailyDate = today;
            state.pnl.dailyRealized = 0;
            state.pnl.consecutiveLosses = 0;
        }
    }

    function resetSignalHistory() {
        state.signalHistory.last = null;
        state.signalHistory.count = 0;
    }

    function updateSignalHistory(signal) {
        if (signal === 'buy' || signal === 'sell') {
            if (state.signalHistory.last === signal) {
                state.signalHistory.count += 1;
            } else {
                state.signalHistory.last = signal;
                state.signalHistory.count = 1;
            }
        } else {
            resetSignalHistory();
        }
        return state.signalHistory.count;
    }

    function hasRequiredConfirmation(signal) {
        const required = riskCfg.signalConfirmationCount || 1;
        if (required <= 1) return true;
        if (signal !== 'buy' && signal !== 'sell') return false;
        if (state.signalHistory.last !== signal) return false;
        return state.signalHistory.count >= required;
    }

    function syncPositionState(position, currentPrice) {
        if (!position || !position.direction) {
            state.currentPositionState = null;
            return;
        }

        const normalizedSize = Number.isFinite(position.size)
            ? position.size
            : parseFloat(position.size);
        const size = Number.isFinite(normalizedSize) ? normalizedSize : null;

        if (!state.currentPositionState ||
            state.currentPositionState.direction !== position.direction) {
            state.currentPositionState = {
                direction: position.direction,
                size: Number.isFinite(size) ? size : 0,
                entryPrice: Number.isFinite(currentPrice) ? currentPrice : null,
                openedAt: Date.now(),
                pendingRiskExit: false
            };
            return;
        }

        if (Number.isFinite(size)) {
            state.currentPositionState.size = size;
        }

        if (!Number.isFinite(state.currentPositionState.entryPrice) &&
            Number.isFinite(currentPrice)) {
            state.currentPositionState.entryPrice = currentPrice;
        }
    }

    function toleranceForAmount(amount) {
        if (!Number.isFinite(amount) || amount <= 0) return 0.0001;
        return Math.max(0.0001, amount * 0.05);
    }

    function recordPendingOrder(direction, price, amount) {
        if (!direction) return;
        const expiresAt = Number.isFinite(riskCfg.maxOrderWaitSeconds)
            ? Date.now() + (riskCfg.maxOrderWaitSeconds * 1000)
            : null;
        state.pendingOrders[direction] = {
            price,
            amount,
            createdAt: Date.now(),
            expiresAt
        };
    }

    function recordTradeSubmission({ side, price, size, type }) {
        const numericSize = Number.isFinite(size) ? size : parseFloat(size);
        const qty = Number.isFinite(numericSize) ? numericSize : 0;
        state.tradeCount += 1;
        state.totalVolume += qty * price;

        if (type === 'open') {
            const direction = side === 'buy' ? 'long' : 'short';
            state.currentPositionState = {
                direction,
                size: qty,
                entryPrice: price,
                openedAt: Date.now(),
                pendingRiskExit: false
            };
            recordPendingOrder(side, price, qty);
            resetSignalHistory();
        } else if (type === 'close') {
            const active = state.currentPositionState;
            const direction = active?.direction ?? (side === 'buy' ? 'short' : 'long');
            const effectiveQty = qty > 0 ? qty : (active?.size ?? 0);
            const entryPrice = Number.isFinite(active?.entryPrice) ? active.entryPrice : price;
            const pnl = direction === 'long'
                ? (price - entryPrice) * effectiveQty
                : (entryPrice - price) * effectiveQty;
            updateDailyPnlState();
            state.pnl.realized += pnl;
            state.pnl.dailyRealized += pnl;
            state.pnl.lastTradePnL = pnl;
            state.pnl.consecutiveLosses = pnl < 0
                ? state.pnl.consecutiveLosses + 1
                : 0;
            const closeDir = direction === 'long' ? 'sell' : 'buy';
            state.pendingOrders[closeDir] = null;
            state.currentPositionState = null;
        }
    }

    function canTrade() {
        if (!riskCfg.enabled) return true;
        return Date.now() >= state.riskPauseUntil;
    }

    function applyRiskPause() {
        if (!riskCfg.enabled) return;
        const pauseMinutes = riskCfg.pauseMinutesOnBreach ?? 60;
        if (pauseMinutes <= 0) return;
        state.riskPauseUntil = Date.now() + pauseMinutes * 60000;
    }

    function evaluateGlobalRisk() {
        if (!riskCfg.enabled) return { paused: false };

        updateDailyPnlState();

        let reason = null;

        if (Number.isFinite(riskCfg.dailyLossLimit) &&
            state.pnl.dailyRealized <= riskCfg.dailyLossLimit) {
            reason = `达到当日亏损上限 (${state.pnl.dailyRealized.toFixed(2)} <= ${riskCfg.dailyLossLimit})`;
        }

        if (!reason &&
            Number.isFinite(riskCfg.maxConsecutiveLosses) &&
            riskCfg.maxConsecutiveLosses > 0 &&
            state.pnl.consecutiveLosses >= riskCfg.maxConsecutiveLosses) {
            reason = `连续亏损次数达到上限 (${state.pnl.consecutiveLosses})`;
        }

        if (reason) {
            applyRiskPause();
            return { paused: true, reason };
        }

        return { paused: false };
    }

    function calculateUnrealizedPnlPct(currentPrice) {
        const pos = state.currentPositionState;
        if (!pos || !Number.isFinite(pos.entryPrice) || pos.entryPrice <= 0 ||
            !Number.isFinite(currentPrice)) {
            return null;
        }
        const change = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
        return pos.direction === 'long' ? change : -change;
    }

    function evaluateRiskExit(currentPrice) {
        if (!riskCfg.enabled) return null;
        const pos = state.currentPositionState;
        if (!pos) return null;

        const closeSide = pos.direction === 'long' ? 'sell' : 'buy';
        const record = state.pendingOrders[closeSide];
        if (pos.pendingRiskExit && record) {
            // 风险退出委托仍在处理中
            return null;
        }

        const pnlPct = calculateUnrealizedPnlPct(currentPrice);
        const elapsedMinutes = (Date.now() - pos.openedAt) / 60000;

        const stopLoss = Number.isFinite(riskCfg.stopLossPct) ? Math.abs(riskCfg.stopLossPct) : null;
        const takeProfit = Number.isFinite(riskCfg.takeProfitPct) ? Math.abs(riskCfg.takeProfitPct) : null;
        const maxDuration = Number.isFinite(riskCfg.maxHoldMinutes) ? Math.abs(riskCfg.maxHoldMinutes) : null;

        let reason = null;

        if (stopLoss !== null && pnlPct !== null && pnlPct <= -stopLoss) {
            reason = `达到止损 ${pnlPct.toFixed(2)}%`;
        } else if (takeProfit !== null && pnlPct !== null && pnlPct >= takeProfit) {
            reason = `达到止盈 ${pnlPct.toFixed(2)}%`;
        } else if (maxDuration !== null && elapsedMinutes >= maxDuration) {
            reason = `持仓时间超过 ${maxDuration} 分钟`;
        }

        if (!reason) return null;

        pos.pendingRiskExit = true;
        return {
            side: closeSide,
            reason,
            size: pos.size,
            direction: pos.direction
        };
    }

    function hasOutstandingOrders() {
        if (state.pendingOrders.buy || state.pendingOrders.sell) return true;
        return Array.isArray(state.lastOrdersSnapshot) && state.lastOrdersSnapshot.length > 0;
    }

    function prunePendingOrderByDirection(direction, orders) {
        const record = state.pendingOrders[direction];
        if (!record) return;

        const match = orders?.find(order =>
            order.side === direction &&
            Math.abs(order.price - record.price) <= Math.max(0.5, record.price * 0.0015) &&
            Math.abs(order.totalQty - record.amount) <= toleranceForAmount(record.amount)
        );

        if (!match) {
            state.pendingOrders[direction] = null;
        }
    }

    function updateOrdersSnapshot(orders) {
        state.lastOrdersSnapshot = orders;
        prunePendingOrderByDirection('buy', orders);
        prunePendingOrderByDirection('sell', orders);
    }

    function clearPendingOrder(direction) {
        if (!direction) return;
        state.pendingOrders[direction] = null;
    }

    function findMatchingOrder(direction, price, amount) {
        if (!Array.isArray(state.lastOrdersSnapshot)) return null;
        const targetAmount = Number.isFinite(amount) ? amount : parseFloat(amount);
        const hasTargetAmount = Number.isFinite(targetAmount);
        return state.lastOrdersSnapshot.find(order => {
            if (order.side !== direction) return false;
            const priceTol = Math.max(0.5, price * 0.0015);
            if (Math.abs(order.price - price) > priceTol) return false;
            if (hasTargetAmount) {
                if (Math.abs(order.totalQty - targetAmount) > toleranceForAmount(targetAmount)) return false;
            }
            return order.filledQty < order.totalQty;
        }) || null;
    }

    function findStaleOrders() {
        if (!riskCfg.enabled || !Number.isFinite(riskCfg.maxOrderWaitSeconds)) {
            return [];
        }
        const maxAge = riskCfg.maxOrderWaitSeconds * 1000;
        const now = Date.now();
        const stale = [];

        ['buy', 'sell'].forEach(direction => {
            const record = state.pendingOrders[direction];
            if (!record) return;
            const match = findMatchingOrder(direction, record.price, record.amount);
            if (!match) {
                state.pendingOrders[direction] = null;
                return;
            }
            const age = now - (record.createdAt ?? now);
            if (age >= maxAge) {
                stale.push(match);
            }
        });

        state.lastOrdersSnapshot.forEach(order => {
            if (!order || !Number.isFinite(order.orderTime)) return;
            const age = now - order.orderTime;
            if (age >= maxAge) {
                stale.push(order);
            }
        });

        const seen = new Set();
        return stale.filter(order => {
            const key = order.orderId || `${order.side}-${order.price}-${order.index}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function getStats() {
        return {
            tradeCount: state.tradeCount,
            totalVolume: state.totalVolume,
            pnl: state.pnl,
            riskPauseUntil: state.riskPauseUntil,
            currentPosition: state.currentPositionState,
            pendingOrders: state.pendingOrders,
            signalHistory: state.signalHistory
        };
    }

    return {
        state,
        updateSignalHistory,
        resetSignalHistory,
        hasRequiredConfirmation,
        syncPositionState,
        recordTradeSubmission,
        canTrade,
        evaluateGlobalRisk,
        evaluateRiskExit,
        hasOutstandingOrders,
        updateOrdersSnapshot,
        findStaleOrders,
        recordPendingOrder,
        findMatchingOrder,
        clearPendingOrder,
        getStats
    };
}

module.exports = {
    createTradingState
};
