const fs = require('fs');
const path = require('path');

require('dotenv').config();

const storageStatePath = process.env.PLAYWRIGHT_STORAGE ?? path.join(__dirname, 'state.json');

const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR || null;
const allowExtensions = (() => {
    if (process.env.PLAYWRIGHT_ALLOW_EXTENSIONS) {
        return process.env.PLAYWRIGHT_ALLOW_EXTENSIONS.toLowerCase() !== 'false';
    }
    return Boolean(userDataDir);
})();

module.exports = {
    edgexUrl: process.env.EDGEX_URL || 'https://pro.edgex.exchange/trade/ETHUSD',
    aiEndpoint: process.env.AI_ENDPOINT || 'http://154.17.228.72:12345/ai-decision',
    ticker: process.env.BOT_TICKER || 'ETHUSD',
    quantity: parseFloat(process.env.BOT_QUANTITY || '0.02'),
    priceOffset: parseFloat(process.env.BOT_PRICE_OFFSET || '0.001'),
    collectIntervalSec: parseInt(process.env.BOT_COLLECT_INTERVAL_SEC || '5', 10),
    tradingIntervalSec: parseInt(process.env.BOT_TRADING_INTERVAL_SEC || '90', 10),
    priceHistoryLength: parseInt(process.env.BOT_PRICE_HISTORY_LENGTH || '20', 10),
    minIntervalMin: parseInt(process.env.BOT_MIN_INTERVAL_MIN || '1', 10),
    maxIntervalMin: parseInt(process.env.BOT_MAX_INTERVAL_MIN || '4', 10),
    headless: (process.env.PLAYWRIGHT_HEADLESS || 'true').toLowerCase() !== 'false',
    browserChannel: process.env.PLAYWRIGHT_BROWSER || 'chromium',
    userDataDir,
    allowExtensions,
    browserArgs: process.env.PLAYWRIGHT_BROWSER_ARGS
        ? process.env.PLAYWRIGHT_BROWSER_ARGS.split(' ').filter(Boolean)
        : [],
    externalMarket: {
        enabled: (process.env.BOT_EXTERNAL_ENABLED || 'true').toLowerCase() !== 'false',
        symbol: (process.env.BOT_EXTERNAL_SYMBOL || 'ETHUSDT').toUpperCase(),
        futuresSymbol: (process.env.BOT_EXTERNAL_FUTURES_SYMBOL || process.env.BOT_EXTERNAL_SYMBOL || 'ETHUSDT').toUpperCase(),
        ttl: parseInt(process.env.BOT_EXTERNAL_TTL_SEC || '10', 10),
        klineInterval: process.env.BOT_EXTERNAL_KLINE_INTERVAL || '1m',
        klineLimit: parseInt(process.env.BOT_EXTERNAL_KLINE_LIMIT || '300', 10),
        timeoutMs: parseInt(process.env.BOT_EXTERNAL_TIMEOUT_MS || '10000', 10)
    },
    riskManagement: {
        enabled: (process.env.BOT_RISK_ENABLED || 'true').toLowerCase() !== 'false',
        stopLossPct: parseFloat(process.env.BOT_RISK_STOP_LOSS_PCT ?? '0.6'),
        takeProfitPct: parseFloat(process.env.BOT_RISK_TAKE_PROFIT_PCT ?? '1.0'),
        maxHoldMinutes: parseFloat(process.env.BOT_RISK_MAX_HOLD_MINUTES ?? '30'),
        maxOrderWaitSeconds: parseFloat(process.env.BOT_RISK_MAX_ORDER_WAIT_SEC ?? '60'),
        signalConfirmationCount: parseInt(process.env.BOT_RISK_SIGNAL_CONFIRMATION ?? '1', 10),
        dailyLossLimit: parseFloat(process.env.BOT_RISK_DAILY_LOSS_LIMIT ?? '-30'),
        maxConsecutiveLosses: parseInt(process.env.BOT_RISK_MAX_CONSECUTIVE_LOSSES ?? '3', 10),
        pauseMinutesOnBreach: parseFloat(process.env.BOT_RISK_PAUSE_MINUTES ?? '60'),
        maxPositionSize: parseFloat(process.env.BOT_RISK_MAX_POSITION_SIZE ?? '0.22'),
        atrStopLossFactor: parseFloat(process.env.BOT_RISK_ATR_STOP_FACTOR ?? '1.5'),
        atrTakeProfitFactor: parseFloat(process.env.BOT_RISK_ATR_TP_FACTOR ?? '2.5'),
        fundingRateLongMax: parseFloat(process.env.BOT_RISK_FUNDING_LONG_MAX ?? '0.01'),
        fundingRateShortMin: parseFloat(process.env.BOT_RISK_FUNDING_SHORT_MIN ?? '-0.01'),
        dailyDrawdownPausePct: parseFloat(process.env.BOT_RISK_DAILY_DRAWDOWN_PCT ?? '5')
    },
    dynamicOffset: {
        enabled: (process.env.BOT_DYNAMIC_OFFSET_ENABLED || 'true').toLowerCase() !== 'false',
        factor: parseFloat(process.env.BOT_DYNAMIC_OFFSET_FACTOR ?? '0.015'),
        min: process.env.BOT_DYNAMIC_OFFSET_MIN ? parseFloat(process.env.BOT_DYNAMIC_OFFSET_MIN) : null,
        max: process.env.BOT_DYNAMIC_OFFSET_MAX ? parseFloat(process.env.BOT_DYNAMIC_OFFSET_MAX) : null
    },
    signalFilters: {
        mtfThreshold: parseFloat(process.env.BOT_SIGNAL_MTF_THRESHOLD ?? '0.05')
    },
    storageStatePath,
    hasStorageState: fs.existsSync(storageStatePath),
    selectors: require('./selectors')
};
