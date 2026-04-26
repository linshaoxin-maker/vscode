# ChipOS Remote SSH (Beta)

Connect ChipOS IDE to a remote Linux server via SSH so you can edit code locally on macOS / Windows / Linux while running EDA tools (iverilog, verible, yosys, vivado, …) and the ChipOS execution layer ("Worker") on the remote machine where the toolchain, license server and project source already live.

> **Status: Beta (v0.x).** End-to-end happy path works on Ubuntu / RHEL / CentOS hosts. Some edges are intentionally rough — see _Known Limitations_ below. Please file issues with `[remote-ssh]` in the title.

## Why

Chip designers typically:

- Edit on a laptop (Windows / macOS / Linux)
- Run simulation / synthesis on a Linux server with the EDA toolchain, license server and shared NFS storage

This extension is the bridge: SSH out to the server, install (or reuse) `chipos-worker` there, and let the ChipOS chat / agent talk to it transparently while keeping the editor and UI local.

## How to connect

1. Install ChipOS IDE (≥ v0.x) — this extension is bundled, no separate install needed.
2. Open the Command Palette (`⇧⌘P` / `Ctrl+Shift+P`) and run **ChipOS Remote: Connect to SSH Host…**
3. Type the host (`user@eda-server.company.com[:port]`) or pick from your `~/.ssh/config`.
4. Authenticate (key / passphrase / agent — same as any SSH client).
5. The extension installs / reuses `chipos-worker` on the remote host (default path `~/.chipos-worker`, configurable) and forwards the gRPC port back to your IDE.

If the connection drops, the extension auto-reconnects with exponential backoff (up to 5 attempts, max 30 s between attempts) and restores any port forwards it set up. From v0.x.0 it also raises a notification toast on the second attempt and on final failure so you don't have to watch the Output panel.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `chipos.remote.ssh.defaultHost` | `""` | Pre-fill for the connect quick-pick. |
| `chipos.remote.ssh.configFile` | `~/.ssh/config` | Override SSH config file location. |
| `chipos.remote.ssh.serverInstallPath` | `~/.chipos-server` | Where the Reasoner binary is installed on the remote (only used if you run Reasoner on the same box). |
| `chipos.remote.ssh.workerInstallPath` | `~/.chipos-worker` | Where the Worker binary is installed. Point to an existing install (e.g. `/opt/chipos-backend`) to skip auto-deploy. |

## Available commands

- `ChipOS Remote: Connect to SSH Host…`
- `ChipOS Remote: Connect to SSH Host in Current Window…`
- `ChipOS Remote: Show SSH Log` — opens the SSH output channel (the source of truth for diagnostics).
- `ChipOS Remote: Disconnect from SSH Host`

## Known limitations (Beta)

These are tracked for v0.3+. Treat the current release as production-ready for the happy path on Ubuntu / RHEL / CentOS, but expect rough edges in these areas:

- **Remote ↔ local path translation** is not transparent. Files in the IDE show their absolute remote path; copy/paste that, don't assume a local path.
- **One Worker per host.** Multiple concurrent ChipOS sessions on the same remote host aren't routed independently yet — open multiple hosts (or use Git worktrees) instead.
- **SSH key management UI is minimal.** Configure keys via your `~/.ssh/config` or `chipos.remote.ssh.configFile`. There is no in-IDE key-generator yet.
- **Multi-hop / jump hosts** (bastion) are not directly supported. Use `ProxyCommand` in your local `~/.ssh/config`; the extension will use it transparently.
- **Workspace-wide remote search / indexing** is not synchronized — semantic search and index-based features only see the IDE's local view.
- **No first-class JetBrains / Web IDE parity** with `ms-vscode-remote.remote-ssh` yet; we lift only the slice ChipOS needs (file/command exec to Worker, port-forward to Reasoner). Treat this extension as ChipOS-specific, not a drop-in replacement for the official VS Code Remote-SSH extension.

If any of these blocks your workflow, please file an issue — your input drives priority for v0.3.

## Troubleshooting

| Symptom | First thing to try |
| --- | --- |
| Cannot connect / timeout | Verify `ssh user@host` works from a plain terminal; check firewall / `~/.ssh/config`. |
| Connection drops repeatedly | Open **ChipOS Remote: Show SSH Log** and look for `[SSH] Reconnect attempt …` lines and the underlying error. |
| Worker fails to start | The log will show the exact stderr from the remote. Common causes: `python3 not on PATH`, missing `langchain_mcp_adapters`, locked install path. |
| "ChipOS Remote: lost connection after 5 attempts" toast | Click _Show Logs_ for the cause, then _Reconnect_ once the underlying issue is resolved. |
| Stale port forward (`EADDRINUSE`) | Disconnect and reconnect — `_rebuildPortForwards` closes stale local listeners on reconnect, but a manual disconnect/reconnect is the safe reset. |

## License

MIT — see `LICENSE` in the repository root.
