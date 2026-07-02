/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/agent/generated.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────────────────
 * GENERATED — DO NOT EDIT BY HAND. Regenerate via: node scripts/gen-bindings.mjs
 * source: packages/invoke-core/bindings/*.ts (ts-rs output of the Rust single source)
 * Aggregated subset re-exported by ./invokeTypes.ts (P-rust-4 / M4). Types whose
 * binding shape mismatches invoke.py defaults stay hand-written there (#6).
 * ──────────────────────────────────────────────────────────────────── */

/**
 * skill 来源(builtin|user|plugin)。
 */
export type SkillSource = "builtin" | "user" | "plugin" | "workspace";

/**
 * rule/hook 资源来源(user|workspace|plugin)。
 */
export type PromptSource = "user" | "workspace" | "plugin";

/**
 * invoke.py PromptResourceKind — Beta-1 prompt 资源类型。
 */
export type PromptResourceKind = "rule" | "command";

/**
 * invoke.py ReasonerHookPoint — 14 个生命周期 hook 点(.value 是 dotted wire 串）。
 */
export type ReasonerHookPoint = "turn.before_start" | "context.before_collect" | "context.after_collect" | "prompt.before_render" | "prompt.after_render" | "llm.before_call" | "llm.after_response" | "tool.before_dispatch" | "tool.after_result" | "subagent.before_invoke" | "subagent.after_result" | "final.before_emit" | "turn.after_end" | "turn.on_error";

/**
 * invoke.py ReasonerHookAction。
 */
export type ReasonerHookAction = "observe" | "deny" | "amend" | "ask";

/**
 * invoke.py HookEvalDecision — IDE 端可执行(function)hook 经反向 channel 返回的决定(H-1)。
 */
export type HookEvalDecision = "proceed" | "deny" | "ask" | "amend";

export type EventFamily = "stream" | "tool" | "control" | "render" | "confirm" | "subagent" | "custom" | "terminal";

/**
 * invoke.py ToolDefinition.chipos_source — 工具执行落点的路由元数据(server-internal,不给 LLM 看)。
 */
export type ChiposSource = "worker_mcp" | "ide_mcp" | "ide_builtin";

/**
 * invoke.py TextBlock — standalone(pydantic 里它独立存在并被 union 引用;这里供
 * ToolResultContent 用;ContentBlock 的 Text 变体保持 tagged-enum 内联)。extra=allow。
 */
export type TextBlock = { type: "text", text: string, };

/**
 * invoke.py SelectedAgent — FEAT-005 用户 @agent 路由(IDE inline 发,extra=allow)。
 */
export type SelectedAgent = { name: string, instructions: string, description?: string, 
/**
 * 非空时把本轮工具目录限到这个 allow-list(与子角色 allowed_tools 对等)。
 */
tools?: Array<string>, 
/**
 * 'subagent' = 隔离委派;None/其他 = persona overlay(默认,保留对话)。
 */
mode?: string, 
/**
 * FEAT-005: 每-agent 模型覆盖(仅 mode:subagent 隔离路生效);None = 继承本轮模型。
 */
model?: string, };

/**
 * invoke.py SkillHeader — skill 目录头(name+description,body 懒加载,FEAT-003)。
 */
export type SkillHeader = { name: string, description: string, source: SkillSource, source_ref?: string, };

/**
 * invoke.py Identity — 已认证的 actor,从 JWT/chiops 派生(R1,client 永不自报)。
 */
export type Identity = { user_id: string, workspace_id: string, scopes: Array<string>, };

/**
 * invoke.py AllowedTools — 本轮真正可用的工具,服务端 registry×scopes 派生(R1)。
 */
export type AllowedTools = { worker: Array<string>, mcp: Array<string>, surface: Array<string>, };

/**
 * invoke.py ToolDefinition — Anthropic Messages tool 格式 + ChipOS 路由元数据。
 */
export type ToolDefinition = { name: string, description: string, input_schema: Record<string, unknown>, chipos_source: ChiposSource, };

/**
 * invoke.py RegisterToolsRequest — IDE→reasoner 长寿工具目录注册(替代 Phase 0 per-invoke tools[])。
 */
export type RegisterToolsRequest = { chat_session_id: string, tools: Array<ToolDefinition>, ide_version?: string, workspace_path?: string, };

/**
 * invoke.py RenderEnvelope — 每张 render 卡的统一外壳(开放 kind + 必填 fallback,D10)。
 */
export type RenderEnvelope = { kind: string, schema_version: number, payload: Record<string, unknown>, 
/**
 * 必填(D10):{text} | {artifact_ref} | 自定义对象。运行时保持 Value(无损透传:
 * untagged 3-way 对象分类有歧义——带 text 键的自定义 fallback 会被误收窄丢字段,
 * D10 要求 fallback 永不被 mangle);TS 侧给出精确联合。artifact_ref 形状内联
 * (ts 覆盖串不生成 import,引用 ArtifactRef 名会产出悬空引用)。
 */
fallback: { text: string } | { artifact_ref: { kind: string, uri: string, summary?: string } } | Record<string, unknown>, };
