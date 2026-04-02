const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000/chat');
ws.on('open', () => {
    ws.send(JSON.stringify({ text: 'hello' }));
});
ws.on('close', () => console.log('Closed'));
ws.on('error', (e) => console.error(e));
