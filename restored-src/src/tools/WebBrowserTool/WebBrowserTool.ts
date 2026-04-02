import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'

export const WebBrowserTool = buildTool({
  name: 'WebBrowser',
  searchHint: 'Automate a real browser tab via the OpenClaw extension',
  userFacingName() { return 'WebBrowser' },
  description(input: any) {
    return `Performing '${input.action}' via Chrome relay...`
  },
  getToolUseSummary(input: any) {
    return `Browser ${input.action}`
  },
  getActivityDescription(input: any) {
     return `Browser action: ${input.action}`
  },
  get inputSchema() {
    return z.object({
      action: z.enum(['open', 'snapshot', 'click', 'type']).describe('Action to perform'),
      url: z.string().optional().describe('URL to navigate to (for "open")'),
      selector: z.string().optional().describe('CSS selector to interact with'),
      index: z.number().optional().describe('Element ID from snapshot to interact with'),
      text: z.string().optional().describe('Text to type (for "type")')
    }) as any
  },
  get outputSchema() {
     return z.any() as any
  },
  isConcurrencySafe() { return false },
  isReadOnly() { return false },
  toAutoClassifierInput(input: any) {
     return `browser ${input.action}`
  },
  async checkPermissions() {
    return { behavior: 'allow' } as any
  },
  async prompt() {
    return `Use the WebBrowser tool to control a real Chrome session safely.`
  },
  async validateInput() {
    return { result: true }
  },
  async call(input: any) {
    const relayContext = (global as any).__browserRelayContext;
    if (!relayContext || !relayContext.activeSocket) {
       console.log('[WebBrowserTool] No active browser detected. Launching OpenClaw managed Chrome profile...');
       const { launchBrowser } = await import('./BrowserLauncher.js');
       await launchBrowser();
       
       if (!relayContext || !relayContext.activeSocket) {
         return { data: { 
           error: 'CRITICAL ERROR: Attempted to launch the browser, but the extension failed to connect to the relay. Please ensure Chrome is installed and the extension builds correctly.' 
         }};
       }
    }

    const id = Date.now().toString() + Math.random().toString();
    const payload = { id, ...input };

    return new Promise((resolve) => {
       relayContext.pendingRequests.set(id, {
         resolve: (val: any) => resolve({ data: val }),
         reject: (err: any) => resolve({ data: { error: err.message } })
       });

       try {
         relayContext.activeSocket.send(JSON.stringify(payload));
       } catch (err: any) {
         resolve({ data: { error: 'Failed to send: ' + err.message } });
       }

       // Map timeouts
       setTimeout(() => {
          if (relayContext.pendingRequests.has(id)) {
            relayContext.pendingRequests.delete(id);
            resolve({ data: { error: 'Timeout waiting for relay extension to respond within 15 seconds. Page may be stuck or loading.' } });
          }
       }, 15000);
    });
  },
  mapToolResultToToolResultBlockParam(res: any, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2),
    } as any
  },
  renderToolUseMessage(input: any) {
     return [ { type: 'text', text: `Browser ${input.action} executed.` } ]
  },
  renderToolUseProgressMessage(input: any) {
     return `Browser ${input.action}...`
  },
  renderToolResultMessage(res: any) {
     return [ { type: 'text', text: 'Result received.' } ]
  }
} as any);
