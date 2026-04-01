# claude-code-sourcemap

> Run Claude Code CLI with **any local LLM** via Ollama — no Anthropic API key needed.

[![Ollama](https://img.shields.io/badge/Ollama-Ready-black?logo=ollama&logoColor=white)](https://ollama.com)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

---

## What Is This?

This project takes the [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) (Anthropic's agentic coding assistant) and adds **native Ollama support** — letting you run the full CLI experience against local models like Llama 3.2, Qwen 2.5 Coder, DeepSeek R1, Mistral, and more.

The original TypeScript source was restored from the public npm package's source map (`cli.js.map`, version `2.1.88`). On top of that, we built a **translation proxy layer** that intercepts all Anthropic SDK calls and transparently routes them through Ollama's OpenAI-compatible endpoint.

### Key Features

- 🏠 **Run fully local** — no API keys, no cloud calls, complete privacy
- ☁️ **Ollama Cloud support** — connect to remote Ollama deployments
- 🔧 **Tool calling** — full support for function calling / tool use
- 🌊 **Streaming** — real-time token streaming, just like the original
- 🧠 **Any model** — use whatever you've pulled: `llama3.2`, `qwen2.5-coder:7b`, `deepseek-r1:8b`, `mistral:7b`, etc.
- 📦 **Zero changes to the UI** — the rest of claude-code has no idea it's talking to Ollama

---

## Quick Start

### Prerequisites

1. **[Ollama](https://ollama.com)** installed and running (`ollama serve`)
2. **A model pulled** — e.g. `ollama pull qwen2.5-coder:7b`
3. **Node.js 18+**

### Run the Tests

```bash
# Clone
git clone https://github.com/SteOnChain/claude-code-sourcemap.git
cd claude-code-sourcemap

# Install dependencies
npm install

# Run translation tests (no Ollama needed)
node test-ollama.mjs --dry-run

# Run full test suite with live Ollama connection
OLLAMA_MODEL=qwen2.5:7b node test-ollama.mjs
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_CODE_USE_OLLAMA` | — | Set to `1` to enable Ollama provider |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_API_KEY` | — | API key for Ollama Cloud authentication |
| `ANTHROPIC_MODEL` | — | Model name (e.g., `qwen2.5-coder:7b`, `llama3.2`) |

### Usage

```bash
# Local Ollama
CLAUDE_CODE_USE_OLLAMA=1 ANTHROPIC_MODEL=qwen2.5-coder:7b claude

# Ollama Cloud
CLAUDE_CODE_USE_OLLAMA=1 \
  OLLAMA_BASE_URL=https://your-cloud.ollama.ai \
  OLLAMA_API_KEY=sk-your-key \
  ANTHROPIC_MODEL=llama3.2 \
  claude

# Custom local port
CLAUDE_CODE_USE_OLLAMA=1 OLLAMA_BASE_URL=http://localhost:11435 ANTHROPIC_MODEL=mistral:7b claude
```

---

## How It Works

The integration uses a **fetch-level interception** architecture. When `CLAUDE_CODE_USE_OLLAMA=1` is set:

```
┌─────────────────┐     ┌──────────────┐     ┌────────────────────┐
│  Claude Code UI │────▶│ Anthropic SDK │────▶│   Fetch Override   │
│  (unchanged)    │     │ (unchanged)  │     │ (our translation)  │
└─────────────────┘     └──────────────┘     └─────────┬──────────┘
                                                       │
                                          ┌────────────▼────────────┐
                                          │   Request Translator    │
                                          │ Anthropic → OpenAI fmt  │
                                          └────────────┬────────────┘
                                                       │
                                          ┌────────────▼────────────┐
                                          │        Ollama           │
                                          │ /v1/chat/completions    │
                                          └────────────┬────────────┘
                                                       │
                                          ┌────────────▼────────────┐
                                          │  Response Translator    │
                                          │ OpenAI SSE → Anthropic  │
                                          └────────────┬────────────┘
                                                       │
                                          ┌────────────▼────────────┐
                                          │  Claude Code UI sees    │
                                          │  normal Anthropic SSE   │
                                          └─────────────────────────┘
```

### Translation Details

| Anthropic Format | OpenAI/Ollama Format |
|---|---|
| `system: [{type: 'text', text: '...'}]` | `{role: 'system', content: '...'}` |
| `{type: 'tool_use', id, name, input}` | `tool_calls: [{id, function: {name, arguments}}]` |
| `{type: 'tool_result', tool_use_id}` | `{role: 'tool', tool_call_id}` |
| `tool_choice: {type: 'auto'}` | `tool_choice: 'auto'` |
| `content_block_delta` (SSE) | `choices[].delta` (SSE) |
| `stop_reason: 'tool_use'` | `finish_reason: 'tool_calls'` |

---

## Project Structure

```
claude-code-sourcemap/
├── restored-src/src/                     # Restored TypeScript source (v2.1.88)
│   ├── main.tsx                          # CLI entry point
│   ├── services/api/
│   │   ├── client.ts                     # API client factory (modified — Ollama injection point)
│   │   ├── claude.ts                     # Message handling & streaming
│   │   └── ollama/                       # ✨ NEW — Ollama translation proxy
│   │       ├── index.ts                  # Barrel export
│   │       ├── ollamaClient.ts           # Fetch override factory
│   │       ├── requestTranslator.ts      # Anthropic → OpenAI request translation
│   │       └── responseTranslator.ts     # OpenAI SSE → Anthropic SSE translation
│   ├── utils/model/
│   │   ├── providers.ts                  # Provider registry (modified — 'ollama' added)
│   │   ├── configs.ts                    # Model configs (modified — ollama field added)
│   │   ├── modelAllowlist.ts             # Model allowlist (modified — Ollama bypass)
│   │   └── model.ts                      # Model resolution
│   ├── tools/                            # 30+ tools (Bash, FileEdit, Grep, MCP, etc.)
│   ├── commands/                         # 40+ commands (commit, review, config, etc.)
│   ├── coordinator/                      # Multi-agent coordination
│   ├── assistant/                        # Assistant mode (KAIROS)
│   ├── plugins/                          # Plugin system
│   ├── skills/                           # Skills system
│   ├── voice/                            # Voice interaction
│   └── vim/                              # Vim mode
├── test-ollama.mjs                       # ✨ Standalone test suite (49 assertions)
├── extract-sources.js                    # Source map extraction script
├── package.json                          # Project metadata & dependencies
└── claude-code-2.1.88.tgz               # Original npm package
```

---

## Test Results

```
═══ Ollama Integration Tests ═══

▸ Test 1: Request Translation (Anthropic → OpenAI)        16/16 ✅
▸ Test 2: Response Stream Translation (OpenAI → Anthropic) 10/10 ✅
▸ Test 3: Tool Call Response Translation                    8/8  ✅
▸ Test 4: Non-Streaming Response Translation               10/10 ✅
▸ Test 5: Live Ollama Connection (qwen2.5:7b)               5/5  ✅

═══ Results ═══
  49 passed  0 failed

✓ All tests passed! Ollama integration is working.
```

---

## Recommended Models

| Model | Size | Best For |
|---|---|---|
| `qwen2.5-coder:7b` | 4.7 GB | Code generation, tool calling |
| `llama3.2` | 2.0 GB | General purpose, fast |
| `deepseek-r1:8b` | 4.9 GB | Reasoning, complex tasks |
| `mistral:7b` | 4.1 GB | Balanced performance |
| `codellama:13b` | 7.4 GB | Code-focused, larger context |
| `qwen2.5:72b` | 41 GB | Best quality (needs GPU) |

---

## Restored Source Details

- **npm package**: [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- **Version**: `2.1.88`
- **Files restored**: 4,756 (including 1,884 `.ts`/`.tsx` source files)
- **Method**: Extracted `sourcesContent` from `cli.js.map`

---

## Disclaimer

- Original source code copyright belongs to [Anthropic](https://www.anthropic.com)
- This repository is for technical research and educational purposes only
- The Ollama integration layer is original work
- Not affiliated with Anthropic or Ollama
- If there are any copyright concerns, please open an issue
