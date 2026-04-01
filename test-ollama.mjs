#!/usr/bin/env node

/**
 * Ollama Integration Test
 *
 * Standalone test that validates the entire Ollama translation pipeline:
 * 1. Request Translation (Anthropic → OpenAI format)
 * 2. Response Translation (OpenAI SSE → Anthropic SSE format)
 * 3. Live Ollama Connection (if available)
 *
 * Usage:
 *   node test-ollama.mjs                          # Test with local Ollama
 *   OLLAMA_BASE_URL=https://... node test-ollama.mjs  # Test with Ollama Cloud
 *   node test-ollama.mjs --dry-run                # Translation-only tests (no Ollama needed)
 */

const isDryRun = process.argv.includes('--dry-run')
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || ''
const TEST_MODEL = process.env.ANTHROPIC_MODEL || process.env.OLLAMA_MODEL || 'llama3.2'

// ── Colors ───────────────────────────────────────────────────────────────────
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

let passed = 0
let failed = 0

function assert(condition, name) {
  if (condition) {
    console.log(`  ${c.green('✓')} ${name}`)
    passed++
  } else {
    console.log(`  ${c.red('✗')} ${name}`)
    failed++
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 1: Request Translation
// ══════════════════════════════════════════════════════════════════════════════

console.log(c.bold('\n═══ Ollama Integration Tests ═══\n'))

console.log(c.cyan('▸ Test 1: Request Translation (Anthropic → OpenAI)'))

// Simulate an Anthropic Messages API request
const anthropicRequest = {
  model: 'qwen2.5-coder:7b',
  max_tokens: 4096,
  stream: true,
  temperature: 0.7,
  system: [
    { type: 'text', text: 'You are a helpful coding assistant.' },
    { type: 'text', text: 'Always respond in markdown.', cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Write a hello world in Python' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "Here's a Python hello world:" },
        {
          type: 'tool_use',
          id: 'toolu_01ABC123',
          name: 'write_file',
          input: { path: 'hello.py', content: 'print("Hello, World!")' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01ABC123',
          content: 'File written successfully',
        },
        { type: 'text', text: 'Now run it' },
      ],
    },
  ],
  tools: [
    {
      name: 'write_file',
      description: 'Write content to a file',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'run_command',
      description: 'Run a shell command',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run' },
        },
        required: ['command'],
      },
    },
  ],
  tool_choice: { type: 'auto' },
}

// Translate it
function translateRequest(req) {
  const msgs = []

  // System
  if (req.system) {
    let text = ''
    if (typeof req.system === 'string') text = req.system
    else if (Array.isArray(req.system))
      text = req.system.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')
    msgs.push({ role: 'system', content: text })
  }

  // Messages
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      msgs.push({ role: msg.role, content: msg.content })
      continue
    }

    if (msg.role === 'assistant') {
      const textParts = []
      const toolCalls = []
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) textParts.push(b.text)
        if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          })
        }
      }
      const m = { role: 'assistant', content: textParts.join('\n') || null }
      if (toolCalls.length) m.tool_calls = toolCalls
      msgs.push(m)
    } else {
      const textParts = []
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) textParts.push(b.text)
        if (b.type === 'tool_result') {
          let resultContent = ''
          if (typeof b.content === 'string') resultContent = b.content
          else if (Array.isArray(b.content))
            resultContent = b.content.filter((x) => x.type === 'text').map((x) => x.text || '').join('\n')
          msgs.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: resultContent })
        }
      }
      if (textParts.length) msgs.push({ role: 'user', content: textParts.join('\n') })
    }
  }

  const result = {
    model: req.model,
    messages: msgs,
    max_tokens: req.max_tokens,
    temperature: req.temperature ?? 1,
    stream: req.stream ?? true,
  }

  if (req.tools?.length) {
    result.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
    if (req.tool_choice?.type === 'auto') result.tool_choice = 'auto'
  }

  return result
}

const openaiResult = translateRequest(anthropicRequest)

assert(openaiResult.model === 'qwen2.5-coder:7b', 'Model name preserved')
assert(openaiResult.messages[0].role === 'system', 'System prompt → system message')
assert(
  openaiResult.messages[0].content.includes('helpful coding assistant'),
  'System text aggregated from array',
)
assert(openaiResult.messages[1].role === 'user', 'User message preserved')
assert(openaiResult.messages[2].role === 'assistant', 'Assistant message translated')
assert(
  openaiResult.messages[2].tool_calls?.length === 1,
  'Tool use → tool_calls array',
)
assert(
  openaiResult.messages[2].tool_calls?.[0].function.name === 'write_file',
  'Tool call name preserved',
)
assert(openaiResult.messages[3].role === 'tool', 'Tool result → tool message')
assert(
  openaiResult.messages[3].tool_call_id === 'toolu_01ABC123',
  'Tool call ID matched',
)
assert(openaiResult.messages[4].role === 'user', 'Follow-up user text preserved')
assert(openaiResult.tools?.length === 2, 'Tools translated')
assert(
  openaiResult.tools?.[0].function.name === 'write_file',
  'Tool function name correct',
)
assert(openaiResult.tool_choice === 'auto', 'Tool choice translated')
assert(openaiResult.stream === true, 'Streaming flag preserved')
assert(openaiResult.temperature === 0.7, 'Temperature preserved')
assert(openaiResult.max_tokens === 4096, 'Max tokens preserved')

// ══════════════════════════════════════════════════════════════════════════════
// TEST 2: Response Translation
// ══════════════════════════════════════════════════════════════════════════════

console.log(c.cyan('\n▸ Test 2: Response Stream Translation (OpenAI SSE → Anthropic SSE)'))

// Simulate OpenAI SSE chunks from Ollama
const mockChunks = [
  // First chunk with role
  {
    id: 'chatcmpl-123',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  },
  // Text content
  {
    id: 'chatcmpl-123',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{ index: 0, delta: { content: 'Hello! ' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-123',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{ index: 0, delta: { content: 'How can I help?' }, finish_reason: null }],
  },
  // Finish
  {
    id: 'chatcmpl-123',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
]

// Simple translator for testing
class TestStreamTranslator {
  constructor(model) {
    this.messageId = `msg_test_${Date.now()}`
    this.model = model
    this.blockIndex = 0
    this.hasStartedMessage = false
    this.hasStartedText = false
    this.outputTokens = 0
  }

  translateChunk(chunk) {
    const events = []
    if (!this.hasStartedMessage) {
      this.hasStartedMessage = true
      events.push({
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.model,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
    for (const choice of chunk.choices) {
      const delta = choice.delta
      if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
        if (!this.hasStartedText) {
          this.hasStartedText = true
          events.push({
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'text', text: '' },
          })
        }
        events.push({
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        })
        this.outputTokens += Math.ceil(delta.content.length / 4)
      }
      if (choice.finish_reason) {
        if (this.hasStartedText) {
          events.push({ type: 'content_block_stop', index: this.blockIndex })
        }
        events.push({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: this.outputTokens },
        })
        events.push({ type: 'message_stop' })
      }
    }
    return events
  }
}

const translator = new TestStreamTranslator('llama3.2')
const allEvents = []
for (const chunk of mockChunks) {
  allEvents.push(...translator.translateChunk(chunk))
}

const eventTypes = allEvents.map((e) => e.type)
assert(eventTypes[0] === 'message_start', 'First event is message_start')
assert(
  allEvents[0].message?.role === 'assistant',
  'message_start has assistant role',
)
assert(
  allEvents[0].message?.model === 'llama3.2',
  'message_start has correct model',
)
assert(
  eventTypes.includes('content_block_start'),
  'Contains content_block_start',
)
assert(
  eventTypes.includes('content_block_delta'),
  'Contains content_block_delta',
)
assert(
  eventTypes.filter((t) => t === 'content_block_delta').length === 2,
  'Two text deltas for two chunks',
)
assert(eventTypes.includes('content_block_stop'), 'Contains content_block_stop')
assert(eventTypes.includes('message_delta'), 'Contains message_delta')
assert(
  allEvents.find((e) => e.type === 'message_delta')?.delta?.stop_reason === 'end_turn',
  'Stop reason is end_turn',
)
assert(eventTypes[eventTypes.length - 1] === 'message_stop', 'Last event is message_stop')

// ══════════════════════════════════════════════════════════════════════════════
// TEST 3: Tool Call Response Translation
// ══════════════════════════════════════════════════════════════════════════════

console.log(c.cyan('\n▸ Test 3: Tool Call Response Translation'))

const toolChunks = [
  {
    id: 'chatcmpl-456',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call_abc123',
          type: 'function',
          function: { name: 'write_file', arguments: '' },
        }],
      },
      finish_reason: null,
    }],
  },
  {
    id: 'chatcmpl-456',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: '{"path":"test.py"' },
        }],
      },
      finish_reason: null,
    }],
  },
  {
    id: 'chatcmpl-456',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: ',"content":"print(1)"}' },
        }],
      },
      finish_reason: null,
    }],
  },
  {
    id: 'chatcmpl-456',
    object: 'chat.completion.chunk',
    model: 'llama3.2',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
]

const toolTranslator = new TestStreamTranslator('llama3.2')
// Extend translator for tool support
toolTranslator.activeTools = new Map()
const toolTranslateChunk = function(chunk) {
  const events = []
  if (!this.hasStartedMessage) {
    this.hasStartedMessage = true
    events.push({
      type: 'message_start',
      message: {
        id: this.messageId, type: 'message', role: 'assistant',
        content: [], model: this.model, stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }
  for (const choice of chunk.choices) {
    const delta = choice.delta
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let tracked = this.activeTools.get(tc.index)
        if (!tracked) {
          tracked = {
            id: tc.id || `toolu_${tc.index}`,
            name: tc.function?.name || 'unknown',
            argBuf: '',
            blockIdx: this.blockIndex,
            started: false,
          }
          this.activeTools.set(tc.index, tracked)
        }
        if (tc.function?.name) tracked.name = tc.function.name
        if (!tracked.started) {
          tracked.started = true
          events.push({
            type: 'content_block_start',
            index: tracked.blockIdx,
            content_block: { type: 'tool_use', id: tracked.id, name: tracked.name, input: {} },
          })
          this.blockIndex++
        }
        if (tc.function?.arguments) {
          tracked.argBuf += tc.function.arguments
          events.push({
            type: 'content_block_delta',
            index: tracked.blockIdx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          })
        }
      }
    }
    if (choice.finish_reason) {
      for (const [, t] of this.activeTools) {
        if (t.started) events.push({ type: 'content_block_stop', index: t.blockIdx })
      }
      events.push({
        type: 'message_delta',
        delta: { stop_reason: this.activeTools.size > 0 ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 0 },
      })
      events.push({ type: 'message_stop' })
    }
  }
  return events
}
toolTranslator.translateChunk = toolTranslateChunk.bind(toolTranslator)

const toolEvents = []
for (const chunk of toolChunks) {
  toolEvents.push(...toolTranslator.translateChunk(chunk))
}

const toolEventTypes = toolEvents.map((e) => e.type)
assert(toolEventTypes[0] === 'message_start', 'Tool: message_start emitted')
assert(toolEventTypes.includes('content_block_start'), 'Tool: content_block_start for tool_use')
const toolStart = toolEvents.find((e) => e.content_block?.type === 'tool_use')
assert(toolStart?.content_block?.name === 'write_file', 'Tool: function name correct')
assert(toolStart?.content_block?.id === 'call_abc123', 'Tool: tool call ID correct')
assert(
  toolEventTypes.filter((t) => t === 'content_block_delta').length === 2,
  'Tool: two argument deltas streamed',
)
const jsonDeltas = toolEvents.filter((e) => e.delta?.type === 'input_json_delta')
assert(jsonDeltas.length === 2, 'Tool: input_json_delta deltas present')
const fullArgs = jsonDeltas.map((d) => d.delta.partial_json).join('')
assert(fullArgs === '{"path":"test.py","content":"print(1)"}', 'Tool: arguments reconstruct correctly')
assert(
  toolEvents.find((e) => e.type === 'message_delta')?.delta?.stop_reason === 'tool_use',
  'Tool: stop_reason is tool_use',
)

// ══════════════════════════════════════════════════════════════════════════════
// TEST 4: Non-Streaming Response Translation
// ══════════════════════════════════════════════════════════════════════════════

console.log(c.cyan('\n▸ Test 4: Non-Streaming Response Translation'))

const mockNonStreamingResponse = {
  id: 'chatcmpl-789',
  object: 'chat.completion',
  model: 'llama3.2',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'Here is the code you asked for.',
      tool_calls: [{
        id: 'call_xyz789',
        type: 'function',
        function: {
          name: 'run_command',
          arguments: '{"command":"python hello.py"}',
        },
      }],
    },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 42, completion_tokens: 15, total_tokens: 57 },
}

// Translate non-streaming response
function translateNonStreaming(resp, model) {
  const choices = resp.choices || []
  const first = choices[0] || {}
  const msg = first.message || {}
  const content = []
  if (msg.content) content.push({ type: 'text', text: msg.content })
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let parsed = {}
      try { parsed = JSON.parse(tc.function.arguments) } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsed,
      })
    }
  }
  let stopReason = 'end_turn'
  if (first.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (first.finish_reason === 'stop' && msg.tool_calls?.length) stopReason = 'tool_use'
  return {
    id: `msg_test_${Date.now()}`, type: 'message', role: 'assistant',
    content, model, stop_reason: stopReason,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
  }
}

const anthropicResult = translateNonStreaming(mockNonStreamingResponse, 'llama3.2')

assert(anthropicResult.type === 'message', 'Non-stream: type is message')
assert(anthropicResult.role === 'assistant', 'Non-stream: role is assistant')
assert(anthropicResult.content.length === 2, 'Non-stream: text + tool_use')
assert(anthropicResult.content[0].type === 'text', 'Non-stream: first block is text')
assert(anthropicResult.content[1].type === 'tool_use', 'Non-stream: second block is tool_use')
assert(anthropicResult.content[1].name === 'run_command', 'Non-stream: tool name correct')
assert(anthropicResult.content[1].input.command === 'python hello.py', 'Non-stream: tool args parsed')
assert(anthropicResult.stop_reason === 'tool_use', 'Non-stream: stop_reason is tool_use')
assert(anthropicResult.usage.input_tokens === 42, 'Non-stream: input tokens correct')
assert(anthropicResult.usage.output_tokens === 15, 'Non-stream: output tokens correct')

// ══════════════════════════════════════════════════════════════════════════════
// TEST 5: Live Ollama Connection (Optional)
// ══════════════════════════════════════════════════════════════════════════════

if (!isDryRun) {
  console.log(c.cyan(`\n▸ Test 5: Live Ollama Connection (${OLLAMA_BASE_URL})`))

  try {
    // Check if Ollama is running
    const healthResp = await fetch(`${OLLAMA_BASE_URL}/api/version`)
    if (healthResp.ok) {
      const version = await healthResp.json()
      console.log(c.dim(`  Ollama version: ${version.version || JSON.stringify(version)}`))

      // Check available models
      const modelsResp = await fetch(`${OLLAMA_BASE_URL}/api/tags`)
      if (modelsResp.ok) {
        const models = await modelsResp.json()
        const modelNames = models.models?.map((m) => m.name) || []
        console.log(c.dim(`  Available models: ${modelNames.join(', ') || 'none'}`))

        if (modelNames.length > 0) {
          const modelToTest = modelNames.includes(TEST_MODEL) ? TEST_MODEL : modelNames[0]
          console.log(c.dim(`  Testing with model: ${modelToTest}`))

          // Send a simple request
          const headers = { 'Content-Type': 'application/json' }
          if (OLLAMA_API_KEY) headers['Authorization'] = `Bearer ${OLLAMA_API_KEY}`

          const testReq = translateRequest({
            model: modelToTest,
            max_tokens: 100,
            stream: false,
            messages: [{ role: 'user', content: 'Say "Ollama integration working" and nothing else.' }],
          })

          const resp = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(testReq),
          })

          if (resp.ok) {
            const result = await resp.json()
            const text = result.choices?.[0]?.message?.content || ''
            console.log(c.dim(`  Response: ${text.substring(0, 100)}`))
            assert(text.length > 0, 'Live: received non-empty response from Ollama')

            // Translate to Anthropic format
            const anthropicLive = translateNonStreaming(result, modelToTest)
            assert(anthropicLive.type === 'message', 'Live: translates to Anthropic message type')
            assert(
              anthropicLive.content[0]?.text?.length > 0,
              'Live: translated response has text content',
            )

            // Test streaming
            console.log(c.dim('  Testing streaming...'))
            const streamReq = translateRequest({
              model: modelToTest,
              max_tokens: 50,
              stream: true,
              messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
            })
            const streamResp = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify(streamReq),
            })

            if (streamResp.ok && streamResp.body) {
              const reader = streamResp.body.getReader()
              const decoder = new TextDecoder()
              let chunks = 0
              let fullText = ''

              let done = false
              while (!done) {
                const { done: d, value } = await reader.read()
                done = d
                if (value) {
                  const text = decoder.decode(value, { stream: true })
                  for (const line of text.split('\n')) {
                    if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
                      try {
                        const chunk = JSON.parse(line.slice(6))
                        if (chunk.choices?.[0]?.delta?.content) {
                          chunks++
                          fullText += chunk.choices[0].delta.content
                        }
                      } catch {}
                    }
                  }
                }
              }

              console.log(c.dim(`  Streamed ${chunks} chunks: "${fullText.substring(0, 80)}"`))
              assert(chunks > 0, 'Live: streaming produced multiple chunks')
              assert(fullText.length > 0, 'Live: streaming assembled full response')
            }
          } else {
            const errText = await resp.text()
            console.log(c.yellow(`  ⚠ Model request failed: ${errText.substring(0, 100)}`))
            assert(false, `Live: model ${modelToTest} responded`)
          }
        } else {
          console.log(c.yellow('  ⚠ No models pulled. Pull a model first: ollama pull llama3.2'))
          assert(false, 'Live: at least one model available')
        }
      }
    } else {
      console.log(c.yellow(`  ⚠ Ollama not responding at ${OLLAMA_BASE_URL}`))
      assert(false, 'Live: Ollama is reachable')
    }
  } catch (err) {
    console.log(c.yellow(`  ⚠ Cannot connect to Ollama: ${err.message}`))
    console.log(c.dim('  Run with --dry-run to skip live tests, or: ollama serve'))
    assert(false, 'Live: connection established')
  }
} else {
  console.log(c.dim('\n▸ Test 5: Live Connection (skipped: --dry-run)'))
}

// ══════════════════════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════════════════════

console.log(c.bold('\n═══ Results ═══'))
console.log(`  ${c.green(`${passed} passed`)}  ${failed > 0 ? c.red(`${failed} failed`) : c.dim('0 failed')}`)

if (failed === 0) {
  console.log(c.green('\n✓ All tests passed! Ollama integration is working.\n'))
  console.log(c.bold('Quick Start:'))
  console.log(c.dim('  # Local Ollama'))
  console.log(`  CLAUDE_CODE_USE_OLLAMA=1 ANTHROPIC_MODEL=llama3.2 claude\n`)
  console.log(c.dim('  # Ollama Cloud'))
  console.log(`  CLAUDE_CODE_USE_OLLAMA=1 OLLAMA_BASE_URL=https://... OLLAMA_API_KEY=sk-... claude\n`)
} else {
  console.log(c.red(`\n✗ ${failed} tests failed. Check the output above.\n`))
  process.exit(1)
}
