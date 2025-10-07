const config = require('./config');

async function getDecision(payload) {
    try {
        const res = await fetch(config.aiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            throw new Error(`AI endpoint ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        return (data.direction || 'hold').toLowerCase();
    } catch (error) {
        console.error('[bot] AI decision failed:', error.message);
        return 'hold';
    }
}

module.exports = {
    getDecision
};
