// app.js（Node.js，express示例）
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
// 以OpenAI gpt-3.5/4为例
const { OpenAIApi, Configuration } = require('openai');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// === 你要在.env或配置内换为你的openai key ===
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

app.post('/ai-decision', async (req, res) => {
    const data = req.body;
    const { symbol, currentPrice, priceHistory, indicators, position, tradingStats } = data;

    // 构建自然语言prompt
    const prompt = `
你正在协助自动量化机器人做${symbol}交易。
当前价格: ${currentPrice}
历史价格: ${priceHistory ? priceHistory.slice(-8).join(', ') : '未知'}
均线: MA5=${indicators?.ma5??'未知'}, MA8=${indicators?.ma8??'未知'}
波动率: ${indicators?.volatility??'未知'}%
行情趋势: ${indicators?.trend??'未知'}
当前持仓: ${position && position.hasPosition ? position.direction + ' ' + position.size : '无'}
历史交易次数: ${(tradingStats&&tradingStats.totalTrades)||0}

- 你的任务是只回复buy, sell或hold作为交易建议，且只有一个词。hold表示暂时不交易，buy为限价买入(做多)，sell为限价卖出(做空)。综合指标和历史走势、不要频繁反转。
`;

    // 调用GPT（你也可以用本地规则或其它AI模型）
    try {
        const completion = await openai.createChatCompletion({
            model: 'gpt-3.5-turbo', max_tokens: 32,
            messages: [{"role": "user", "content": prompt}]
        });
        // 提取建议
        let reply = completion.data.choices[0].message.content.trim().toLowerCase();
        // 只允许 buy, sell, hold
        if (!/^(buy|sell|hold)$/.test(reply)) reply = 'hold';
        res.json({ direction: reply });
    } catch (e) {
        res.json({ direction: 'hold', error: String(e) });
    }
});

app.listen(12345, () => console.log('AI量化决策服务运行在12345端口'));
