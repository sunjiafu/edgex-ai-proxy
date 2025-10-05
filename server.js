// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config(); // 加载.env中的OPENAI_API_KEY

// 如果你用openai官方nodejs库（推荐！）
const { Configuration, OpenAIApi } = require('openai');
const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAIApi(new Configuration({
  apiKey: process.env.OPENAI_API_KEY, // .env 文件里配置 OPENAI_API_KEY=你的key
}));

// 参数判定简单类型安全工具（可选）
function safe(val, def) {
    return val === undefined || val === null || (typeof val === "number" && isNaN(val)) ? def : val;
}

app.post('/ai-decision', async (req, res) => {
    // 前端发送的新一代AI量化数据
    const {
        symbol, currentPrice, priceHistory, indicators, position, tradingStats, priceChange
    } = req.body;

    // 构造自然语言prompt
    const prompt = `
你是专业加密量化交易策略AI。
合约: ${safe(symbol,'未知')} 当前价: ${safe(currentPrice,'?')}
历史价格: ${Array.isArray(priceHistory)?priceHistory.slice(-8).join(", "):'未知'}
短期均线: MA5=${safe(indicators?.ma5,'?')} MA8=${safe(indicators?.ma8,'?')}
波动率: ${safe(indicators?.volatility,'?')}%
趋势判断: ${safe(indicators?.trend,'?')}
价格区间变化: ${typeof priceChange==='number'?priceChange.toFixed(2)+"%":'未知'}
当前持仓: ${(position && position.hasPosition)?(position.direction + " " + position.size):'无'}
历史交易:${tradingStats?.totalTrades??0} 总量: ${tradingStats?.totalVolume??0}
请基于这些特征，综合判断是buy（做多）、sell（做空）还是hold（观望），只允许返回这三词之一。
`;

    try {
        const completion = await openai.createChatCompletion({
            model: 'gpt-3.5-turbo',
            max_tokens: 8,
            temperature: 0.1,
            messages: [
                { role: "system", content: "你是一个经验丰富的量化策略决策机器人，请直接返回buy、sell或hold，无需其他解释。" },
                { role: "user", content: prompt }
            ]
        });
        let reply = completion.data.choices[0].message.content.trim().toLowerCase();
        if (!/^(buy|sell|hold)$/.test(reply)) reply = 'hold'; // 防止跑偏
        res.json({ direction: reply });
    } catch(e) {
        console.error('openai error:', e);
        res.json({ direction: 'hold', error: e.message });
    }
});

// healthcheck
app.get('/', (req, res) => res.send('EdgeX AI Server OK'));

// 启动服务
const PORT = process.env.PORT || 12345;
app.listen(PORT, () => console.log(`EdgeX AI决策服务已启动，端口: ${PORT}`));
