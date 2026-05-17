# oss-cad-suite (yosys / iverilog / verilator / sv2v) 安装指引

> ChipOS 检测到 `yosys` / `iverilog` / `verilator` / `sv2v` 中至少一个不在 PATH 上。
> 这些是开源 EDA 工具集 [`oss-cad-suite`](https://github.com/YosysHQ/oss-cad-suite-build)
> 提供的核心工具，被 15+ 个 MCP tool 依赖。
>
> **大多数情况你不需要手动装** — ChipOS worker 启动时会自动下载 `oss-cad-suite`
> （通过 `EdaPackManager`）。这份指引适用于:
> - 自动下载失败（网络受限 / GitHub 限速）
> - 自定义 oss-cad-suite 版本
> - 已经手动装在系统其他位置，想让 ChipOS 复用

---

## 方案 A: 等待 ChipOS 自动安装（推荐）

ChipOS worker 启动时会:

1. 检测 `~/.chipos/eda-pack/oss-cad-suite-<version>/` 是否存在
2. 如果不存在，从 GitHub releases 拉对应平台的 tarball（约 800 MB - 1.5 GB）
3. 展开到上述目录
4. 加进 worker 的 PATH

进度通过 stderr `[EdaPack]` 行传给 IDE，状态栏会显示下载进度。如果看到状态栏卡在
某个百分比超过 10 分钟，看下方 "故障排查"。

---

## 方案 B: 手动下载 (网络受限或想换版本)

### Linux x86_64

```bash
mkdir -p ~/.chipos/eda-pack
cd ~/.chipos/eda-pack

# 拿最新版（替换 <date> 为最新 release tag，见 releases 页）
wget https://github.com/YosysHQ/oss-cad-suite-build/releases/download/2024-XX-XX/oss-cad-suite-linux-x64-YYYYMMDD.tgz

# 展开（约 5 分钟）
tar -xzf oss-cad-suite-linux-x64-*.tgz

# 看到 oss-cad-suite/ 目录就 OK
ls oss-cad-suite/bin/yosys
```

ChipOS worker 启动时会自动用 `~/.chipos/eda-pack/oss-cad-suite/` 这个路径，**不需要**改 PATH。

### macOS (Apple Silicon)

```bash
mkdir -p ~/.chipos/eda-pack
cd ~/.chipos/eda-pack

wget https://github.com/YosysHQ/oss-cad-suite-build/releases/download/2024-XX-XX/oss-cad-suite-darwin-arm64-YYYYMMDD.tgz
tar -xzf oss-cad-suite-darwin-arm64-*.tgz
```

第一次跑 yosys macOS 会拦 Gatekeeper —

```bash
# 给 oss-cad-suite 整个目录祛魅
xattr -dr com.apple.quarantine ~/.chipos/eda-pack/oss-cad-suite/
```

### Windows

```powershell
# PowerShell
$dir = "$env:USERPROFILE\.chipos\eda-pack"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Set-Location $dir

# 下 zip （替换日期）
Invoke-WebRequest -Uri "https://github.com/YosysHQ/oss-cad-suite-build/releases/download/2024-XX-XX/oss-cad-suite-windows-x64-YYYYMMDD.zip" -OutFile "oss-cad-suite.zip"

# 展开
Expand-Archive -Path "oss-cad-suite.zip" -DestinationPath .
```

---

## 方案 C: 用系统包管理器装（不推荐）

可以装 `apt install yosys iverilog verilator`，但**版本通常落后 2-3 年**，
某些 ChipOS 用到的 SystemVerilog 语法（如 `interface modport`、`unique case`）
旧版 yosys/iverilog 不支持，会跑出 syntax error。

**推荐用方案 A 或 B**，强制 ChipOS 自动下的版本。

---

## 验证

```bash
# 让 ChipOS 装的版本在 PATH 上（如果是手动方案 B/C）
source ~/.chipos/eda-pack/oss-cad-suite/environment    # Linux/macOS
# 或 .\.chipos\eda-pack\oss-cad-suite\environment.bat  # Windows

# 检查各工具
yosys -V          # 期望: Yosys 0.40+ (git sha:...)
iverilog -V       # 期望: Icarus Verilog version 12.0+
verilator --version  # 期望: Verilator 5.020+
sv2v --version    # 期望: v0.0.12+
```

---

## 故障排查

### ChipOS 状态栏一直显示 `EdaPack 0/100%`

worker 没下载下来。原因可能:

- **GitHub 限速**: 直接 `curl -I https://github.com/YosysHQ/oss-cad-suite-build/releases/latest`
  看返回。如果是 403，等几分钟或挂代理。
- **磁盘空间**: `df -h ~` 看 `~/.chipos/` 所在分区，至少留 3 GB。
- **网络代理**: ChipOS worker 默认走 `HTTPS_PROXY` 环境变量；如果你的代理只对
  特定 shell 有效，ChipOS IDE 启动时没继承到。把 `HTTPS_PROXY=http://...`
  放进 `~/.profile` 或登录脚本。

### `yosys -V` 报 `error while loading shared libraries: libtcl8.6.so`

oss-cad-suite 带的 libtcl 跟系统的冲突。`apt install libtcl8.6` 即可。

### macOS `yosys: bad CPU type in executable`

下错平台（下了 x86_64 装在 Apple Silicon）。重下 `-darwin-arm64-` 版本。

---

## 装完后

回 ChipOS 通知里点 **"我已安装完成，重新检测"** — worker rescan 后会把这几个工具
都标 ok，状态栏 `EDA: X/24` 会一次跳 +3 ~ +4。
