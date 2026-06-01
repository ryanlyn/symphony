export interface OpsSessionEntry {
  issueId: string;
  identifier?: string;
  title?: string;
  agentKind?: string;
}

export interface OpsState {
  running: OpsSessionEntry[];
  retrying: OpsSessionEntry[];
  blocked: OpsSessionEntry[];
  counts: { running: number; retrying: number; blocked: number };
  usage_totals: { input_tokens: number; output_tokens: number; total_tokens: number };
}
