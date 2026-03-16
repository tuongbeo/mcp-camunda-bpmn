export interface Env {
  MCP_BPMN_AGENT: DurableObjectNamespace;
  BPMN_FILES: KVNamespace;
  ENVIRONMENT: string;
}

export interface BpmnElement {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  properties: Record<string, unknown>;
}

export interface BpmnConnection {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string;
  type: string;
}

export interface CurrentDiagram {
  processId: string;
  name: string;
  type: 'process' | 'collaboration';
  xml: string;
  filename: string | null;
  lastModified: string;
  elements: Record<string, BpmnElement>;
  connections: Record<string, BpmnConnection>;
}

export type BpmnState = {
  currentDiagram: CurrentDiagram | null;
};
