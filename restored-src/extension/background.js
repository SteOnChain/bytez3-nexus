const SERVER_URL = 'ws://localhost:3333/browser-relay';
let socket = null;

function connect() {
  if (socket) return;
  socket = new WebSocket(SERVER_URL);

  socket.onopen = () => {
    console.log('[Byez3 Relay] Connected to agent server');
    socket.send(JSON.stringify({ type: 'hello', status: 'ready' }));
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (!msg.id || !msg.action) return;

      console.log('[Bytez3 Relay] Received action:', msg.action);

      // Handle "open" natively
      if (msg.action === 'open') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
          await chrome.tabs.update(tabs[0].id, { url: msg.url });
          // Wait a bit for page load
          setTimeout(() => {
            socket.send(JSON.stringify({ id: msg.id, result: 'Navigated to ' + msg.url }));
          }, 3000);
        } else {
            chrome.tabs.create({ url: msg.url }, () => {
                setTimeout(() => {
                  socket.send(JSON.stringify({ id: msg.id, result: 'Opened ' + msg.url }));
                }, 3000);
            });
        }
        return;
      }

      // Delegate other actions to the content script of the active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length === 0) {
        socket.send(JSON.stringify({ id: msg.id, error: 'No active tab found' }));
        return;
      }

      chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
        if (chrome.runtime.lastError) {
          socket.send(JSON.stringify({ id: msg.id, error: chrome.runtime.lastError.message }));
        } else {
          socket.send(JSON.stringify({ id: msg.id, ...response }));
        }
      });
    } catch (e) {
      console.error(e);
    }
  };

  socket.onclose = () => {
    console.log('[Bytez3 Relay] Disconnected. Reconnecting in 3s...');
    socket = null;
    setTimeout(connect, 3000);
  };
}

connect();
