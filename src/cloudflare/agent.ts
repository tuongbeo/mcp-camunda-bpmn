import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env, BpmnState, CurrentDiagram, BpmnElement, BpmnConnection } from './types.js';
import {
  generateId,
  generateXml,
  parseXmlToState,
  applyAutoLayout,
  resolveEventType,
  resolveActivityType,
  resolveGatewayType,
  getSize,
} from './bpmn-builder.js';

interface DmnColumn { expression?: string; name?: string; label: string; type?: string; }
interface DmnState { name: string; decisionId: string; inputs: DmnColumn[]; outputs: DmnColumn[]; rules: string[][]; xml: string; }

function esc(str: string): string {
  return (str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class BpmnMcpAgent extends McpAgent<Env, BpmnState> {
  server = new McpServer({ name: 'mcp-camunda-bpmn', version: '1.0.0' });
  initialState: BpmnState = { currentDiagram: null };

  async init(): Promise<void> {
    this.registerDiagramLifecycleTools();
    this.registerElementTools();
    this.registerCamunda8Tools();
    this.registerQueryTools();
    this.registerFileTools();
    this.registerAdvancedTools();
    this.registerDmnTools();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getDiagram(): CurrentDiagram {
    const d = this.state.currentDiagram;
    if (!d) throw new Error('No diagram open. Use new_bpmn to create one, or open_bpmn to load an existing one.');
    return d;
  }

  private async saveDiagram(diagram: CurrentDiagram): Promise<void> {
    await this.setState({ currentDiagram: { ...diagram, xml: generateXml(diagram), lastModified: new Date().toISOString() } });
  }

  private async patchElementProps(elementId: string, props: Record<string, unknown>) {
    const d = this.getDiagram();
    const el = d.elements[elementId];
    if (!el) return this.err(`Element "${elementId}" not found. Use list_elements to see available IDs.`);
    const updated: BpmnElement = { ...el, properties: { ...el.properties, ...props } };
    await this.saveDiagram({ ...d, elements: { ...d.elements, [elementId]: updated } });
    return this.ok(`Updated ${el.type.replace('bpmn:', '')} "${el.name || elementId}".`);
  }

  private nextPosition(elements: Record<string, BpmnElement>): { x: number; y: number } {
    const count = Object.keys(elements).length;
    return { x: Math.min(100 + count * 160, 1400), y: 200 + Math.floor(count / 9) * 200 };
  }

  private ok(text: string) { return { content: [{ type: 'text' as const, text }] }; }
  private err(text: string) { return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const }; }

  // ── Validation ────────────────────────────────────────────────────────────

  private runValidation(d: CurrentDiagram): string {
    const errors: string[] = [];
    const warnings: string[] = [];
    const els = Object.values(d.elements);
    const conns = Object.values(d.connections);
    const connected = new Set([...conns.map(c => c.source), ...conns.map(c => c.target)]);
    const starts = els.filter(e => e.type === 'bpmn:StartEvent');
    const ends = els.filter(e => e.type === 'bpmn:EndEvent');
    if (starts.length === 0) errors.push('Missing Start Event.');
    if (starts.length > 1) warnings.push(`${starts.length} Start Events found.`);
    if (ends.length === 0) errors.push('Missing End Event.');
    for (const el of els) {
      if (!['bpmn:StartEvent', 'bpmn:EndEvent'].includes(el.type) && !connected.has(el.id))
        warnings.push(`"${el.name || el.id}" (${el.type.replace('bpmn:', '')}) is disconnected.`);
    }
    const lines = [`Validation: ${d.name}`];
    if (!errors.length && !warnings.length) return lines.concat('✅ No issues found.').join('\n');
    if (errors.length) lines.push(`\n❌ Errors (${errors.length}):`, ...errors.map(e => `  - ${e}`));
    if (warnings.length) lines.push(`\n⚠️  Warnings (${warnings.length}):`, ...warnings.map(w => `  - ${w}`));
    return lines.join('\n');
  }

  private runCamunda8Validation(d: CurrentDiagram): string {
    const errors: string[] = [];
    const warnings: string[] = [];
    const conns = Object.values(d.connections);
    for (const el of Object.values(d.elements)) {
      const p = el.properties;
      const n = `"${el.name || el.id}"`;
      if (el.type === 'bpmn:ServiceTask' && !p.zeebeTaskType)
        errors.push(`Service Task ${n} missing zeebe:taskDefinition. Use set_zeebe_task_definition.`);
      if (el.type === 'bpmn:UserTask' && !p.assignee && !p.candidateGroups)
        warnings.push(`User Task ${n} has no assignee/candidateGroups. Use set_user_task.`);
      if (el.type === 'bpmn:CallActivity' && !p.calledElement)
        errors.push(`Call Activity ${n} missing zeebe:calledElement. Use set_call_activity.`);
      if (el.type === 'bpmn:BusinessRuleTask' && !p.decisionId)
        errors.push(`Business Rule Task ${n} missing zeebe:calledDecision. Use set_business_rule_task.`);
      if (el.type === 'bpmn:ExclusiveGateway') {
        const out = conns.filter(c => c.source === el.id);
        if (out.length > 1 && !out.some(c => c.condition))
          warnings.push(`Exclusive Gateway ${n} has ${out.length} outgoing flows without FEEL conditions.`);
      }
      if (p.eventDefinition === 'timer' && !p.timerDuration && !p.timerCycle && !p.timerDate)
        errors.push(`Timer event ${n} has no timer value. Use set_timer_event.`);
      if (p.eventDefinition === 'message' && !p.messageName)
        errors.push(`Message event ${n} has no messageName. Use set_message.`);
    }
    const lines = [`Camunda 8 Validation: ${d.name}`];
    if (!errors.length && !warnings.length) return lines.concat('✅ All Camunda 8 rules satisfied.').join('\n');
    if (errors.length) lines.push(`\n❌ Errors (${errors.length}):`, ...errors.map(e => `  - ${e}`));
    if (warnings.length) lines.push(`\n⚠️  Warnings (${warnings.length}):`, ...warnings.map(w => `  - ${w}`));
    return lines.join('\n');
  }

  // ── GROUP 1: Diagram Lifecycle ────────────────────────────────────────────

  private registerDiagramLifecycleTools(): void {
    this.server.registerTool('new_bpmn', {
      title: 'Create New BPMN Diagram',
      description: 'Create a new BPMN process or collaboration diagram. Sets it as the active working context.',
      inputSchema: z.object({
        name: z.string().describe('Diagram name (e.g., "Order Process")'),
        type: z.enum(['process', 'collaboration']).default('process'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ name, type = 'process' }) => {
      try {
        const processId = generateId('Process');
        const diagram: CurrentDiagram = { processId, name, type, xml: '', filename: null, lastModified: new Date().toISOString(), elements: {}, connections: {} };
        diagram.xml = generateXml(diagram);
        await this.setState({ currentDiagram: diagram });
        return this.ok(`Created ${type} diagram: "${name}" (${processId})\nNext: add_event → add_activity → connect → export`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('open_bpmn', {
      title: 'Open Stored BPMN Diagram',
      description: 'Load a BPMN diagram from KV storage and set as current context.',
      inputSchema: z.object({ filename: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ filename }) => {
      try {
        // Normalize: try exact filename first, then with .bpmn appended, then without extension
        const candidates = [
          filename,
          filename.endsWith('.bpmn') ? filename : `${filename}.bpmn`,
          filename.replace(/\.bpmn$/, ''),
        ];
        let xml: string | null = null;
        let resolvedFilename = filename;
        for (const candidate of candidates) {
          xml = await this.env.BPMN_FILES.get(`bpmn:${candidate}`);
          if (xml) { resolvedFilename = candidate; break; }
        }
        if (!xml) return this.err(`"${filename}" not found. Use list_diagrams.`);
        const p = parseXmlToState(xml);
        const diagram: CurrentDiagram = {
          processId: p.processId ?? generateId('Process'),
          name: p.name ?? resolvedFilename.replace('.bpmn', ''),
          type: 'process', xml,
          filename: resolvedFilename,
          lastModified: new Date().toISOString(),
          elements: p.elements ?? {},
          connections: p.connections ?? {},
        };
        await this.setState({ currentDiagram: diagram });
        return this.ok(`Opened "${resolvedFilename}": ${Object.keys(diagram.elements).length} elements, ${Object.keys(diagram.connections).length} connections.`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('save_as', {
      title: 'Save Diagram to KV Storage',
      description: 'Persist the current diagram to KV storage under a given filename.',
      inputSchema: z.object({ filename: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ filename }) => {
      try {
        const d = this.getDiagram();
        const fn = filename.endsWith('.bpmn') ? filename : `${filename}.bpmn`;
        // Always regenerate XML from in-memory state to ensure all Zeebe properties are serialized
        const freshXml = generateXml(d);
        await this.env.BPMN_FILES.put(`bpmn:${fn}`, freshXml);
        await this.setState({ currentDiagram: { ...d, filename: fn, xml: freshXml } });
        return this.ok(`Saved "${d.name}" → "${fn}".`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('export', {
      title: 'Export BPMN 2.0 XML',
      description: 'Return the current diagram as BPMN 2.0 XML. Ready for Camunda Modeler import or Zeebe deployment.',
      inputSchema: z.object({ formatted: z.boolean().default(true) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async () => {
      try { return this.ok(this.getDiagram().xml); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('current', {
      title: 'Show Current Diagram Info',
      description: 'Display summary of the current diagram: name, ID, element counts, filename.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async () => {
      try {
        const d = this.getDiagram();
        return this.ok([
          `📋 ${d.name}`,
          `  Process ID : ${d.processId}`,
          `  Type       : ${d.type}`,
          `  Elements   : ${Object.keys(d.elements).length}`,
          `  Connections: ${Object.keys(d.connections).length}`,
          `  File       : ${d.filename ?? '(unsaved)'}`,
          `  Modified   : ${d.lastModified}`,
        ].join('\n'));
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('new_from_mermaid', {
      title: 'Create BPMN from Mermaid Flowchart',
      description: 'Convert a Mermaid flowchart (graph LR / flowchart TD) into a BPMN diagram.',
      inputSchema: z.object({ name: z.string(), mermaidCode: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ name, mermaidCode }) => {
      try {
        const processId = generateId('Process');
        const elements: Record<string, BpmnElement> = {};
        const connections: Record<string, BpmnConnection> = {};
        const mermaidToId: Record<string, string> = {};
        const SKIP = new Set(['flowchart', 'graph', 'LR', 'TD', 'RL', 'BT', 'subgraph', 'end', 'direction']);

        const nodeRegex = /^\s*([A-Za-z0-9_]+)\s*(?:\[([^\]]*)\]|\(\(([^)]*)\)\)|{([^}]*)}|(\([^)]*\)))?/gm;
        let m: RegExpExecArray | null;
        while ((m = nodeRegex.exec(mermaidCode)) !== null) {
          const mid = m[1]; if (SKIP.has(mid) || mermaidToId[mid]) continue;
          const label = (m[2] ?? m[3] ?? m[4] ?? mid).trim();
          const type = m[3] ? 'bpmn:StartEvent' : m[4] ? 'bpmn:ExclusiveGateway' : label.toLowerCase().includes('end') ? 'bpmn:EndEvent' : 'bpmn:Task';
          const elId = generateId(type.split(':')[1]);
          mermaidToId[mid] = elId;
          elements[elId] = { id: elId, type, name: label, position: { x: 100, y: 200 }, size: getSize(type), properties: {} };
        }
        const edgeRegex = /([A-Za-z0-9_]+)\s*-+>?\|?([^|\n]*?)\|?\s*([A-Za-z0-9_]+)/g;
        while ((m = edgeRegex.exec(mermaidCode)) !== null) {
          const s = mermaidToId[m[1]]; const t = mermaidToId[m[3]]; const lbl = m[2].replace(/[|>-]/g, '').trim();
          if (s && t && s !== t) { const cid = generateId('Flow'); connections[cid] = { id: cid, source: s, target: t, label: lbl || undefined, type: 'bpmn:SequenceFlow' }; }
        }
        const laidOut = applyAutoLayout(elements, connections);
        const diagram: CurrentDiagram = { processId, name, type: 'process', xml: '', filename: null, lastModified: new Date().toISOString(), elements: laidOut, connections };
        diagram.xml = generateXml(diagram);
        await this.setState({ currentDiagram: diagram });
        return this.ok(`Created BPMN from Mermaid: "${name}" — ${Object.keys(elements).length} elements.`);
      } catch (e) { return this.err((e as Error).message); }
    });
  }

  // ── GROUP 2: BPMN Elements ────────────────────────────────────────────────

  private registerElementTools(): void {
    this.server.registerTool('add_event', {
      title: 'Add BPMN Event',
      description: 'Add Start/End/Intermediate/Boundary event. eventType: start|end|intermediate-throw|intermediate-catch|boundary. eventDefinition: message|timer|error|signal|escalation|compensation|conditional|terminate.',
      inputSchema: z.object({
        eventType: z.enum(['start', 'end', 'intermediate-throw', 'intermediate-catch', 'boundary']),
        name: z.string().optional(),
        eventDefinition: z.enum(['message', 'timer', 'error', 'signal', 'escalation', 'compensation', 'conditional', 'terminate']).optional(),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ eventType, name, eventDefinition, position }) => {
      try {
        const d = this.getDiagram();
        const type = resolveEventType(eventType, eventDefinition);
        const id = generateId(type.split(':')[1]);
        const element: BpmnElement = { id, type, name: name ?? '', position: position ?? this.nextPosition(d.elements), size: getSize(type), properties: eventDefinition ? { eventDefinition } : {} };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [id]: element } });
        return this.ok(`Added ${eventType}${eventDefinition ? ` (${eventDefinition})` : ''} event: "${name ?? ''}" → ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_activity', {
      title: 'Add Task or Sub-Process',
      description: 'Add a task/sub-process. activityType: task|userTask|serviceTask|scriptTask|sendTask|receiveTask|businessRuleTask|manualTask|callActivity|subProcess|adHocSubProcess.',
      inputSchema: z.object({
        activityType: z.string(),
        name: z.string(),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        properties: z.record(z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ activityType, name, position, properties }) => {
      try {
        const d = this.getDiagram();
        const type = resolveActivityType(activityType);
        const id = generateId(activityType);
        const element: BpmnElement = { id, type, name, position: position ?? this.nextPosition(d.elements), size: getSize(type), properties: properties ?? {} };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [id]: element } });
        return this.ok(`Added ${activityType}: "${name}" → ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_gateway', {
      title: 'Add Gateway',
      description: 'Add a gateway. Types: exclusive (XOR/decision), parallel (AND/fork-join), inclusive (OR), eventBased, complexGateway.',
      inputSchema: z.object({
        gatewayType: z.enum(['exclusive', 'parallel', 'inclusive', 'eventBased', 'complexGateway']),
        name: z.string().optional(),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ gatewayType, name, position }) => {
      try {
        const d = this.getDiagram();
        const type = resolveGatewayType(gatewayType);
        const id = generateId(gatewayType + 'Gateway');
        const element: BpmnElement = { id, type, name: name ?? '', position: position ?? this.nextPosition(d.elements), size: getSize(type), properties: {} };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [id]: element } });
        return this.ok(`Added ${gatewayType} gateway: "${name ?? ''}" → ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('connect', {
      title: 'Connect Elements with Sequence Flow',
      description: 'Add a sequence flow between two elements. Use condition (FEEL expression) for flows leaving exclusive gateways.',
      inputSchema: z.object({
        sourceId: z.string(),
        targetId: z.string(),
        label: z.string().optional().describe('Flow label e.g. "Approved"'),
        condition: z.string().optional().describe('FEEL condition e.g. "= amount > 1000"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ sourceId, targetId, label, condition }) => {
      try {
        const d = this.getDiagram();
        if (!d.elements[sourceId]) return this.err(`Source "${sourceId}" not found.`);
        if (!d.elements[targetId]) return this.err(`Target "${targetId}" not found.`);
        const id = generateId('Flow');
        await this.saveDiagram({ ...d, connections: { ...d.connections, [id]: { id, source: sourceId, target: targetId, label, condition, type: 'bpmn:SequenceFlow' } } });
        return this.ok(`Connected ${sourceId} → ${targetId}${label ? ` [${label}]` : ''} → Flow ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_pool', {
      title: 'Add Pool (Participant)',
      description: 'Add a Pool/Participant to a collaboration diagram.',
      inputSchema: z.object({ name: z.string(), position: z.object({ x: z.number(), y: z.number() }).optional(), size: z.object({ width: z.number(), height: z.number() }).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ name, position, size }) => {
      try {
        const d = this.getDiagram();
        const id = generateId('Participant');
        const element: BpmnElement = { id, type: 'bpmn:Participant', name, position: position ?? { x: 100, y: 100 }, size: size ?? { width: 600, height: 200 }, properties: {} };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [id]: element } });
        return this.ok(`Added pool: "${name}" → ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_lane', {
      title: 'Add Lane to Pool',
      description: 'Add a Lane inside a Pool to organise tasks by role or department.',
      inputSchema: z.object({ poolId: z.string(), name: z.string(), position: z.object({ x: z.number(), y: z.number() }).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ poolId, name, position }) => {
      try {
        const d = this.getDiagram();
        if (!d.elements[poolId]) return this.err(`Pool "${poolId}" not found.`);
        const pool = d.elements[poolId];
        const id = generateId('Lane');
        const element: BpmnElement = { id, type: 'bpmn:Lane', name, position: position ?? { x: pool.position.x + 30, y: pool.position.y + 30 }, size: { width: (pool.size?.width ?? 600) - 30, height: 100 }, properties: { parentId: poolId } };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [id]: element } });
        return this.ok(`Added lane "${name}" in pool "${poolId}" → ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_message_flow', {
      title: 'Add Message Flow between Pools',
      description: 'Connect elements in different pools with a Message Flow (dashed arrow in collaboration diagrams).',
      inputSchema: z.object({ sourceId: z.string(), targetId: z.string(), name: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ sourceId, targetId, name }) => {
      try {
        const d = this.getDiagram();
        if (!d.elements[sourceId]) return this.err(`Source "${sourceId}" not found.`);
        if (!d.elements[targetId]) return this.err(`Target "${targetId}" not found.`);
        const id = generateId('MessageFlow');
        await this.saveDiagram({ ...d, connections: { ...d.connections, [id]: { id, source: sourceId, target: targetId, label: name, type: 'bpmn:MessageFlow' } } });
        return this.ok(`Added message flow: ${sourceId} → ${targetId} → ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_subprocess', {
      title: 'Add Sub-Process',
      description: 'Add an Expanded or Collapsed Sub-Process to the diagram.',
      inputSchema: z.object({ name: z.string(), expanded: z.boolean().default(true), position: z.object({ x: z.number(), y: z.number() }).optional(), size: z.object({ width: z.number(), height: z.number() }).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ name, expanded = true, position, size }) => {
      try {
        const d = this.getDiagram();
        const id = generateId('SubProcess');
        const element: BpmnElement = { id, type: 'bpmn:SubProcess', name, position: position ?? this.nextPosition(d.elements), size: size ?? (expanded ? { width: 350, height: 200 } : { width: 100, height: 80 }), properties: { isExpanded: expanded } };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [id]: element } });
        return this.ok(`Added ${expanded ? 'expanded' : 'collapsed'} sub-process: "${name}" → ID: ${id}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_adhoc_subprocess', {
      title: 'Add Ad-hoc Sub-Process',
      description: 'Add an Ad-hoc Sub-Process — ideal for AI Agent tool containers in Camunda 8 agentic workflows (zeebe:adHocSubProcessOutbound).',
      inputSchema: z.object({ name: z.string(), position: z.object({ x: z.number(), y: z.number() }).optional(), size: z.object({ width: z.number(), height: z.number() }).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ name, position, size }) => {
      try {
        const d = this.getDiagram();
        const id = generateId('AdHocSubProcess');
        const element: BpmnElement = { id, type: 'bpmn:AdHocSubProcess', name, position: position ?? this.nextPosition(d.elements), size: size ?? { width: 350, height: 200 }, properties: { adHocOutbound: true } };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [id]: element } });
        return this.ok(`Added ad-hoc sub-process: "${name}" → ID: ${id}\nTip: Add MCP Client connector tasks inside for AI agent tool access.`);
      } catch (e) { return this.err((e as Error).message); }
    });
  }

  // ── GROUP 3: Camunda 8 / Zeebe Properties ────────────────────────────────

  private registerCamunda8Tools(): void {
    this.server.registerTool('set_zeebe_task_definition', {
      title: 'Set Zeebe Task Definition',
      description: 'Required for all Service Tasks in Camunda 8. Sets the job type workers subscribe to. Example: type="payment-service".',
      inputSchema: z.object({ elementId: z.string(), type: z.string().describe('Job type e.g. "payment-service"'), retries: z.number().int().min(1).default(3) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, type, retries }) => {
      try { return await this.patchElementProps(elementId, { zeebeTaskType: type, zeebeRetries: retries }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_zeebe_task_headers', {
      title: 'Set Zeebe Task Headers',
      description: 'Set zeebe:taskHeaders key-value metadata passed to job workers.',
      inputSchema: z.object({ elementId: z.string(), headers: z.array(z.object({ key: z.string(), value: z.string() })) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, headers }) => {
      try { return await this.patchElementProps(elementId, { zeebeHeaders: headers }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_zeebe_io_mapping', {
      title: 'Set Zeebe IO Variable Mapping',
      description: 'Configure zeebe:ioMapping input/output variable mappings with FEEL expressions.',
      inputSchema: z.object({
        elementId: z.string(),
        inputs: z.array(z.object({ source: z.string().describe('FEEL source e.g. "=amount"'), target: z.string() })).optional(),
        outputs: z.array(z.object({ source: z.string().describe('FEEL source e.g. "=result"'), target: z.string() })).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, inputs, outputs }) => {
      try { return await this.patchElementProps(elementId, { zeebeInputs: inputs ?? [], zeebeOutputs: outputs ?? [] }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_user_task', {
      title: 'Configure Camunda User Task',
      description: 'Configure User Task assignment (assignee, candidateGroups), scheduling (dueDate), and form. Camunda 8 native type recommended from 8.8+.',
      inputSchema: z.object({
        elementId: z.string(),
        assignee: z.string().optional().describe('FEEL assignee e.g. "= initiator"'),
        candidateGroups: z.string().optional().describe('Comma-separated groups e.g. "managers,finance"'),
        priority: z.string().optional(),
        dueDate: z.string().optional().describe('FEEL date e.g. "= now() + duration(\\"P7D\\")"'),
        followUpDate: z.string().optional(),
        formId: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, assignee, candidateGroups, priority, dueDate, followUpDate, formId }) => {
      try {
        const props: Record<string, unknown> = {};
        if (assignee) props.assignee = assignee;
        if (candidateGroups) props.candidateGroups = candidateGroups;
        if (priority) props.priority = priority;
        if (dueDate) props.dueDate = dueDate;
        if (followUpDate) props.followUpDate = followUpDate;
        if (formId) props.formId = formId;
        return await this.patchElementProps(elementId, props);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_call_activity', {
      title: 'Configure Call Activity',
      description: 'Set zeebe:calledElement to invoke a child process by ID.',
      inputSchema: z.object({ elementId: z.string(), processId: z.string(), propagateAllVariables: z.boolean().default(true) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, processId, propagateAllVariables }) => {
      try { return await this.patchElementProps(elementId, { calledElement: processId, propagateAllVariables }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_business_rule_task', {
      title: 'Configure Business Rule Task (DMN)',
      description: 'Set zeebe:calledDecision to invoke a DMN decision table.',
      inputSchema: z.object({ elementId: z.string(), decisionId: z.string(), resultVariable: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, decisionId, resultVariable }) => {
      try { return await this.patchElementProps(elementId, { decisionId, resultVariable }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_script_task', {
      title: 'Configure Script Task (FEEL)',
      description: 'Set FEEL expression for a Script Task.',
      inputSchema: z.object({ elementId: z.string(), expression: z.string(), resultVariable: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, expression, resultVariable }) => {
      try { return await this.patchElementProps(elementId, { scriptExpression: expression, scriptResultVariable: resultVariable }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_timer_event', {
      title: 'Configure Timer Event',
      description: 'Set timer definition: duration (PT1H), cycle (R/PT1H), or date (ISO 8601). All support FEEL expressions.',
      inputSchema: z.object({ elementId: z.string(), timerType: z.enum(['duration', 'cycle', 'date']), timerValue: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, timerType, timerValue }) => {
      try {
        const d = this.getDiagram();
        const el = d.elements[elementId];
        if (!el) return this.err(`Element "${elementId}" not found.`);

        const timerPropKey = timerType === 'duration' ? 'timerDuration' : timerType === 'cycle' ? 'timerCycle' : 'timerDate';
        const props: Record<string, unknown> = { eventDefinition: 'timer', [timerPropKey]: timerValue };

        // If boundary timer event already has attachedToRef, snap position to host
        const attachedToRef = el.properties.attachedToRef as string | undefined;
        let updatedPosition = el.position;
        if (el.type === 'bpmn:BoundaryEvent' && attachedToRef) {
          const hostEl = d.elements[attachedToRef];
          if (hostEl) {
            const existingOnHost = Object.values(d.elements).filter(
              e => e.type === 'bpmn:BoundaryEvent'
                && e.properties.attachedToRef === attachedToRef
                && e.id !== elementId
            );
            const hSz = getSize(hostEl.type);
            const hW = hostEl.size?.width ?? hSz.width;
            const hH = hostEl.size?.height ?? hSz.height;
            updatedPosition = {
              x: hostEl.position.x + Math.round(hW * 0.25) + existingOnHost.length * 40,
              y: hostEl.position.y + hH - 18,
            };
          }
        }

        const updated = { ...el, position: updatedPosition, properties: { ...el.properties, ...props } };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [elementId]: updated } });
        return this.ok(`Updated BoundaryEvent "${el.name || elementId}".`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_message', {
      title: 'Configure Message Correlation',
      description: 'Set messageName and optional correlationKey for a Message event or Receive Task.',
      inputSchema: z.object({ elementId: z.string(), messageName: z.string(), correlationKey: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, messageName, correlationKey }) => {
      try { return await this.patchElementProps(elementId, { eventDefinition: 'message', messageRef: generateId('Message'), messageName, correlationKey }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_signal', {
      title: 'Configure Signal Event',
      description: 'Set signal name for a Signal Start/Intermediate/Boundary event.',
      inputSchema: z.object({ elementId: z.string(), signalName: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, signalName }) => {
      try { return await this.patchElementProps(elementId, { eventDefinition: 'signal', signalRef: generateId('Signal'), signalName }); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_error_boundary', {
      title: 'Configure Error Boundary Event',
      description: 'Attach an Error Boundary Event to a task/sub-process for exception handling.',
      inputSchema: z.object({ elementId: z.string(), hostElementId: z.string(), errorCode: z.string().optional(), errorMessage: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, hostElementId, errorCode, errorMessage }) => {
      try {
        const d = this.getDiagram();
        const hostEl = d.elements[hostElementId];
        if (!hostEl) return this.err(`Host element "${hostElementId}" not found.`);
        const boundaryEl = d.elements[elementId];
        if (!boundaryEl) return this.err(`Boundary event "${elementId}" not found.`);

        // Count existing boundary events on same host to offset X position
        const existingOnHost = Object.values(d.elements).filter(
          e => e.type === 'bpmn:BoundaryEvent'
            && e.properties.attachedToRef === hostElementId
            && e.id !== elementId
        );
        const hSz = getSize(hostEl.type);
        const hW = hostEl.size?.width ?? hSz.width;
        const hH = hostEl.size?.height ?? hSz.height;
        const newPosition = {
          x: hostEl.position.x + Math.round(hW * 0.25) + existingOnHost.length * 40,
          y: hostEl.position.y + hH - 18,
        };

        // Update both properties and position
        const updatedBoundary = {
          ...boundaryEl,
          position: newPosition,
          properties: {
            ...boundaryEl.properties,
            eventDefinition: 'error',
            attachedToRef: hostElementId,
            ...(errorCode ? { errorCode } : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
        };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [elementId]: updatedBoundary } });
        return this.ok(`Updated BoundaryEvent "${boundaryEl.name || elementId}".`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_multi_instance', {
      title: 'Set Multi-Instance Loop',
      description: 'Configure Multi-Instance loop on a task to iterate over a collection (zeebe:loopCharacteristics).',
      inputSchema: z.object({
        elementId: z.string(),
        isSequential: z.boolean(),
        inputCollection: z.string().describe('FEEL expression e.g. "= items"'),
        inputElement: z.string().describe('Loop variable e.g. "item"'),
        outputCollection: z.string().optional(),
        outputElement: z.string().optional().describe('FEEL output e.g. "= result"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, isSequential, inputCollection, inputElement, outputCollection, outputElement }) => {
      try {
        return await this.patchElementProps(elementId, { multiInstanceIsSequential: isSequential, multiInstanceInputCollection: inputCollection, multiInstanceInputElement: inputElement, multiInstanceOutputCollection: outputCollection, multiInstanceOutputElement: outputElement });
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_connector', {
      title: 'Configure Camunda Connector',
      description: 'Configure a Camunda Outbound Connector (REST, Slack, SendGrid, etc.) via zeebe:taskDefinition type + headers.',
      inputSchema: z.object({ elementId: z.string(), connectorType: z.string().describe('e.g. "io.camunda.connectors.HttpJson.v2"'), connectorProperties: z.record(z.string()).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, connectorType, connectorProperties }) => {
      try {
        const headers = Object.entries(connectorProperties ?? {}).map(([key, value]) => ({ key, value }));
        return await this.patchElementProps(elementId, { zeebeTaskType: connectorType, zeebeRetries: 3, zeebeHeaders: headers });
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('set_form', {
      title: 'Attach Camunda Form to User Task',
      description: 'Attach a Camunda Form (by ID) to a User Task. Form is rendered in Tasklist.',
      inputSchema: z.object({ elementId: z.string(), formId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, formId }) => {
      try { return await this.patchElementProps(elementId, { formId }); }
      catch (e) { return this.err((e as Error).message); }
    });
  }

  // ── GROUP 4: Query & Manipulation ─────────────────────────────────────────

  private registerQueryTools(): void {
    this.server.registerTool('list_elements', {
      title: 'List Diagram Elements',
      description: 'List all elements, optionally filtered by type keyword (e.g., "Task", "Gateway", "Event").',
      inputSchema: z.object({ elementType: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ elementType }) => {
      try {
        const d = this.getDiagram();
        let els = Object.values(d.elements);
        if (elementType) els = els.filter(e => e.type.toLowerCase().includes(elementType.toLowerCase()));
        if (!els.length) return this.ok('No elements found.');
        return this.ok(`Elements (${els.length}):\n` + els.map(e => `  ${e.id} | ${e.type.replace('bpmn:', '')} | "${e.name}" | (${e.position.x},${e.position.y})`).join('\n'));
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('get_element', {
      title: 'Get Element Details',
      description: 'Get full details of a specific element including Camunda 8 / Zeebe properties.',
      inputSchema: z.object({ elementId: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId }) => {
      try {
        const d = this.getDiagram();
        const el = d.elements[elementId];
        if (!el) return this.err(`Element "${elementId}" not found.`);
        const conns = Object.values(d.connections).filter(c => c.source === elementId || c.target === elementId);
        return this.ok([
          `ID: ${el.id}`, `Type: ${el.type}`, `Name: ${el.name}`,
          `Position: (${el.position.x}, ${el.position.y})`,
          `Size: ${el.size?.width ?? '?'} × ${el.size?.height ?? '?'}`,
          `Properties:\n${JSON.stringify(el.properties, null, 2)}`,
          `Connections: ${conns.map(c => `${c.source}→${c.target}${c.label ? ` [${c.label}]` : ''}`).join(', ') || 'none'}`,
        ].join('\n'));
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('update_element', {
      title: 'Update Element Name / Properties',
      description: 'Update an element\'s name and/or merge new properties.',
      inputSchema: z.object({ elementId: z.string(), name: z.string().optional(), properties: z.record(z.unknown()).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ elementId, name, properties }) => {
      try {
        const d = this.getDiagram();
        const el = d.elements[elementId];
        if (!el) return this.err(`Element "${elementId}" not found.`);
        const updated: BpmnElement = { ...el, name: name ?? el.name, properties: { ...el.properties, ...(properties ?? {}) } };
        await this.saveDiagram({ ...d, elements: { ...d.elements, [elementId]: updated } });
        return this.ok(`Updated "${elementId}".`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('delete_element', {
      title: 'Delete Element',
      description: 'Delete an element and all its connected sequence flows.',
      inputSchema: z.object({ elementId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, async ({ elementId }) => {
      try {
        const d = this.getDiagram();
        if (!d.elements[elementId]) return this.err(`Element "${elementId}" not found.`);
        const elements = { ...d.elements }; delete elements[elementId];
        const connections: Record<string, BpmnConnection> = {};
        let removed = 0;
        for (const [id, c] of Object.entries(d.connections)) {
          if (c.source !== elementId && c.target !== elementId) connections[id] = c; else removed++;
        }
        await this.saveDiagram({ ...d, elements, connections });
        return this.ok(`Deleted "${elementId}" and ${removed} connected flow(s).`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('auto_layout', {
      title: 'Auto Layout Diagram',
      description: 'Arrange elements using topological-sort layout. Run after building the diagram.',
      inputSchema: z.object({ algorithm: z.enum(['horizontal', 'vertical']).default('horizontal') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ algorithm = 'horizontal' }) => {
      try {
        const d = this.getDiagram();
        const laidOut = applyAutoLayout(d.elements, d.connections, algorithm);
        await this.saveDiagram({ ...d, elements: laidOut });
        return this.ok(`Applied ${algorithm} layout to ${Object.keys(laidOut).length} elements.`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('validate', {
      title: 'Validate BPMN Structure',
      description: 'Check for structural errors: missing start/end events, disconnected elements.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async () => {
      try { return this.ok(this.runValidation(this.getDiagram())); }
      catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('validate_camunda8', {
      title: 'Validate Camunda 8 Specific Rules',
      description: 'Check Camunda 8 / Zeebe compliance: service tasks need taskDefinition, user tasks need assignment, timer events need timer value, etc.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async () => {
      try { return this.ok(this.runCamunda8Validation(this.getDiagram())); }
      catch (e) { return this.err((e as Error).message); }
    });
  }

  // ── GROUP 5: File Management ──────────────────────────────────────────────

  private registerFileTools(): void {
    this.server.registerTool('list_diagrams', {
      title: 'List Saved Diagrams',
      description: 'List all BPMN and DMN files in KV storage.',
      inputSchema: z.object({ prefix: z.enum(['bpmn', 'dmn', 'all']).default('bpmn') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ prefix = 'bpmn' }) => {
      try {
        const results: string[] = [];
        if (prefix === 'bpmn' || prefix === 'all') {
          const list = await this.env.BPMN_FILES.list({ prefix: 'bpmn:' });
          results.push(...list.keys.map((k: { name: string }) => `  [BPMN] ${k.name.replace('bpmn:', '')}`));
        }
        if (prefix === 'dmn' || prefix === 'all') {
          const list = await this.env.BPMN_FILES.list({ prefix: 'dmn:' });
          results.push(...list.keys.map((k: { name: string }) => `  [DMN]  ${k.name.replace('dmn:', '')}`));
        }
        if (!results.length) return this.ok('No saved files found. Use save_as to save the current diagram.');
        return this.ok(`Files (${results.length}):\n${results.join('\n')}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('delete_diagram', {
      title: 'Delete Saved Diagram',
      description: 'Delete a BPMN file from KV storage.',
      inputSchema: z.object({ filename: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, async ({ filename }) => {
      try {
        const key = `bpmn:${filename}`;
        if (!await this.env.BPMN_FILES.get(key)) return this.err(`"${filename}" not found.`);
        await this.env.BPMN_FILES.delete(key);
        return this.ok(`Deleted "${filename}".`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('duplicate_diagram', {
      title: 'Duplicate Current Diagram',
      description: 'Copy the current diagram to a new filename.',
      inputSchema: z.object({ newFilename: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ newFilename }) => {
      try {
        const d = this.getDiagram();
        const fn = newFilename.endsWith('.bpmn') ? newFilename : `${newFilename}.bpmn`;
        await this.env.BPMN_FILES.put(`bpmn:${fn}`, d.xml);
        return this.ok(`Duplicated to "${fn}".`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('get_diagram_xml', {
      title: 'Get Stored Diagram XML',
      description: 'Retrieve raw XML of a stored BPMN/DMN file without opening it.',
      inputSchema: z.object({ filename: z.string(), type: z.enum(['bpmn', 'dmn']).default('bpmn') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ filename, type = 'bpmn' }) => {
      try {
        const xml = await this.env.BPMN_FILES.get(`${type}:${filename}`);
        if (!xml) return this.err(`"${filename}" not found.`);
        return this.ok(xml);
      } catch (e) { return this.err((e as Error).message); }
    });
  }

  // ── GROUP 6: Advanced / AI-assisted ──────────────────────────────────────

  private registerAdvancedTools(): void {
    this.server.registerTool('natural_language_to_bpmn', {
      title: 'Natural Language → BPMN',
      description: 'Generate a BPMN diagram from a process description in Vietnamese or English. Creates the diagram and sets it as current.',
      inputSchema: z.object({
        description: z.string().describe('Process description (Vietnamese or English)'),
        processName: z.string(),
        style: z.enum(['simple', 'detailed']).default('simple').describe('simple = happy path; detailed = with gateways & error handling'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ description, processName, style }) => {
      try {
        // ── Step extraction: parse sentences into proper BPMN step names ──────
        const extractStepName = (sentence: string): { name: string; isDecision: boolean; isEnd: boolean } => {
          const s = sentence.trim();
          const isDecision = /\b(check|decide|approve|review|branch|condition|if|whether|valid|invalid|kiểm tra|phê duyệt|quyết định|nếu|xét duyệt)\b/i.test(s);
          const isEnd = /\b(complete|done|finish|end|reject|cancel|notify|xong|hoàn thành|từ chối|kết thúc)\b/i.test(s);

          // Remove filler phrases (Vietnamese + English)
          let clean = s
            // Strip subject prefix
            .replace(/^(Hệ thống tự động|Hệ thống|Khách hàng|Người dùng|System automatically|System|User|Customer)\s+/i, '')
            // Vietnamese: "Nếu X thì Y" → keep Y (the action)
            .replace(/^Nếu\s+[^,]+,?\s+thì\s+/i, '')
            // Vietnamese: "Sau khi X, hệ thống Y" → strip "Sau khi X, " then strip subject again
            .replace(/^Sau khi\s+[^,]+,\s*/i, '')
            .replace(/^(Hệ thống tự động|Hệ thống|Khách hàng)\s+/i, '')
            // English: "If X then Y" → keep Y
            .replace(/^If\s+[^,]+,?\s+then\s+/i, '')
            // English: "After X, Y" → keep Y
            .replace(/^After\s+[^,]+,\s*/i, '')
            .trim();

          // Extract verb + object (first 5 words, title-case)
          const words = clean.split(/\s+/).slice(0, 5);
          const name = words
            .map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())
            .join(' ')
            .replace(/[,.:;]$/, '');

          return { name: name || s.substring(0, 40), isDecision, isEnd };
        };

        const processId = generateId('Process');
        const elements: Record<string, BpmnElement> = {};
        const connections: Record<string, BpmnConnection> = {};

        // Split on sentence boundaries, filter short/empty, take first N
        const sentences = description
          .split(/(?<=[.;\n])|(?<=\b(?:sau đó|then|tiếp theo|next|sau khi phê duyệt|rồi)\b)/i)
          .map(s => s.trim())
          .filter(s => s.length > 8 && !/^(và|và|hoặc|or|and)$/i.test(s))
          .slice(0, style === 'simple' ? 5 : 9);

        const startId = generateId('StartEvent');
        elements[startId] = {
          id: startId, type: 'bpmn:StartEvent',
          name: 'Start', position: { x: 100, y: 200 },
          size: { width: 36, height: 36 }, properties: {},
        };
        let prevId = startId;
        let x = 220;
        const pendingGateways: Array<{ gwId: string; sentence: string }> = [];

        for (const sentence of sentences) {
          const { name, isDecision } = extractStepName(sentence);
          const type = isDecision ? 'bpmn:ExclusiveGateway' : 'bpmn:ServiceTask';
          const sz = getSize(type);
          const elId = generateId(isDecision ? 'Gateway' : 'Task');
          elements[elId] = {
            id: elId, type, name,
            position: { x, y: isDecision ? 213 : 200 }, size: sz,
            properties: isDecision ? {} : {
              zeebeTaskType: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''),
            },
          };
          const fid = generateId('Flow');
          connections[fid] = { id: fid, source: prevId, target: elId, type: 'bpmn:SequenceFlow' };
          if (isDecision) pendingGateways.push({ gwId: elId, sentence });
          prevId = elId;
          x += sz.width + 60;
        }

        const endId = generateId('EndEvent');
        elements[endId] = {
          id: endId, type: 'bpmn:EndEvent',
          name: 'End', position: { x, y: 200 },
          size: { width: 36, height: 36 }, properties: {},
        };
        const lastFid = generateId('Flow');
        connections[lastFid] = { id: lastFid, source: prevId, target: endId, type: 'bpmn:SequenceFlow' };

        const laidOut = applyAutoLayout(elements, connections);
        const diagram: CurrentDiagram = { processId, name: processName, type: 'process', xml: '', filename: null, lastModified: new Date().toISOString(), elements: laidOut, connections };
        diagram.xml = generateXml(diagram);
        await this.setState({ currentDiagram: diagram });

        const taskCount = Object.values(elements).filter(e => e.type.includes('Task')).length;
        const gwCount = Object.values(elements).filter(e => e.type.includes('Gateway')).length;
        return this.ok([
          `Generated BPMN: "${processName}"`,
          `  ${taskCount} tasks, ${gwCount} gateways, ${Object.keys(connections).length} flows`,
          ``,
          `Next:`,
          `  • list_elements — review generated elements`,
          `  • set_zeebe_task_definition — configure service tasks`,
          `  • validate_camunda8 — check compliance`,
          `  • export — get BPMN XML`,
        ].join('\n'));
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('generate_documentation', {
      title: 'Generate Process Documentation',
      description: 'Generate Markdown documentation for the current process.',
      inputSchema: z.object({ includeProperties: z.boolean().default(false) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ includeProperties }) => {
      try {
        const d = this.getDiagram();
        const els = Object.values(d.elements);
        const conns = Object.values(d.connections);
        const tasks = els.filter(e => e.type.includes('Task') || e.type.includes('SubProcess'));
        const gateways = els.filter(e => e.type.includes('Gateway'));
        const lines = [
          `# ${d.name}`, ``,
          `**Process ID:** \`${d.processId}\` | **Type:** ${d.type} | **Elements:** ${els.length} | **Flows:** ${conns.length}`, ``,
          `## Start Events`, ...els.filter(e => e.type === 'bpmn:StartEvent').map(e => `- **${e.name || '(unnamed)'}** \`${e.id}\``),
          ``, `## Tasks & Activities (${tasks.length})`,
          ...tasks.map(e => {
            const lines2 = [`- **${e.name || '(unnamed)'}** — ${e.type.replace('bpmn:', '')} \`${e.id}\``];
            if (includeProperties && Object.keys(e.properties).length > 0) {
              for (const [k, v] of Object.entries(e.properties)) lines2.push(`  - ${k}: \`${JSON.stringify(v)}\``);
            }
            return lines2.join('\n');
          }),
        ];
        if (gateways.length > 0) {
          lines.push(``, `## Gateways (${gateways.length})`);
          for (const gw of gateways) {
            lines.push(`- **${gw.name || '(unnamed)'}** — ${gw.type.replace('bpmn:', '')} \`${gw.id}\``);
            conns.filter(c => c.source === gw.id).forEach(f => {
              const tgt = d.elements[f.target];
              lines.push(`  → ${f.label ? `[${f.label}] ` : ''}${tgt?.name || f.target}`);
            });
          }
        }
        lines.push(``, `## End Events`, ...els.filter(e => e.type === 'bpmn:EndEvent').map(e => `- **${e.name || '(unnamed)'}** \`${e.id}\``));
        return this.ok(lines.join('\n'));
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('suggest_improvements', {
      title: 'Suggest Camunda 8 Improvements',
      description: 'Analyse the current diagram and suggest Camunda 8 best-practice improvements.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async () => {
      try {
        const d = this.getDiagram();
        const suggestions: string[] = [];
        const els = Object.values(d.elements);
        const conns = Object.values(d.connections);
        const serviceTasks = els.filter(e => e.type === 'bpmn:ServiceTask');
        const userTasks = els.filter(e => e.type === 'bpmn:UserTask');
        const boundaries = els.filter(e => e.type === 'bpmn:BoundaryEvent');

        if (serviceTasks.length > 0 && boundaries.length === 0)
          suggestions.push(`⚠️  No error boundary events. Add Error Boundary Events to critical service tasks via set_error_boundary.`);
        if (serviceTasks.filter(e => !e.properties.zeebeTaskType).length > 0)
          suggestions.push(`❌ ${serviceTasks.filter(e => !e.properties.zeebeTaskType).length} service task(s) missing zeebe:taskDefinition. Use set_zeebe_task_definition.`);
        if (userTasks.filter(e => !e.properties.assignee && !e.properties.candidateGroups).length > 0)
          suggestions.push(`⚠️  ${userTasks.filter(e => !e.properties.assignee && !e.properties.candidateGroups).length} user task(s) with no assignment. Use set_user_task.`);

        for (const gw of els.filter(e => e.type === 'bpmn:ExclusiveGateway')) {
          const out = conns.filter(c => c.source === gw.id);
          if (out.length > 1 && !out.some(c => c.condition))
            suggestions.push(`⚠️  Exclusive Gateway "${gw.name || gw.id}" lacks FEEL conditions on outgoing flows.`);
        }
        if (els.length > 4 && !els.some(e => e.type.includes('Gateway')))
          suggestions.push(`💡 No gateways found. Consider adding decision logic for branching paths.`);
        if (serviceTasks.length > 2 && !els.some(e => e.properties.eventDefinition === 'timer'))
          suggestions.push(`💡 Consider Timer Boundary Events for SLA enforcement on long-running service tasks.`);

        return suggestions.length === 0
          ? this.ok(`✅ "${d.name}" follows Camunda 8 best practices.`)
          : this.ok(`Improvements for "${d.name}":\n\n${suggestions.join('\n\n')}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('diff_bpmn', {
      title: 'Compare Two Stored Diagrams',
      description: 'Show element-level differences between two stored BPMN files.',
      inputSchema: z.object({ filenameA: z.string(), filenameB: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ filenameA, filenameB }) => {
      try {
        const xmlA = await this.env.BPMN_FILES.get(`bpmn:${filenameA}`);
        const xmlB = await this.env.BPMN_FILES.get(`bpmn:${filenameB}`);
        if (!xmlA) return this.err(`"${filenameA}" not found.`);
        if (!xmlB) return this.err(`"${filenameB}" not found.`);
        const a = parseXmlToState(xmlA); const b = parseXmlToState(xmlB);
        const idsA = new Set(Object.keys(a.elements ?? {})); const idsB = new Set(Object.keys(b.elements ?? {}));
        const added = [...idsB].filter(id => !idsA.has(id));
        const removed = [...idsA].filter(id => !idsB.has(id));
        const unchanged = [...idsA].filter(id => idsB.has(id)).length;
        const lines = [
          `Diff: "${filenameA}" vs "${filenameB}"`, ``,
          `Added in B (${added.length}):`, ...added.map(id => `  + ${id} (${b.elements?.[id]?.type ?? '?'}) "${b.elements?.[id]?.name ?? ''}"`),
          ``, `Removed in B (${removed.length}):`, ...removed.map(id => `  - ${id} (${a.elements?.[id]?.type ?? '?'}) "${a.elements?.[id]?.name ?? ''}"`),
          ``, `Unchanged: ${unchanged} elements`,
        ];
        return this.ok(lines.join('\n'));
      } catch (e) { return this.err((e as Error).message); }
    });
  }

  // ── GROUP 7: DMN Decision Tables ──────────────────────────────────────────

  private registerDmnTools(): void {
    this.server.registerTool('new_dmn', {
      title: 'Create New DMN Decision Table',
      description: 'Create a new DMN decision table. Link it to a Business Rule Task via set_business_rule_task.',
      inputSchema: z.object({ name: z.string(), decisionId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ name, decisionId }) => {
      try {
        const dmnState: DmnState = { name, decisionId, inputs: [], outputs: [], rules: [], xml: '' };
        dmnState.xml = this.buildDmnXml(decisionId, name, [], [], []);
        await this.ctx.storage.put('currentDmn', dmnState);
        return this.ok(`Created DMN: "${name}" (decisionId: ${decisionId})\nNext: add_dmn_input, add_dmn_output, add_dmn_rule, export_dmn`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_dmn_input', {
      title: 'Add DMN Input Column',
      description: 'Add an Input column to the current DMN decision table.',
      inputSchema: z.object({ expression: z.string().describe('Input variable e.g. "amount"'), label: z.string(), type: z.string().default('string').describe('string|integer|long|double|boolean|date') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ expression, label, type }) => {
      try {
        const dmn = await this.ctx.storage.get<DmnState>('currentDmn');
        if (!dmn) return this.err('No DMN table open. Use new_dmn first.');
        dmn.inputs.push({ expression, label, type });
        dmn.xml = this.buildDmnXml(dmn.decisionId, dmn.name, dmn.inputs, dmn.outputs, dmn.rules);
        await this.ctx.storage.put('currentDmn', dmn);
        return this.ok(`Added input: "${label}" (${expression}: ${type}). Total inputs: ${dmn.inputs.length}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_dmn_output', {
      title: 'Add DMN Output Column',
      description: 'Add an Output column to the current DMN decision table.',
      inputSchema: z.object({ name: z.string().describe('Output variable name'), label: z.string(), type: z.string().default('string') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ name, label, type }) => {
      try {
        const dmn = await this.ctx.storage.get<DmnState>('currentDmn');
        if (!dmn) return this.err('No DMN table open. Use new_dmn first.');
        dmn.outputs.push({ name, label, type });
        dmn.xml = this.buildDmnXml(dmn.decisionId, dmn.name, dmn.inputs, dmn.outputs, dmn.rules);
        await this.ctx.storage.put('currentDmn', dmn);
        return this.ok(`Added output: "${label}" (${name}: ${type}). Total outputs: ${dmn.outputs.length}`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('add_dmn_rule', {
      title: 'Add DMN Rule Row',
      description: 'Add a rule row. Input/output array sizes must match column counts. Use "" for "any" match.',
      inputSchema: z.object({
        inputs: z.array(z.string()),
        outputs: z.array(z.string()),
        annotation: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ inputs, outputs, annotation }) => {
      try {
        const dmn = await this.ctx.storage.get<DmnState>('currentDmn');
        if (!dmn) return this.err('No DMN table open.');
        if (inputs.length !== dmn.inputs.length) return this.err(`Expected ${dmn.inputs.length} inputs, got ${inputs.length}.`);
        if (outputs.length !== dmn.outputs.length) return this.err(`Expected ${dmn.outputs.length} outputs, got ${outputs.length}.`);
        dmn.rules.push([...inputs, ...outputs, annotation ?? '']);
        dmn.xml = this.buildDmnXml(dmn.decisionId, dmn.name, dmn.inputs, dmn.outputs, dmn.rules);
        await this.ctx.storage.put('currentDmn', dmn);
        return this.ok(`Added rule #${dmn.rules.length}: [${inputs.join(', ')}] → [${outputs.join(', ')}]`);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('export_dmn', {
      title: 'Export DMN XML',
      description: 'Export the current DMN table as DMN 1.3 XML.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async () => {
      try {
        const dmn = await this.ctx.storage.get<DmnState>('currentDmn');
        if (!dmn) return this.err('No DMN table open.');
        return this.ok(dmn.xml);
      } catch (e) { return this.err((e as Error).message); }
    });

    this.server.registerTool('embed_dmn_in_bpmn', {
      title: 'Save DMN to KV Storage',
      description: 'Persist the current DMN table to KV storage. Then link via set_business_rule_task.',
      inputSchema: z.object({ filename: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ filename }) => {
      try {
        const dmn = await this.ctx.storage.get<DmnState>('currentDmn');
        if (!dmn) return this.err('No DMN table open.');
        const fn = filename.endsWith('.dmn') ? filename : `${filename}.dmn`;
        await this.env.BPMN_FILES.put(`dmn:${fn}`, dmn.xml);
        return this.ok(`Saved DMN to "${fn}" (decisionId: ${dmn.decisionId}).\nTo link: set_business_rule_task elementId="..." decisionId="${dmn.decisionId}" resultVariable="result"`);
      } catch (e) { return this.err((e as Error).message); }
    });
  }

  // ── DMN XML Builder ───────────────────────────────────────────────────────

  private buildDmnXml(decisionId: string, name: string, inputs: DmnColumn[], outputs: DmnColumn[], rules: string[][]): string {
    const inputCols = inputs.map((inp, i) =>
      `      <input id="InputClause_${i}" label="${esc(inp.label)}" camunda:inputVariable="">
        <inputExpression id="InputExpression_${i}" typeRef="${inp.type ?? 'string'}">
          <text>${esc(inp.expression ?? '')}</text>
        </inputExpression>
      </input>`);
    const outputCols = outputs.map((out, i) =>
      `      <output id="OutputClause_${i}" label="${esc(out.label)}" name="${esc(out.name ?? '')}" typeRef="${out.type ?? 'string'}" />`);
    const ruleXml = rules.map((row, ri) => {
      const ins = inputs.map((_, i) => `        <inputEntry id="UnaryTests_${ri}_${i}"><text>${esc(row[i] ?? '')}</text></inputEntry>`);
      const outs = outputs.map((_, i) => `        <outputEntry id="LiteralExpression_${ri}_${i}"><text>${esc(row[inputs.length + i] ?? '')}</text></outputEntry>`);
      const ann = row[inputs.length + outputs.length] ?? '';
      return `      <rule id="DecisionRule_${ri}">\n${ins.join('\n')}\n${outs.join('\n')}\n        ${ann ? `<annotationEntry><text>${esc(ann)}</text></annotationEntry>` : ''}\n      </rule>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
  xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/"
  xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/"
  id="Definitions_${decisionId}" name="${esc(name)}"
  namespace="http://camunda.org/schema/1.0/dmn">
  <decision id="${decisionId}" name="${esc(name)}">
    <decisionTable id="decisionTable_${decisionId}" hitPolicy="UNIQUE">
${inputCols.join('\n')}
${outputCols.join('\n')}
${ruleXml.join('\n')}
    </decisionTable>
  </decision>
</definitions>`;
  }
}
