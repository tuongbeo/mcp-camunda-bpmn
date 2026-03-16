import { BpmnMcpAgent } from './agent.js';
import type { Env } from './types.js';

export { BpmnMcpAgent };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Accept, mcp-session-id',
        },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'mcp-camunda-bpmn',
        version: '1.0.0',
      });
    }

    // Streamable HTTP transport (/mcp) — Camunda 8.9+, Claude Code
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
      return BpmnMcpAgent.serve('/mcp', {
        binding: 'MCP_BPMN_AGENT',
      }).fetch(request, env, ctx);
    }

    // Legacy SSE transport (/sse) — Camunda 8.8, Claude Desktop
    if (url.pathname.startsWith('/sse')) {
      return BpmnMcpAgent.serveSSE('/sse', {
        binding: 'MCP_BPMN_AGENT',
      }).fetch(request, env, ctx);
    }

    return new Response(
      JSON.stringify({ error: 'Not found. Use /mcp or /sse endpoints.' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  },
};
