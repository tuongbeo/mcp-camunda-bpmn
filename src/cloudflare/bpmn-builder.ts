import type { BpmnElement, BpmnConnection, CurrentDiagram } from './types.js';

// ── ID Generator ───────────────────────────────────────────────────────────────

let counter = 0;

export function generateId(prefix: string): string {
  counter++;
  const ts = Date.now().toString(36).toUpperCase();
  return `${prefix}_${ts}${counter}`;
}

// ── Type & Size Mappings ───────────────────────────────────────────────────────

const TAG_MAP: Record<string, string> = {
  'bpmn:StartEvent': 'startEvent',
  'bpmn:EndEvent': 'endEvent',
  'bpmn:IntermediateCatchEvent': 'intermediateCatchEvent',
  'bpmn:IntermediateThrowEvent': 'intermediateThrowEvent',
  'bpmn:BoundaryEvent': 'boundaryEvent',
  'bpmn:Task': 'task',
  'bpmn:UserTask': 'userTask',
  'bpmn:ServiceTask': 'serviceTask',
  'bpmn:SendTask': 'sendTask',
  'bpmn:ReceiveTask': 'receiveTask',
  'bpmn:ScriptTask': 'scriptTask',
  'bpmn:BusinessRuleTask': 'businessRuleTask',
  'bpmn:ManualTask': 'manualTask',
  'bpmn:CallActivity': 'callActivity',
  'bpmn:SubProcess': 'subProcess',
  'bpmn:AdHocSubProcess': 'adHocSubProcess',
  'bpmn:ExclusiveGateway': 'exclusiveGateway',
  'bpmn:ParallelGateway': 'parallelGateway',
  'bpmn:InclusiveGateway': 'inclusiveGateway',
  'bpmn:EventBasedGateway': 'eventBasedGateway',
  'bpmn:ComplexGateway': 'complexGateway',
};

const SIZE_MAP: Record<string, { width: number; height: number }> = {
  'bpmn:StartEvent': { width: 36, height: 36 },
  'bpmn:EndEvent': { width: 36, height: 36 },
  'bpmn:IntermediateCatchEvent': { width: 36, height: 36 },
  'bpmn:IntermediateThrowEvent': { width: 36, height: 36 },
  'bpmn:BoundaryEvent': { width: 36, height: 36 },
  'bpmn:ExclusiveGateway': { width: 50, height: 50 },
  'bpmn:ParallelGateway': { width: 50, height: 50 },
  'bpmn:InclusiveGateway': { width: 50, height: 50 },
  'bpmn:EventBasedGateway': { width: 50, height: 50 },
  'bpmn:ComplexGateway': { width: 50, height: 50 },
  'bpmn:SubProcess': { width: 350, height: 200 },
  'bpmn:AdHocSubProcess': { width: 350, height: 200 },
};

export function getSize(type: string): { width: number; height: number } {
  return SIZE_MAP[type] ?? { width: 100, height: 80 };
}

export function getTagName(type: string): string {
  return TAG_MAP[type] ?? type.replace('bpmn:', '');
}

// ── Event Type → BPMN type mapping ────────────────────────────────────────────

export function resolveEventType(
  eventType: string,
  eventDefinition?: string,
): string {
  const base: Record<string, string> = {
    start: 'bpmn:StartEvent',
    end: 'bpmn:EndEvent',
    'intermediate-throw': 'bpmn:IntermediateThrowEvent',
    'intermediate-catch': 'bpmn:IntermediateCatchEvent',
    boundary: 'bpmn:BoundaryEvent',
  };
  return base[eventType] ?? 'bpmn:StartEvent';
}

export function resolveActivityType(activityType: string): string {
  const map: Record<string, string> = {
    task: 'bpmn:Task',
    userTask: 'bpmn:UserTask',
    serviceTask: 'bpmn:ServiceTask',
    scriptTask: 'bpmn:ScriptTask',
    sendTask: 'bpmn:SendTask',
    receiveTask: 'bpmn:ReceiveTask',
    businessRuleTask: 'bpmn:BusinessRuleTask',
    manualTask: 'bpmn:ManualTask',
    callActivity: 'bpmn:CallActivity',
    subProcess: 'bpmn:SubProcess',
    adHocSubProcess: 'bpmn:AdHocSubProcess',
  };
  return map[activityType] ?? 'bpmn:Task';
}

export function resolveGatewayType(gatewayType: string): string {
  const map: Record<string, string> = {
    exclusive: 'bpmn:ExclusiveGateway',
    parallel: 'bpmn:ParallelGateway',
    inclusive: 'bpmn:InclusiveGateway',
    eventBased: 'bpmn:EventBasedGateway',
    complexGateway: 'bpmn:ComplexGateway',
  };
  return map[gatewayType] ?? 'bpmn:ExclusiveGateway';
}

// ── Extension Elements XML Helpers ────────────────────────────────────────────

export function buildExtensionElements(extensions: string[]): string {
  if (extensions.length === 0) return '';
  return `
      <bpmn:extensionElements>
        ${extensions.join('\n        ')}
      </bpmn:extensionElements>`;
}

export function buildZeebeTaskDefinition(type: string, retries = 3): string {
  return `<zeebe:taskDefinition type="${esc(type)}" retries="${retries}" />`;
}

export function buildZeebeTaskHeaders(
  headers: Array<{ key: string; value: string }>,
): string {
  const items = headers.map(
    (h) => `<zeebe:header key="${esc(h.key)}" value="${esc(h.value)}" />`,
  );
  return `<zeebe:taskHeaders>\n          ${items.join('\n          ')}\n        </zeebe:taskHeaders>`;
}

export function buildZeebeIoMapping(
  inputs: Array<{ source: string; target: string }>,
  outputs: Array<{ source: string; target: string }>,
): string {
  const ins = inputs.map(
    (i) => `<zeebe:input source="${esc(i.source)}" target="${esc(i.target)}" />`,
  );
  const outs = outputs.map(
    (o) =>
      `<zeebe:output source="${esc(o.source)}" target="${esc(o.target)}" />`,
  );
  return `<zeebe:ioMapping>\n          ${[...ins, ...outs].join('\n          ')}\n        </zeebe:ioMapping>`;
}

export function buildZeebeAssignment(opts: {
  assignee?: string;
  candidateGroups?: string;
  priority?: string;
}): string {
  const attrs: string[] = [];
  if (opts.assignee) attrs.push(`assignee="${esc(opts.assignee)}"`);
  if (opts.candidateGroups)
    attrs.push(`candidateGroups="${esc(opts.candidateGroups)}"`);
  if (opts.priority) attrs.push(`priority="${esc(opts.priority)}"`);
  return `<zeebe:assignmentDefinition ${attrs.join(' ')} />`;
}

// ── Escape XML special characters ─────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auto-layout ───────────────────────────────────────────────────────────────

export function applyAutoLayout(
  elements: Record<string, BpmnElement>,
  connections: Record<string, BpmnConnection>,
  algorithm: 'horizontal' | 'vertical' = 'horizontal',
): Record<string, BpmnElement> {
  const updated = { ...elements };
  const elList = Object.values(updated);

  // Build adjacency for topological sort
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  for (const el of elList) {
    inDegree[el.id] = 0;
    adj[el.id] = [];
  }
  for (const conn of Object.values(connections)) {
    adj[conn.source] = adj[conn.source] ?? [];
    adj[conn.source].push(conn.target);
    inDegree[conn.target] = (inDegree[conn.target] ?? 0) + 1;
  }

  // Kahn's algorithm for topological sort
  const queue: string[] = elList
    .filter((el) => (inDegree[el.id] ?? 0) === 0)
    .map((el) => el.id);
  const layers: string[][] = [];
  const placed = new Set<string>();

  while (queue.length > 0) {
    const layer: string[] = [];
    const next: string[] = [];
    for (const id of queue) {
      if (!placed.has(id)) {
        layer.push(id);
        placed.add(id);
      }
    }
    if (layer.length === 0) break;
    layers.push(layer);
    for (const id of layer) {
      for (const neighbor of adj[id] ?? []) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) next.push(neighbor);
      }
    }
    queue.length = 0;
    queue.push(...next);
  }

  // Place remaining (cycles)
  for (const el of elList) {
    if (!placed.has(el.id)) layers.push([el.id]);
  }

  // Assign positions
  const PADDING_X = 150;
  const PADDING_Y = 100;
  const START_X = 100;
  const START_Y = 100;

  if (algorithm === 'horizontal') {
    let x = START_X;
    for (const layer of layers) {
      let y = START_Y;
      for (const id of layer) {
        updated[id] = { ...updated[id], position: { x, y } };
        const sz = getSize(updated[id].type);
        y += sz.height + PADDING_Y;
      }
      const maxW = Math.max(
        ...layer.map((id) => getSize(updated[id].type).width),
      );
      x += maxW + PADDING_X;
    }
  } else {
    let y = START_Y;
    for (const layer of layers) {
      let x = START_X;
      for (const id of layer) {
        updated[id] = { ...updated[id], position: { x, y } };
        const sz = getSize(updated[id].type);
        x += sz.width + PADDING_X;
      }
      const maxH = Math.max(
        ...layer.map((id) => getSize(updated[id].type).height),
      );
      y += maxH + PADDING_Y;
    }
  }

  return updated;
}

// ── XML Generator ─────────────────────────────────────────────────────────────

export function generateXml(diagram: CurrentDiagram): string {
  const { processId, name, type, elements, connections } = diagram;
  const elList = Object.values(elements);
  const connList = Object.values(connections);

  let elementXml = '';
  let diagramXml = '';

  for (const el of elList) {
    const tag = getTagName(el.type);
    const sz = getSize(el.type);
    const w = el.size?.width ?? sz.width;
    const h = el.size?.height ?? sz.height;
    const { x, y } = el.position;

    // Build extension elements from properties
    const extensions: string[] = [];
    const props = el.properties;

    // Zeebe task definition (service task)
    if (props.zeebeTaskType) {
      extensions.push(
        buildZeebeTaskDefinition(
          props.zeebeTaskType as string,
          (props.zeebeRetries as number) ?? 3,
        ),
      );
    }

    // Zeebe task headers
    if (
      props.zeebeHeaders &&
      Array.isArray(props.zeebeHeaders) &&
      (props.zeebeHeaders as unknown[]).length > 0
    ) {
      extensions.push(
        buildZeebeTaskHeaders(
          props.zeebeHeaders as Array<{ key: string; value: string }>,
        ),
      );
    }

    // Zeebe IO mapping
    const inputs = (props.zeebeInputs as Array<{
      source: string;
      target: string;
    }>) ?? [];
    const outputs = (props.zeebeOutputs as Array<{
      source: string;
      target: string;
    }>) ?? [];
    if (inputs.length > 0 || outputs.length > 0) {
      extensions.push(buildZeebeIoMapping(inputs, outputs));
    }

    // Zeebe assignment (user task)
    if (props.assignee || props.candidateGroups || props.priority) {
      extensions.push(
        buildZeebeAssignment({
          assignee: props.assignee as string | undefined,
          candidateGroups: props.candidateGroups as string | undefined,
          priority: props.priority as string | undefined,
        }),
      );
    }

    // Zeebe form definition
    if (props.formId) {
      extensions.push(
        `<zeebe:formDefinition formId="${esc(props.formId as string)}" />`,
      );
    }

    // Zeebe task schedule (due date / follow-up)
    if (props.dueDate || props.followUpDate) {
      const schedAttrs: string[] = [];
      if (props.dueDate)
        schedAttrs.push(`dueDate="${esc(props.dueDate as string)}"`);
      if (props.followUpDate)
        schedAttrs.push(`followUpDate="${esc(props.followUpDate as string)}"`);
      extensions.push(`<zeebe:taskSchedule ${schedAttrs.join(' ')} />`);
    }

    // Called element (call activity)
    if (props.calledElement) {
      const propagate = props.propagateAllVariables ? ' propagateAllChildVariables="true"' : '';
      extensions.push(
        `<zeebe:calledElement processId="${esc(props.calledElement as string)}"${propagate} />`,
      );
    }

    // Called decision (business rule task)
    if (props.decisionId) {
      extensions.push(
        `<zeebe:calledDecision decisionId="${esc(props.decisionId as string)}" resultVariable="${esc((props.resultVariable as string) ?? 'result')}" />`,
      );
    }

    // Script task
    if (props.scriptExpression) {
      extensions.push(
        `<zeebe:script expression="${esc(props.scriptExpression as string)}"${props.scriptResultVariable ? ` resultVariable="${esc(props.scriptResultVariable as string)}"` : ''} />`,
      );
    }

    // Multi-instance
    let multiInstanceXml = '';
    if (props.multiInstanceInputCollection) {
      const isSeq = props.multiInstanceIsSequential ? 'true' : 'false';
      const inputCol = props.multiInstanceInputCollection as string;
      const inputEl = (props.multiInstanceInputElement as string) ?? 'item';
      const outputCol = props.multiInstanceOutputCollection as string | undefined;
      const outputEl = props.multiInstanceOutputElement as string | undefined;
      const loopAttrs = [
        `inputCollection="${esc(inputCol)}"`,
        `inputElement="${esc(inputEl)}"`,
      ];
      if (outputCol) loopAttrs.push(`outputCollection="${esc(outputCol)}"`);
      if (outputEl) loopAttrs.push(`outputElement="${esc(outputEl)}"`);
      multiInstanceXml = `
      <bpmn:multiInstanceLoopCharacteristics isSequential="${isSeq}">
        <bpmn:extensionElements>
          <zeebe:loopCharacteristics ${loopAttrs.join(' ')} />
        </bpmn:extensionElements>
      </bpmn:multiInstanceLoopCharacteristics>`;
    }

    // Event definition
    let eventDefXml = '';
    if (props.eventDefinition) {
      const evtDef = props.eventDefinition as string;
      const evtId = generateId(evtDef + 'EventDefinition');
      switch (evtDef) {
        case 'message':
          eventDefXml = `\n      <bpmn:messageEventDefinition id="${evtId}"${props.messageRef ? ` messageRef="${esc(props.messageRef as string)}"` : ''} />`;
          break;
        case 'timer':
          if (props.timerDuration) {
            eventDefXml = `\n      <bpmn:timerEventDefinition id="${evtId}">\n        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">${esc(props.timerDuration as string)}</bpmn:timeDuration>\n      </bpmn:timerEventDefinition>`;
          } else if (props.timerCycle) {
            eventDefXml = `\n      <bpmn:timerEventDefinition id="${evtId}">\n        <bpmn:timeCycle xsi:type="bpmn:tFormalExpression">${esc(props.timerCycle as string)}</bpmn:timeCycle>\n      </bpmn:timerEventDefinition>`;
          } else if (props.timerDate) {
            eventDefXml = `\n      <bpmn:timerEventDefinition id="${evtId}">\n        <bpmn:timeDate xsi:type="bpmn:tFormalExpression">${esc(props.timerDate as string)}</bpmn:timeDate>\n      </bpmn:timerEventDefinition>`;
          } else {
            eventDefXml = `\n      <bpmn:timerEventDefinition id="${evtId}" />`;
          }
          break;
        case 'error':
          eventDefXml = `\n      <bpmn:errorEventDefinition id="${evtId}"${props.errorCode ? ` errorRef="${esc(props.errorCode as string)}"` : ''} />`;
          break;
        case 'signal':
          eventDefXml = `\n      <bpmn:signalEventDefinition id="${evtId}"${props.signalRef ? ` signalRef="${esc(props.signalRef as string)}"` : ''} />`;
          break;
        case 'escalation':
          eventDefXml = `\n      <bpmn:escalationEventDefinition id="${evtId}" />`;
          break;
        case 'compensation':
          eventDefXml = `\n      <bpmn:compensateEventDefinition id="${evtId}" />`;
          break;
        case 'conditional':
          eventDefXml = `\n      <bpmn:conditionalEventDefinition id="${evtId}" />`;
          break;
        case 'terminate':
          eventDefXml = `\n      <bpmn:terminateEventDefinition id="${evtId}" />`;
          break;
      }
    }

    const extXml = buildExtensionElements(extensions);
    const hasContent = extXml || multiInstanceXml || eventDefXml;
    const nameAttr = el.name ? ` name="${esc(el.name)}"` : '';

    if (hasContent) {
      elementXml += `    <bpmn:${tag} id="${el.id}"${nameAttr}>${extXml}${multiInstanceXml}${eventDefXml}\n    </bpmn:${tag}>\n`;
    } else {
      elementXml += `    <bpmn:${tag} id="${el.id}"${nameAttr} />\n`;
    }

    // Diagram shape
    const isExpanded =
      el.type === 'bpmn:SubProcess' || el.type === 'bpmn:AdHocSubProcess';
    diagramXml += `      <bpmndi:BPMNShape id="${el.id}_di" bpmnElement="${el.id}"${isExpanded ? ' isExpanded="true"' : ''}>\n        <dc:Bounds x="${x}" y="${y}" width="${w}" height="${h}" />\n      </bpmndi:BPMNShape>\n`;
  }

  // Sequence flows
  for (const conn of connList) {
    const condAttr =
      conn.condition ? ` conditionExpression="${esc(conn.condition)}"` : '';
    const nameAttr = conn.label ? ` name="${esc(conn.label)}"` : '';
    elementXml += `    <bpmn:sequenceFlow id="${conn.id}" sourceRef="${conn.source}" targetRef="${conn.target}"${nameAttr}${condAttr} />\n`;

    const src = elements[conn.source];
    const tgt = elements[conn.target];
    if (src && tgt) {
      const srcSz = getSize(src.type);
      const tgtSz = getSize(tgt.type);
      const sx = src.position.x + (src.size?.width ?? srcSz.width);
      const sy = src.position.y + (src.size?.height ?? srcSz.height) / 2;
      const tx = tgt.position.x;
      const ty = tgt.position.y + (tgt.size?.height ?? tgtSz.height) / 2;
      diagramXml += `      <bpmndi:BPMNEdge id="${conn.id}_di" bpmnElement="${conn.id}">\n        <di:waypoint x="${sx}" y="${sy}" />\n        <di:waypoint x="${tx}" y="${ty}" />\n      </bpmndi:BPMNEdge>\n`;
    }
  }

  const zeebeNs =
    elementXml.includes('zeebe:')
      ? '\n  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"'
      : '';
  const xsiNs =
    elementXml.includes('xsi:type')
      ? '\n  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"${zeebeNs}${xsiNs}
  id="Definitions_1"
  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${processId}" name="${esc(name)}" isExecutable="true">
${elementXml}  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${processId}">
${diagramXml}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}

// ── XML Parser (import existing BPMN) ─────────────────────────────────────────

export function parseXmlToState(xml: string): Partial<CurrentDiagram> {
  const processMatch = xml.match(
    /<bpmn:process[^>]+id="([^"]+)"(?:[^>]+name="([^"]+)")?/,
  );
  const processId = processMatch?.[1] ?? generateId('Process');
  const name = processMatch?.[2] ?? 'Imported Process';

  const elements: Record<string, BpmnElement> = {};
  const connections: Record<string, BpmnConnection> = {};

  // Parse elements
  const elementRegex =
    /<bpmn:(\w+)\s[^>]*id="([^"]+)"(?:[^>]*name="([^"]+)")?[^>]*\/?>/g;
  let m;
  const SKIP = new Set([
    'process',
    'definitions',
    'sequenceFlow',
    'collaboration',
    'participant',
    'messageFlow',
  ]);
  while ((m = elementRegex.exec(xml)) !== null) {
    const [, rawTag, id, elName] = m;
    if (SKIP.has(rawTag)) continue;
    const capitalTag = rawTag.charAt(0).toUpperCase() + rawTag.slice(1);
    const type = `bpmn:${capitalTag}`;
    const sz = getSize(type);
    elements[id] = {
      id,
      type,
      name: elName ?? '',
      position: { x: 100, y: 100 },
      size: sz,
      properties: {},
    };
  }

  // Parse BPMNShape positions
  const shapeRegex =
    /<bpmndi:BPMNShape[^>]+bpmnElement="([^"]+)"[^>]*>[\s\S]*?<dc:Bounds\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"/g;
  while ((m = shapeRegex.exec(xml)) !== null) {
    const [, elId, x, y, w, h] = m;
    if (elements[elId]) {
      elements[elId].position = { x: parseFloat(x), y: parseFloat(y) };
      elements[elId].size = { width: parseFloat(w), height: parseFloat(h) };
    }
  }

  // Parse sequence flows
  const flowRegex =
    /<bpmn:sequenceFlow\s[^>]*id="([^"]+)"[^>]*sourceRef="([^"]+)"[^>]*targetRef="([^"]+)"[^>]*(?:name="([^"]+)")?[^>]*\/?>/g;
  while ((m = flowRegex.exec(xml)) !== null) {
    const [, id, source, target, label] = m;
    connections[id] = {
      id,
      source,
      target,
      label,
      type: 'bpmn:SequenceFlow',
    };
  }

  return { processId, name, elements, connections, xml };
}
