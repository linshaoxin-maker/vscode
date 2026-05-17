# EDA Tools End-to-End Test Scenarios

> **F21**: agent-browser scenarios that exercise the WORKER TOOLS panel +
> EDA Tools settings tab against a source-built worker. Runs manually
> until CI infra is set up.

## Prerequisites

```bash
# 1. Backend tests must pass (run first; ~5s)
cd backend_v2
PYTHONPATH=packages/execution/src:packages/shared/src python -m pytest \
  packages/execution/tests/test_tool_resolver.py \
  packages/execution/tests/test_resolver_dep_composition.py \
  packages/execution/tests/test_lifecycle_eda_resolutions.py \
  packages/execution/tests/test_lifecycle_health_probe.py \
  packages/execution/tests/test_lifecycle_mcp_test.py \
  packages/execution/tests/test_eda_env_rescan_and_poll.py \
  -q
# Expect: 79 passed, 1 skipped

# 2. IDE TS compiled (watch must be running OR full build done)
cd ../vscode
npm run compile-check-ts-native  # type-check only, no emit
```

## Flow A — Personal developer first launch

```bash
# A.1 Start source worker on 18099 (writable to /tmp/chipos-ux-ws)
cd /Users/linshaoxin/Documents/AI4EDA/coderust/backend_v2
mkdir -p /tmp/chipos-ux-ws
PYTHONPATH=packages/execution/src:packages/shared/src python -m execution.server.cli \
  start --workspace /tmp/chipos-ux-ws --http-port 18099 \
  --instance-dir /tmp/chipos-ux-inst --server localhost:50099 &

# A.2 Wait worker up, then verify new endpoints
until curl -s http://127.0.0.1:18099/health >/dev/null 2>&1; do sleep 1; done
curl -s 'http://127.0.0.1:18099/api/v1/eda/resolutions?strategy=auto' | jq '.summary'
# Expect: { ready: ≥11, missing: ≤20, total: 31 } when oss-cad-suite present
# Bug #1 baseline: ready should NOT be just 3 (would mean dep composition broken)

# A.3 Set IDE override to use source worker
SETTINGS="$HOME/Library/Application Support/code-oss-dev/User/settings.json"
python3 -c "
import json,os,re
p=os.path.expanduser('$SETTINGS')
with open(p) as f: raw=f.read()
d=json.loads(re.sub(r'^\s*//.*$','',raw,flags=re.MULTILINE))
d['chipos.backend.workerHttpUrl']='http://127.0.0.1:18099'
with open(p,'w') as f: json.dump(d,f,indent=2)
"

# A.4 Launch dev IDE
cd ../vscode
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh /tmp/chipos-ux-ws --remote-debugging-port=9224 &

# A.5 agent-browser connect + capture panel
until npx agent-browser connect 9224 2>/dev/null; do sleep 2; done
npx agent-browser eval '(() => {
  const headers = document.querySelectorAll(".part.auxiliarybar .pane-header");
  for (const h of headers) {
    if (h.querySelector(".title")?.textContent === "Worker Tools" && h.getAttribute("aria-expanded") !== "true") {
      h.click();
    }
  }
  return "expanded";
})()'

SS=/tmp/chipos-e2e/$(date +%Y%m%dT%H%M%S)
mkdir -p "$SS"
npx agent-browser screenshot ".part.auxiliarybar" "$SS/01-panel.png"

# A.6 Open Settings → EDA Tools tab
npx agent-browser press cmd+,
sleep 1
npx agent-browser eval '(() => {
  const items = document.querySelectorAll(".chipos-settings-nav-item");
  for (const i of items) {
    if (i.textContent?.trim() === "EDA Tools") { i.click(); return "ok"; }
  }
})()'
sleep 2
npx agent-browser screenshot ".chipos-settings-content" "$SS/02-eda-tab.png"

# A.7 Assertions (verify visually + via DOM eval)
npx agent-browser eval '(() => {
  const rows = document.querySelectorAll(".chipos-eda-tool-row");
  const yosys = Array.from(rows).find(r => r.textContent?.startsWith("yosys "));
  const yosysSynth = Array.from(rows).find(r => r.textContent?.startsWith("yosys_synthesis"));
  return {
    yosys_source: yosys?.querySelector(".chipos-eda-tool-source button")?.textContent,
    yosys_status: yosys?.querySelector(".chipos-eda-tool-status span")?.textContent,
    yosys_synth_status: yosysSynth?.querySelector(".chipos-eda-tool-status span")?.textContent,
    note: "yosys_synthesis MUST show ✓ managed (Bug #1 fix); yosys MUST show auto (Bug #2 fix)",
  };
})()'

# A.8 Cleanup
npx agent-browser close
lsof -ti:9224 | xargs -r kill
lsof -ti:18099 | xargs -r kill
mv "$SETTINGS.bak."* "$SETTINGS" 2>/dev/null || true
```

## Flow B — Company CAD engineer with MCP server

```bash
# B.1 Stage mcp_servers.json with a fake server that advertises tools/list
# (use the test_mcp_server stub pattern from test_lifecycle_mcp_test.py)

# B.2 Verify auto-discover populates provides field
curl -s http://127.0.0.1:18099/api/v1/mcp/servers | jq '.servers[0].provides'

# B.3 Verify panel shows "Connected via MCP" group when provides ≠ []

# B.4 Right-click MCP server → Test connection → asserts latency_ms in toast

# B.5 Edit MCP server (P2 F2 wizard) → modify args → save → re-test
```

## Flow C — Bulk operations (P1 F1)

```bash
# C.1 Open EDA Tools tab
# C.2 Click "Missing only" in impl filter dropdown
# C.3 Click select-all checkbox in column header
# C.4 Click "Disable Selected (N)" button
# C.5 Verify settings.json now has source:disabled for all visible rows
# C.6 Verify panel "Not configured" group shrinks accordingly
```

## Flow D — Strategy preview + undo (P2 F8 + UX #12)

```bash
# D.1 Start with strategy=auto, ≥4 tools resolved managed
# D.2 Click "MCP first" radio → expect QuickPick preview "X tools will change"
# D.3 Confirm → expect undo toast in info notification
# D.4 Click Undo within toast TTL → strategy reverts, panel refreshes
```

## Flow E — F14 requiredTools fail-fast

```bash
# E.1 Set CLI flag --required-tools=vivado,nonexistent_tool
# E.2 Expect worker exit code 64 + stderr "FATAL: --required-tools failure"
PYTHONPATH=packages/execution/src:packages/shared/src python -m execution.server.cli \
  start --workspace /tmp/chipos-ux-ws --http-port 18100 \
  --instance-dir /tmp/chipos-ux-inst-2 --server localhost:50099 \
  --required-tools=nonexistent_tool
echo "Exit code: $?"  # Expect: 64
```

## Flow F — F17 PATH login shell

```bash
# F.1 Add a fake binary to PATH via ~/.zshrc (or bash)
mkdir -p /tmp/fake-eda
ln -sf /bin/echo /tmp/fake-eda/vivado
echo 'export PATH=/tmp/fake-eda:$PATH' >> ~/.zshrc

# F.2 Without restarting IDE, click "I've installed it, rescan" button
# F.3 Expect notification "Detected newly-installed: vivado" within 60s
# F.4 Cleanup: remove the ~/.zshrc line + delete /tmp/fake-eda
```

## Pass criteria

- All Python tests green (79 + new)
- TypeScript type-check 0 errors
- Flow A captures show:
  - WORKER TOOLS panel with `ChipOS Managed (3/3)` + `Not configured` at bottom
  - EDA Tools tab with strategy radios + filter toolbar + sortable table
  - `yosys_synthesis` row shows ✓ managed (NOT ✗ missing — Bug #1)
  - `yosys` row source column shows "auto" (NOT "managed" — Bug #2)
- Flow B captures show MCP server health badge ✓/⚠/✗
- Flow C+D+E+F manual checks pass

## Automation TODO

Move this to a real test runner once CI infra ready:
- Use `@playwright/test` with custom IDE launcher
- Save baseline screenshots; diff per PR
- Promote `npx agent-browser eval` assertions to `expect()`
