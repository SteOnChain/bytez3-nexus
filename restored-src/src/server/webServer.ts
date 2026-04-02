import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

;(globalThis as any).MACRO = {
  VERSION: "0.1.0",
  ISSUES_EXPLAINER: "https://github.com/anthropics/claude-code/issues",
  FEEDBACK_CHANNEL: "#claude-code",
  PACKAGE_URL: "@anthropic-ai/claude-code",
  BUILD_TIME: new Date().toISOString()
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve memory paths directly (avoid pulling in the full codebase dependency chain)
function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getMemoryDir(): string {
  const configDir = getClaudeConfigDir();
  return path.join(configDir, 'projects');
}

function getMcpConfigPath(): string {
  const configDir = getClaudeConfigDir();
  return path.join(configDir, 'mcp_servers.json');
}

function findMemoryFiles(baseDir: string): { name: string; path: string; content: string }[] {
  const results: { name: string; path: string; content: string }[] = [];
  if (!fs.existsSync(baseDir)) return results;

  function walk(dir: string, depth = 0) {
    if (depth > 5) return; // safety limit
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            results.push({
              name: entry.name,
              path: path.relative(baseDir, full),
              content,
            });
          } catch {}
        }
      }
    } catch {}
  }
  walk(baseDir);
  return results;
}

function loadMcpConfig(): Record<string, unknown> {
  const configPath = getMcpConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {}
  }
  // Also check for settings.json mcpServers
  const settingsPath = path.join(getClaudeConfigDir(), 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.mcpServers) return settings.mcpServers;
    } catch {}
  }
  return {};
}

// Source code browser — index the restored source
function getSourceTree(rootDir: string): { name: string; path: string; size: number; isDir: boolean }[] {
  const results: { name: string; path: string; size: number; isDir: boolean }[] = [];
  if (!fs.existsSync(rootDir)) return results;

  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(rootDir, entry.name);
      const stat = fs.statSync(full);
      results.push({
        name: entry.name,
        path: entry.name,
        size: stat.size,
        isDir: entry.isDirectory(),
      });
    }
  } catch {}
  return results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

import { ask } from '../QueryEngine.js';
import { getCommands } from '../commands.js';
import { assembleToolPool } from '../tools.js';
import { cwd } from 'node:process';
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE, type FileStateCache } from '../utils/fileStateCache.js';
import type { AppState } from '../state/AppState.js';

export interface WebServerContext {
  getAppState: () => AppState;
  setAppState: (f: AppState | ((prev: AppState) => AppState)) => void;
}

export async function startWebServer(port: number = 3000, context?: WebServerContext) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Override res.json to bypass express res.send() and the stubbed mime-types module
  app.use((req, res, next) => {
    res.json = function(obj: any) {
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      return this.end(JSON.stringify(obj));
    } as any;
    next();
  });

  const projectRoot = path.resolve(__dirname, '../../..');

  // ── API Routes ──────────────────────────────────────────────────────────
  app.get('/api/memory', (_req, res) => {
    try {
      const memDir = getMemoryDir();
      const files = findMemoryFiles(memDir);
      res.json({ memoryDir: memDir, files });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/mcp', (_req, res) => {
    try {
      const config = loadMcpConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Agent definitions endpoint — returns all known agents + their status
  app.get('/api/agents', (_req, res) => {
    try {
      if (!context) {
        return res.json({ agents: [], active: [] });
      }
      const appState = context.getAppState();
      const defs = appState.agentDefinitions || { allAgents: [], activeAgents: [] };
      const allAgents = (defs.allAgents || []).map((a: any) => ({
        id: a.agentType,
        name: a.agentType,
        source: a.source || 'unknown',
        color: a.color || 'purple',
        model: a.model || process.env.ANTHROPIC_MODEL || 'default',
        whenToUse: a.whenToUse || '',
        tools: a.tools || [],
        background: a.background || false,
        memory: a.memory || null,
      }));
      const activeIds = (defs.activeAgents || []).map((a: any) => a.agentType || a.id);
      res.json({ agents: allAgents, active: activeIds });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/api/agents/:id/model', (req, res) => {
    try {
      const agentId = req.params.id;
      const { model } = req.body;
      const configPath = path.join(process.cwd(), '.claude', 'agent-config.json');
      
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      let config: any = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
      
      if (!config[agentId]) config[agentId] = {};
      config[agentId].model = model;
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.json({ success: true, model });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/source', (req, res) => {
    try {
      const relPath = (req.query.path as string) || '';
      const srcRoot = path.join(projectRoot, 'restored-src', 'src');
      const target = path.resolve(srcRoot, relPath);

      // Security: ensure we stay within src
      if (!target.startsWith(srcRoot)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        const tree = getSourceTree(target);
        res.json({ type: 'directory', path: relPath, entries: tree });
      } else {
        const content = fs.readFileSync(target, 'utf8');
        res.json({ type: 'file', path: relPath, content, size: stat.size });
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/stats', (_req, res) => {
    try {
      const srcRoot = path.join(projectRoot, 'restored-src', 'src');
      let totalFiles = 0;
      let totalLines = 0;
      let totalBytes = 0;

      function countFiles(dir: string) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              countFiles(full);
            } else if (entry.name.match(/\.(ts|tsx|js|jsx)$/)) {
              totalFiles++;
              const content = fs.readFileSync(full, 'utf8');
              totalLines += content.split('\n').length;
              totalBytes += Buffer.byteLength(content, 'utf8');
            }
          }
        } catch {}
      }
      countFiles(srcRoot);

      res.json({
        totalFiles,
        totalLines,
        totalBytes,
        totalBytesHuman: `${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ── HTML UI ─────────────────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(getIndexHTML());
  });

  const server = app.listen(port, () => {
    console.log(`\n  ⚡ Bytez3 Nexus Web UI (OpenClaw style)`);
    console.log(`  ➜ http://localhost:${port}\n`);
  });

  const wss = new WebSocketServer({ noServer: true });
  const wssRelay = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url?.split('?')[0];
    if (pathname === '/chat') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/browser-relay') {
      wssRelay.handleUpgrade(request, socket, head, (ws) => {
        wssRelay.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Global relay state
  const relayContext = {
    activeSocket: null as WebSocket | null,
    pendingRequests: new Map<string, {resolve: (v: any)=>void, reject: (err: any)=>void}>()
  };

  (global as any).__browserRelayContext = relayContext;

  wssRelay.on('connection', (ws) => {
    console.log('[Browser Relay] Extension connected');
    relayContext.activeSocket = ws as any;
    
    ws.on('message', (msg) => {
       try {
         const data = JSON.parse(msg.toString());
         if (data.id && relayContext.pendingRequests.has(data.id)) {
           const promiseControls = relayContext.pendingRequests.get(data.id)!;
           if (data.error) {
             promiseControls.reject(new Error(data.error));
           } else {
             promiseControls.resolve(data);
           }
           relayContext.pendingRequests.delete(data.id);
         }
       } catch (e) {
         console.error('[Browser Relay] Error parsing message', e);
       }
    });

    ws.on('close', () => {
       console.log('[Browser Relay] Extension disconnected');
       if (relayContext.activeSocket === ws) relayContext.activeSocket = null;
    });
  });
  
  // Basic session context
  let readFileCache: FileStateCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
  const getReadFileCache = () => readFileCache;
  const setReadFileCache = (c: FileStateCache) => { readFileCache = c; };

  wss.on('connection', (ws) => {
    console.log('Client connected to chat stream.');
    const abortController = new AbortController();

    ws.send(JSON.stringify({ type: 'message', role: 'agent', content: '> Bytez3 Core Nexus AI integrated.\\n' }));
    // Send initial agent list to populate sidebar
    if (context) {
      try {
        const appState = context.getAppState();
        const defs = appState.agentDefinitions || { allAgents: [], activeAgents: [] };
        const allAgents = (defs.allAgents || []).map((a: any) => ({
          id: a.agentType, name: a.agentType, source: a.source || 'unknown',
          color: a.color || 'purple', model: a.model || process.env.ANTHROPIC_MODEL || 'default',
          whenToUse: a.whenToUse || '', background: a.background || false,
        }));
        const activeIds = (defs.activeAgents || []).map((a: any) => a.agentType || a.id);
        ws.send(JSON.stringify({ type: 'agents', agents: allAgents, active: activeIds }));
      } catch {}
    }

    ws.on('message', async (msg) => {
      let text = '';
      try {
        const parsed = JSON.parse(msg.toString());
        text = parsed.text || '';
      } catch (e) {
        text = msg.toString();
      }

      if (!text || !context) return;

      try {
        const appState = context.getAppState();
        const currentCwd = cwd();
        const commands = await getCommands(currentCwd);
        // Map any active agents from state
        const agentDefinitions = appState.agentDefinitions?.agents || [];
        const activeAgents = agentDefinitions.filter(a => appState.agentDefinitions.activeAgents.includes(a.id));

        const generator = ask({
          prompt: text,
          cwd: currentCwd,
          tools: assembleToolPool(appState.toolPermissionContext, appState.mcp.tools),
          commands,
          agents: activeAgents,
          mcpClients: appState.mcp.clients,
          canUseTool: async () => ({ behavior: 'allow' as const }), // Auto-approve all tools in remote WebUI
          getAppState: context.getAppState,
          setAppState: context.setAppState as any,
          getReadFileCache,
          setReadFileCache,
          abortController,
          verbose: false,
        });

        // Consume SDK messages and stringify for UI
        for await (const sdkMessage of generator) {
          if (sdkMessage.type === 'assistant' && sdkMessage.message) {
            for (const content of sdkMessage.message.content) {
              if (content.type === 'text') {
                 ws.send(JSON.stringify({ type: 'message', role: 'agent', content: content.text }));
              } else if (content.type === 'tool_use') {
                 ws.send(JSON.stringify({ type: 'message', role: 'agent', content: "\\n> `[running " + content.name + "]`..." }));
              }
            }
          }
          if (sdkMessage.type === 'error') {
            ws.send(JSON.stringify({ type: 'message', role: 'error', content: "\\n**Error**: " + ((sdkMessage as any).error || 'Unknown error') + "\\n" }));
          }
        }
      } catch (err: any) {
        console.error("ASK CRASH:", err);
        ws.send(JSON.stringify({ type: 'message', role: 'error', content: `\\n**Crash Details**: ${err && err.stack ? err.stack : JSON.stringify(err)}\\n` }));
      }
    });
    
    ws.on('error', (err) => {
      console.error('WS Connection error:', err);
    });

    ws.on('close', (code, reason) => {
      console.log('Client disconnected from /chat', { code, reason: reason.toString() });
      abortController.abort();
    });
  });
}

function getIndexHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus Agent UI</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-base: #060709;
      --bg-panel: rgba(18, 20, 26, 0.6);
      --bg-input: rgba(255, 255, 255, 0.03);
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(255, 255, 255, 0.15);
      --text-main: #f1f2f4;
      --text-muted: #9ba1a6;
      --accent: #8b5cf6;
      --accent-glow: rgba(139, 92, 246, 0.2);
      --radius: 16px;
      --radius-sm: 8px;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg-base);
      color: var(--text-main);
      height: 100vh;
      display: flex;
      overflow: hidden;
    }

    /* Ambient background */
    body::before {
      content: '';
      position: absolute; width: 600px; height: 600px;
      background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
      top: -300px; left: -100px; z-index: 0; pointer-events: none;
    }

    /* Sidebar layout */
    .sidebar {
      width: 280px;
      background: var(--bg-panel);
      backdrop-filter: blur(20px) saturate(150%);
      border-right: 1px solid var(--border);
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      z-index: 10;
    }

    .brand {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 2.5rem;
    }
    .brand-icon {
      width: 38px; height: 38px;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 16px;
      box-shadow: 0 4px 20px var(--accent-glow);
    }
    .brand-text {
      font-size: 1.15rem; font-weight: 700;
      letter-spacing: -0.02em;
    }

    .nav-section { flex: 1; overflow-y: auto; }
    .nav-title {
      font-size: 0.75rem; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-muted);
      margin-bottom: 1rem; font-weight: 600;
    }
    .agent-item {
      display: flex; align-items: center; gap: 12px;
      padding: 12px; border-radius: var(--radius-sm);
      cursor: pointer; transition: all 0.2s;
      color: var(--text-muted); margin-bottom: 0.5rem;
    }
    .agent-item:hover { background: var(--bg-input); color: var(--text-main); }
    .agent-item.active {
      background: rgba(139, 92, 246, 0.1);
      color: #fff;
      border: 1px solid rgba(139, 92, 246, 0.2);
    }
    .agent-status {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: #10b981; box-shadow: 0 0 10px #10b981;
    }
    .agent-status.offline { background: #64748b; box-shadow: none; }
    .agent-status.spawned { background: #f59e0b; box-shadow: 0 0 10px rgba(245,158,11,0.5); }
    .agent-source {
      font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em;
      padding: 2px 6px; border-radius: 4px; font-weight: 600;
    }
    .agent-source.built-in { background: rgba(139,92,246,0.15); color: #a78bfa; }
    .agent-source.user { background: rgba(59,130,246,0.15); color: #60a5fa; }
    .agent-source.plugin { background: rgba(16,185,129,0.15); color: #34d399; }
    .agent-source.spawned { background: rgba(245,158,11,0.15); color: #fbbf24; }

    /* Main chat area */
    .chat-container {
      flex: 1; display: flex; flex-direction: column;
      position: relative; z-index: 1;
    }

    .chat-header {
      height: 72px; padding: 0 2rem;
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--border);
      background: rgba(6, 7, 9, 0.8); backdrop-filter: blur(12px);
    }

    .chat-messages {
      flex: 1; overflow-y: auto; padding: 2rem;
      display: flex; flex-direction: column; gap: 1.5rem;
    }

    /* Scrollbar */
    .chat-messages::-webkit-scrollbar { width: 6px; }
    .chat-messages::-webkit-scrollbar-track { background: transparent; }
    .chat-messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    .message {
      max-width: 85%;
      display: flex; flex-direction: column; gap: 6px;
      animation: msgFadeIn 0.3s ease forwards;
    }
    @keyframes msgFadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

    .message.user { align-self: flex-end; }
    .message.agent { align-self: flex-start; }

    .message-sender { font-size: 0.8rem; font-weight: 500; color: var(--text-muted); padding: 0 4px; }
    .message.user .message-sender { align-self: flex-end; }

    .message-bubble {
      padding: 1rem 1.25rem;
      border-radius: var(--radius);
      line-height: 1.6; font-size: 0.95rem;
    }

    .message.user .message-bubble {
      background: linear-gradient(135deg, var(--accent), #6d28d9);
      color: #fff;
      border-bottom-right-radius: 4px;
      box-shadow: 0 8px 24px rgba(139, 92, 246, 0.25);
    }

    .message.agent .message-bubble {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }

    /* Markdown styling inside bubble */
    .message-bubble p { margin-bottom: 0.75rem; }
    .message-bubble p:last-child { margin-bottom: 0; }
    .message-bubble pre {
      background: rgba(0,0,0,0.4); padding: 1rem;
      border-radius: var(--radius-sm); font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem; overflow-x: auto; margin: 0.75rem 0;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .message-bubble code { font-family: 'JetBrains Mono', monospace; font-size: 0.85em; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; }
    .message-bubble blockquote { border-left: 3px solid var(--accent); padding-left: 1rem; margin: 1rem 0; color: var(--text-muted); }

    /* Input area */
    .input-wrapper {
      padding: 1.5rem 2rem;
      background: linear-gradient(to top, var(--bg-base) 60%, transparent);
    }
    .input-box {
      max-width: 900px; margin: 0 auto;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem;
      display: flex; align-items: flex-end; gap: 1rem;
      transition: all 0.3s ease;
    }
    .input-box:focus-within {
      border-color: rgba(139, 92, 246, 0.5);
      background: rgba(255, 255, 255, 0.05);
      box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.1);
    }

    #chat-input {
      flex: 1; background: transparent; border: none; outline: none;
      color: var(--text-main); font-family: inherit; font-size: 0.95rem;
      resize: none; padding: 0.5rem; line-height: 1.5;
      max-height: 200px; min-height: 24px;
    }

    .send-btn {
      background: var(--accent); color: white;
      border: none; border-radius: 10px;
      width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.2s; flex-shrink: 0;
    }
    .send-btn:hover { background: #7c3aed; transform: translateY(-1px); }
    .send-btn:active { transform: translateY(1px); }

  </style>
</head>
<body>

  <aside class="sidebar">
    <div class="brand">
      <div class="brand-icon">N</div>
      <div class="brand-text">Nexus API</div>
    </div>
    
    <div class="nav-section" id="agents-sidebar">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
        <div class="nav-title" style="margin:0;">Agents <span id="agent-count" style="opacity:0.5"></span></div>
        <button id="spawn-btn" style="background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text-main);padding:2px 8px;font-size:0.75rem;cursor:pointer;">+ Spawn</button>
      </div>
      <div id="agents-list">
        <div class="agent-item active">
          <div class="agent-status"></div>
          <div><span>Core Nexus</span><br><small style="color:var(--text-muted);font-size:0.75rem">Loading...</small></div>
        </div>
      </div>
      <div class="nav-title" style="margin-top:1.5rem">Spawned Agents</div>
      <div id="spawned-agents-list">
        <div style="font-size:0.8rem;color:var(--text-muted);padding:8px 12px;">No sub-agents yet</div>
      </div>
    </div>
  </aside>

  <main class="chat-container">
    <header class="chat-header">
      <h3 style="font-weight: 600; font-size: 1rem;">Core Nexus Session</h3>
      <div style="font-size: 0.8rem; color: var(--text-muted); padding: 4px 10px; background: var(--bg-input); border-radius: 20px;" id="header-model">
        Model: ${process.env.ANTHROPIC_MODEL || 'default'}
      </div>
    </header>

    <div class="chat-messages" id="messages-container">
      <div class="message agent">
        <div class="message-sender">Nexus</div>
        <div class="message-bubble">
          <p>Hello! I am connected via WebSocket. Try typing a command.</p>
        </div>
      </div>
    </div>

    <div class="input-wrapper">
      <div class="input-box">
        <textarea id="chat-input" placeholder="Message Nexus agent..." rows="1"></textarea>
        <button class="send-btn" id="send-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
      </div>
    </div>
  </main>

  <!-- Modal Backdrop and Container -->
  <div class="modal-backdrop" id="modal-backdrop" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);z-index:100;align-items:center;justify-content:center;">
    <!-- Configure Agent Modal -->
    <div class="modal-card" id="config-modal" style="display:none;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;width:400px;box-shadow:0 10px 40px rgba(0,0,0,0.5);">
      <h3 style="margin-bottom:1rem;font-size:1.1rem;font-weight:600;">Configure <span id="config-agent-name" style="color:var(--accent);"></span></h3>
      <div style="margin-bottom:1.5rem;">
        <label style="display:block;margin-bottom:0.5rem;font-size:0.85rem;color:var(--text-muted);">Model Override</label>
        <input type="text" id="config-model-input" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.75rem;color:var(--text-main);font-family:inherit;font-size:0.95rem;outline:none;" placeholder="e.g. claude-3-5-sonnet-20241022">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:12px;">
        <button id="config-cancel-btn" style="background:transparent;border:1px solid var(--border);color:var(--text-main);padding:0.5rem 1rem;border-radius:var(--radius-sm);cursor:pointer;font-size:0.9rem;transition:all 0.2s;">Cancel</button>
        <button id="config-save-btn" style="background:var(--accent);border:none;color:white;padding:0.5rem 1rem;border-radius:var(--radius-sm);cursor:pointer;font-size:0.9rem;font-weight:500;transition:all 0.2s;">Save</button>
      </div>
    </div>
    <!-- Spawn Subagent Modal -->
    <div class="modal-card" id="spawn-modal" style="display:none;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.5);">
      <h3 style="margin-bottom:1rem;font-size:1.1rem;font-weight:600;">Spawn Subagent</h3>
      <div style="margin-bottom:1rem;">
        <label style="display:block;margin-bottom:0.5rem;font-size:0.85rem;color:var(--text-muted);">Select Agent</label>
        <select id="spawn-agent-select" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.75rem;color:var(--text-main);font-family:inherit;font-size:0.95rem;outline:none;cursor:pointer;">
        </select>
      </div>
      <div style="margin-bottom:1.5rem;">
        <label style="display:block;margin-bottom:0.5rem;font-size:0.85rem;color:var(--text-muted);">Task Description</label>
        <textarea id="spawn-task-input" rows="3" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.75rem;color:var(--text-main);font-family:inherit;font-size:0.95rem;outline:none;resize:vertical;" placeholder="Describe what the agent should do..."></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:12px;">
        <button id="spawn-cancel-btn" style="background:transparent;border:1px solid var(--border);color:var(--text-main);padding:0.5rem 1rem;border-radius:var(--radius-sm);cursor:pointer;font-size:0.9rem;transition:all 0.2s;">Cancel</button>
        <button id="spawn-submit-btn" style="background:#10b981;border:none;color:white;padding:0.5rem 1rem;border-radius:var(--radius-sm);cursor:pointer;font-size:0.9rem;font-weight:500;transition:all 0.2s;">Spawn</button>
      </div>
    </div>
  </div>

  <script>
    const msgsContainer = document.getElementById('messages-container');
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const agentsList = document.getElementById('agents-list');
    const spawnedList = document.getElementById('spawned-agents-list');
    const agentCount = document.getElementById('agent-count');
    
    // Track spawned sub-agents from tool_use events
    const spawnedAgents = new Map();

    // Auto-resize textarea
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
    });

    // Render agent sidebar from data
    function renderAgents(agents, activeIds) {
      if (!agents || agents.length === 0) {
        agentsList.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:8px 12px;">No agents loaded</div>';
        agentCount.textContent = '(0)';
        return;
      }

      // Group by source
      const groups = { 'built-in': [], 'userSettings': [], 'projectSettings': [], 'plugin': [], 'other': [] };
      agents.forEach(a => {
        const key = groups[a.source] ? a.source : 'other';
        groups[key].push(a);
      });

      let html = '';
      const sourceLabels = {
        'built-in': 'Core Agents',
        'userSettings': 'Custom Agents',
        'projectSettings': 'Project Agents',
        'plugin': 'Plugin Agents',
        'other': 'Other'
      };

      for (const [src, list] of Object.entries(groups)) {
        if (list.length === 0) continue;
        html += '<div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);padding:8px 12px 4px;opacity:0.7">' + sourceLabels[src] + '</div>';
        for (const agent of list) {
          const isActive = activeIds.includes(agent.id);
          const statusClass = isActive ? '' : 'offline';
          const activeClass = isActive ? 'active' : '';
          const statusText = isActive ? 'Active' : 'Available';
          const sourceTag = '<span class="agent-source ' + (src === 'userSettings' || src === 'projectSettings' ? 'user' : src) + '">' + src.replace('Settings','') + '</span>';
          html += '<div class="agent-item ' + activeClass + '" title="' + (agent.whenToUse || '').replace(/"/g, "&quot;") + '">' +
            '<div class="agent-status ' + statusClass + '"></div>' +
            '<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;justify-content:space-between;width:100%"><div style="display:flex;align-items:center;gap:6px"><span style="font-size:0.9rem">' + agent.name + '</span>' + sourceTag + '</div><button class="config-agent-btn" onclick="openConfigModal(\\'' + agent.id + '\\', \\'' + (agent.model || '') + '\\')" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;padding:0 4px;" title="Configure Agent Model">⚙</button></div>' +
            '<small style="color:var(--text-muted);font-size:0.72rem">' + statusText + (agent.model ? ' · ' + agent.model : '') + '</small></div></div>';
        }
      }

      agentsList.innerHTML = html;
      agentCount.textContent = '(' + agents.length + ')';
    }

    // Track sub-agents spawned during chat
    function trackSpawnedAgent(name) {
      if (spawnedAgents.has(name)) return;
      spawnedAgents.set(name, { name, spawnedAt: Date.now(), status: 'running' });
      renderSpawnedAgents();
    }

    function completeSpawnedAgent(name) {
      const a = spawnedAgents.get(name);
      if (a) { a.status = 'done'; renderSpawnedAgents(); }
    }

    function renderSpawnedAgents() {
      if (spawnedAgents.size === 0) {
        spawnedList.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:8px 12px;">No sub-agents yet</div>';
        return;
      }
      let html = '';
      for (const [name, info] of spawnedAgents) {
        const statusClass = info.status === 'running' ? 'spawned' : '';
        const statusText = info.status === 'running' ? 'Running' : 'Complete';
        html += '<div class="agent-item">' +
          '<div class="agent-status ' + statusClass + '"></div>' +
          '<div style="flex:1;min-width:0"><span style="font-size:0.9rem">' + name + '</span>' +
          '<span class="agent-source spawned" style="margin-left:6px">sub-agent</span>' +
          '<br><small style="color:var(--text-muted);font-size:0.72rem">' + statusText + '</small></div></div>';
      }
      spawnedList.innerHTML = html;
    }

    // Fetch initial agents via REST
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        window._allAgentsData = data.agents || [];
        renderAgents(window._allAgentsData, data.active || []);
      } catch(e) { console.warn('Failed to fetch agents:', e); }
    }
    fetchAgents();

    let ws;
    
    function connect() {
      ws = new WebSocket('ws://' + window.location.host + '/chat');
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Handle agent list updates
          if (data.type === 'agents') {
            renderAgents(data.agents || [], data.active || []);
            return;
          }
          const content = data.content || data.text || JSON.stringify(data);
          // Detect sub-agent spawning from tool_use messages
          const agentMatch = content.match(/\[running (\w+)\]/);
          if (agentMatch && agentMatch[1] === 'Agent') {
            const nameMatch = content.match(/Agent[:\s]+([\w-]+)/i);
            if (nameMatch) trackSpawnedAgent(nameMatch[1]);
          }
          appendAgentText(content);
        } catch(e) {
          appendAgentText(event.data);
        }
      };
      
      ws.onclose = () => {
        setTimeout(connect, 3000);
      };
    }
    connect();

    // Refresh agent list periodically (picks up newly created agents)
    setInterval(fetchAgents, 15000);

    // The current agent message bubble being streamed to
    let currentAgentBubble = null;
    let agentBuffer = '';

    function appendAgentText(text) {
      if (!currentAgentBubble) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message agent';
        msgDiv.innerHTML = '<div class="message-sender">Nexus</div><div class="message-bubble markdown-body"></div>';
        msgsContainer.appendChild(msgDiv);
        currentAgentBubble = msgDiv.querySelector('.message-bubble');
        agentBuffer = '';
      }
      
      agentBuffer += text;
      if (typeof marked !== 'undefined') {
        currentAgentBubble.innerHTML = marked.parse(agentBuffer);
      } else {
        currentAgentBubble.textContent = agentBuffer;
      }
      msgsContainer.scrollTop = msgsContainer.scrollHeight;
      
      clearTimeout(currentAgentBubble.timeout);
      currentAgentBubble.timeout = setTimeout(() => {
        currentAgentBubble = null;
      }, 300);
    }

    function appendUserMessage(text) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message user';
      msgDiv.innerHTML = '<div class="message-sender">You</div><div class="message-bubble"></div>';
      msgDiv.querySelector('.message-bubble').textContent = text;
      msgsContainer.appendChild(msgDiv);
      msgsContainer.scrollTop = msgsContainer.scrollHeight;
    }

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      
      appendUserMessage(text);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text }));
      }
      input.value = '';
      input.style.height = 'auto';
      // Refresh agents shortly after sending (picks up any new spawns)
      setTimeout(fetchAgents, 2000);
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Modal logic
    const backdrop = document.getElementById('modal-backdrop');
    const configModal = document.getElementById('config-modal');
    const spawnModal = document.getElementById('spawn-modal');

    // Config:
    let currentConfigAgentId = '';
    window.openConfigModal = function(id, model) {
      if (typeof event !== 'undefined' && event) event.stopPropagation();
      currentConfigAgentId = id;
      document.getElementById('config-agent-name').textContent = id;
      document.getElementById('config-model-input').value = model || '';
      backdrop.style.display = 'flex';
      configModal.style.display = 'block';
      spawnModal.style.display = 'none';
    };
    document.getElementById('config-cancel-btn').addEventListener('click', () => {
      backdrop.style.display = 'none';
    });
    document.getElementById('config-save-btn').addEventListener('click', async () => {
      const model = document.getElementById('config-model-input').value.trim();
      try {
        await fetch('/api/agents/' + currentConfigAgentId + '/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model })
        });
        backdrop.style.display = 'none';
        fetchAgents();
      } catch(e) { alert('Failed to save config'); }
    });

    // Spawn:
    const spawnBtn = document.getElementById('spawn-btn');
    if (spawnBtn) {
      spawnBtn.addEventListener('click', () => {
        const select = document.getElementById('spawn-agent-select');
        select.innerHTML = '';
        if (window._allAgentsData) {
          window._allAgentsData.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.name + (a.model ? ' ('+a.model+')' : '');
            select.appendChild(opt);
          });
        }
        document.getElementById('spawn-task-input').value = '';
        backdrop.style.display = 'flex';
        configModal.style.display = 'none';
        spawnModal.style.display = 'block';
      });
    }
    document.getElementById('spawn-cancel-btn').addEventListener('click', () => {
      backdrop.style.display = 'none';
    });
    document.getElementById('spawn-submit-btn').addEventListener('click', () => {
      const agentId = document.getElementById('spawn-agent-select').value;
      const task = document.getElementById('spawn-task-input').value.trim();
      if (!task) return;
      // Synthesize a prompt for the user/system to spawn it
      const msg = 'Please spawn the agent \\'' + agentId + '\\' to do the following task: ' + task;
      appendUserMessage(msg);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text: msg }));
      }
      backdrop.style.display = 'none';
    });

  </script>
</body>
</html>
`;
}

// Direct run
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('webServer.ts')) {
  import('../utils/config.js').then(({ enableConfigs }) => {
    enableConfigs();
    import('../state/store.js').then(({ createStore }) => {
      import('../state/AppStateStore.js').then(({ getDefaultAppState }) => {
        import('../state/onChangeAppState.js').then(({ onChangeAppState }) => {
          const headlessInitialState = {
            ...getDefaultAppState(),
          }
          const headlessStore = createStore(headlessInitialState, onChangeAppState)

          const port = parseInt(process.argv[2] || process.env.PORT || '3333', 10);
          startWebServer(port, {
            getAppState: () => headlessStore.getState(),
            setAppState: (f: any) => headlessStore.setState(f),
          });
        });
      });
    });
  });
}
