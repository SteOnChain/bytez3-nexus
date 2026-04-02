const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000/chat');
ws.on('open', () => {
    console.log('Open');
    ws.send(JSON.stringify({ text: 'describe an apple' }));
});
ws.on('message', (data) => console.log('Reply:', data.toString()));
ws.on('close', () => console.log('Closed'));
ws.on('error', (e) => console.error(e));
