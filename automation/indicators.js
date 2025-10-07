function appendPrice(history, price, maxLength) {
    const next = history.slice();
    next.push(price);
    if (next.length > maxLength) {
        next.shift();
    }
    return next;
}

function simpleMovingAverage(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    const sum = slice.reduce((acc, value) => acc + value, 0);
    return sum / period;
}

function exponentialMovingAverage(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((acc, value) => acc + value, 0) / period;
    for (let i = period; i < values.length; i += 1) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(values, period = 14) {
    if (values.length <= period) return null;
    let gains = 0;
    let losses = 0;
    for (let i = values.length - period; i < values.length; i += 1) {
        const change = values[i] - values[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateStandardDeviation(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    const mean = slice.reduce((acc, value) => acc + value, 0) / period;
    const variance = slice.reduce((acc, value) => acc + (value - mean) ** 2, 0) / period;
    return Math.sqrt(variance);
}

function calculate(history) {
    const length = history.length;

    const ma5 = simpleMovingAverage(history, 5);
    const ma8 = simpleMovingAverage(history, 8);
    const ma20 = simpleMovingAverage(history, 20);
    const ema12 = exponentialMovingAverage(history, 12);
    const ema26 = exponentialMovingAverage(history, 26);

    let volatility = 0;
    if (length >= 3) {
        const returns = [];
        for (let i = 1; i < length; i += 1) {
            const prev = history[i - 1];
            if (prev > 0) {
                returns.push((history[i] - prev) / prev);
            }
        }
        if (returns.length > 0) {
            const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
            const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
            volatility = Math.sqrt(variance) * 100;
        }
    }

    let trend = 'neutral';
    if (length >= 5) {
        const change = (history[length - 1] - history[length - 5]) / history[length - 5];
        if (change > 0.001) trend = 'bullish';
        else if (change < -0.001) trend = 'bearish';
    }

    let macd = null;
    let macdSignal = null;
    let macdHistogram = null;
    if (ema12 !== null && ema26 !== null) {
        macd = ema12 - ema26;
        const macdHistory = [];
        if (history.length >= 26) {
            // build MACD series for signal calculation
            let prevEma12 = history.slice(0, 12).reduce((acc, value) => acc + value, 0) / 12;
            let prevEma26 = history.slice(0, 26).reduce((acc, value) => acc + value, 0) / 26;
            const k12 = 2 / (12 + 1);
            const k26 = 2 / (26 + 1);
            for (let i = 26; i < history.length; i += 1) {
                prevEma12 = history[i] * k12 + prevEma12 * (1 - k12);
                prevEma26 = history[i] * k26 + prevEma26 * (1 - k26);
                macdHistory.push(prevEma12 - prevEma26);
            }
            const signal = exponentialMovingAverage(macdHistory, 9);
            if (signal !== null) {
                macdSignal = signal;
                macdHistogram = macd - macdSignal;
            }
        }
    }

    const rsi14 = calculateRSI(history, 14);

    let bollinger = null;
    if (ma20 !== null) {
        const stdDev = calculateStandardDeviation(history, 20);
        if (stdDev !== null) {
            bollinger = {
                upper: ma20 + 2 * stdDev,
                lower: ma20 - 2 * stdDev,
                basis: ma20,
                bandwidth: (2 * stdDev) / ma20
            };
        }
    }

    const roc1 = length >= 2 ? ((history[length - 1] - history[length - 2]) / history[length - 2]) * 100 : null;
    const roc5 = length >= 6 ? ((history[length - 1] - history[length - 6]) / history[length - 6]) * 100 : null;
    const roc10 = length >= 11 ? ((history[length - 1] - history[length - 11]) / history[length - 11]) * 100 : null;

    return {
        ma5,
        ma8,
        ma20,
        ema12,
        ema26,
        macd,
        macdSignal,
        macdHistogram,
        volatility,
        trend,
        rsi14,
        bollinger,
        roc1,
        roc5,
        roc10
    };
}

module.exports = {
    appendPrice,
    calculate
};
