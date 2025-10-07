module.exports = {
    price: 'span[data-outer-price]',
    buyButton: 'button[class*="bg-[--long]"]',
    sellButton: 'button[class*="bg-[--short]"]',
    limitPriceInput: 'input[placeholder="委托价格"], input[placeholder*="价格"], input[data-testid="order-price"]',
    amountInput: 'input[id="orderSizeValue"]',
    limitModeTab: 'div[role="tab"]:has-text("限价"), div[data-state]:has-text("限价")',
    confirmButton: 'button.btn-primary',
    activeOrderTab: 'button[role="tab"][aria-controls$="content-activeOrder"]',
    activeOrderPanel: '[id$="content-activeOrder"]',
    activeOrderRows: '[id$="content-activeOrder"] tbody tr',
    orderContainer: '.container-order-form',
    positionTableRow: '#radix-\\:rf8\\:-content-positions table tbody tr',
    positionDirection: '.inline-flex .text-\\[--long\\], .inline-flex .text-\\[--short\\]',
    positionSize: 'td:nth-child(2)',
    confirmTexts: {
        buy: ['确认 买入', '确认买入'],
        sell: ['确认 卖出', '确认卖出']
    }
};
