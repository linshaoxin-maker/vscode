/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate by re-copying the canonical source
 * canonical source: packages/invoke-client/src/types/protocol.ts
 * @chipos/invoke-client — shared reasoner /invoke client (M3 vendored copy; sync-vendor ide target lands after M2).
 * ──────────────────────────────────────────────────────────────────── */
/**
 * Shared TypeScript types still consumed by the extension host.
 *
 * Scope after the WebSocket-transport retirement: editor context + LLM config
 * sent with a turn, the editor-integration payloads the host renders (diff
 * preview, lint, file changes), the dynamic skill tree, and MCP injection.
 *
 * The legacy WS frame types (ServerMessage/TaskMessage/…) and the event-payload
 * shapes the old transport carried were removed with the WS client — the live
 * /invoke event types live in `agent/invokeTypes.ts` (single source of truth).
 */

// ---------------------------------------------------------------------------
// Editor context + turn config (sent with a turn)
// ---------------------------------------------------------------------------

export interface ContextFile {
  path: string;
  type: 'file' | 'folder' | 'snippet';
  content?: string | null;
  truncated?: boolean;
  binary?: boolean;
  line_count?: number;
  start_line?: number;
  end_line?: number;
  language_id?: string;
}

export interface SearchResultItem {
  name: string;
  path: string;
  type: 'file' | 'folder';
  dir?: string;
}

export type AutoApproveMode = 'strict' | 'standard' | 'full_auto';

export interface LLMConfig {
  api_key: string;
  provider?: string;
  base_url?: string;
  model?: string;
  mcp_config_path?: string;
  enable_builtin_tools?: boolean;
  builtin_tool_config?: Record<string, unknown>;
  max_tokens?: number;
}

// ---------------------------------------------------------------------------
// Editor-integration payloads (consumed by host middlewares / providers)
// ---------------------------------------------------------------------------

export interface DiffHunk {
  file_path?: string;
  old_start: number;
  new_start: number;
  lines?: string[];
  old_lines?: string[];
  new_lines?: string[];
}

export interface DiffPreviewData {
  file_path: string;
  hunks: DiffHunk[];
}

export interface LintError {
  file: string;
  line: number;
  column?: number;
  severity?: string;
  message: string;
  rule: string;
}

export interface LintReportData {
  errors: LintError[];
  auto_fixable: boolean;
}

export interface FileChangeInfo {
  path: string;
  action: 'created' | 'modified';
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// Dynamic Skill tree
// ---------------------------------------------------------------------------

export interface SkillMeta {
  skill_id: string;
  description: string;
  status: 'draft' | 'validated' | 'retired';
  confidence: number;
  stats: { loaded_count: number; success_after_load: number };
}

export interface SkillCategory {
  id: string;
  label: string;
  skill_count?: number;
  children?: SkillCategory[];
  skills?: SkillMeta[];
}

export interface SkillTreeData {
  version: number;
  total_skills: number;
  children: SkillCategory[];
}

// ---------------------------------------------------------------------------
// MCP dynamic injection types
// ---------------------------------------------------------------------------

export type McpSourceScope = 'global' | 'workspace';
export type McpTransport = 'sse' | 'streamable_http' | 'http';

export interface McpServerConfig {
  transport: McpTransport;
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeout?: number;
  sse_read_timeout?: number;
}

export interface McpSourceDocument {
  version: 1;
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpLoadStateData {
  global: McpSourceDocument;
  workspace: McpSourceDocument;
  resolvedPath: string | null;
}
