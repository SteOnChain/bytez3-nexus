const fs = require('fs');

let html = fs.readFileSync('/tmp/template.html', 'utf8');
let oldCode = fs.readFileSync('src/server/webServer.ts', 'utf8');

// Replace imports
oldCode = oldCode.replace("import cors from 'cors';", "import cors from 'cors';\nimport { WebSocketServer, WebSocket } from 'ws';\nimport { spawn } from 'child_process';");

// Replace server start logic
const oldStart = `  app.get('/', (_req, res) => {
    res.send(getIndexHTML());
  });

  app.listen(port, () => {
    console.log(\`\\n  ⚡ Bytez3 Nexus Web UI\`);
    console.log(\`  ➜ http://localhost:\${port}\\n\`);
  });
}`;

const newStart = `  app.get('/', (_req, res) => {
    res.send(getIndexHTML());
  });

  const server = app.listen(port, () => {
    console.log(\`\\n  ⚡ Bytez3 Nexus Web UI (OpenClaw style)\`);
    console.log(\`  ➜ http://localhost:\${port}\\n\`);
  });

  const wss = new WebSocketServer({ server, path: '/chat' });
  
  wss.on('connection', (ws) => {
    console.log('Client connected to chat stream.');
    
    // Spawn a bash shell as a placeholder agent
    const proc = spawn('bash', [], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    ws.send(JSON.stringify({ type: 'message', role: 'agent', content: '> bash agent shell initialized.\\n' }));
    
    proc.stdout.on('data', (data) => {
      ws.send(JSON.stringify({ type: 'message', role: 'agent', content: data.toString() }));
    });
    
    proc.stderr.on('data', (data) => {
      ws.send(JSON.stringify({ type: 'message', role: 'agent', content: data.toString() }));
    });
    
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.text) {
          proc.stdin.write(parsed.text + '\\n');
        }
      } catch (e) {
        proc.stdin.write(msg.toString() + '\\n');
      }
    });
    
    ws.on('close', () => {
      console.log('Client disconnected');
      proc.kill();
    });
  });
}`;

oldCode = oldCode.replace(oldStart, newStart);

// Replace getIndexHTML Body
const getIndexRegex = /function getIndexHTML\(\): string \{\n  return `[\s\S]*?`;\n\}/;
oldCode = oldCode.replace(getIndexRegex, "function getIndexHTML(): string {\n  return `" + html.replace(/`/g, "\\`").replace(/\$/g, "\\$") + "`;\n}");

fs.writeFileSync('src/server/webServer.ts', oldCode);
console.log('webServer.ts updated successfully');
