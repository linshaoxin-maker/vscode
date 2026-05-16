# Vivado / Xilinx 安装指引

> ChipOS 检测到 `vivado` 不在 PATH 上。此工具用于 FPGA 综合和 bitstream 烧录
> (`fpga_synthesize` / `fpga_program` 两个 MCP tool 依赖它)。
>
> **预期耗时**: 90-120 分钟（含下载 12 GB + 跑 installer + 配 license）。
> **磁盘需求**: 60 GB（Vivado ML Standard 装完展开后）。
> **平台**: Linux x86_64 / Windows 10+。macOS **不支持**（请改用远程 Linux + ChipOS SSH 模式）。

---

## 步骤 1: 注册 AMD/Xilinx 账号

Vivado 下载必须登录账号。**先把账号申请好**，否则下到一半被跳登录会卡住。

1. 打开账号注册页（**不是**下载页）：
   https://www.xilinx.com/registration/create-account.html
2. 填写：邮箱 / 姓名 / 公司（个人填 `Individual` 即可）/ 国家。
3. AMD/Xilinx 会发激活邮件到注册邮箱 — 点链接激活。
4. 重新登录: https://login.xilinx.com/

> **避坑**: 用 Gmail/QQ 等公共邮箱通常没问题；公司邮箱有时会被风控延迟 1-3 天才发激活邮件。

---

## 步骤 2: 下载 Vivado ML Standard (免费版)

Vivado ML Standard 是免费的（不是 ML Enterprise），覆盖大部分 FPGA 7-series / UltraScale 设备。

1. 登录后进入下载页:
   https://www.xilinx.com/support/download/index.html/content/xilinx/en/downloadNav/vivado-design-tools.html
2. 选择 **Vivado ML Standard 2024.x** 或最近的版本。
3. **推荐**: 下 `Unified Installer SFD`（Single File Download，约 12 GB tar.gz）— 一次下完，比 Web Installer 稳。
4. 下载过程会要求填 **U.S. Export Compliance** 表格 — 国家选所在地，公司类型选 `Commercial`，用途选 `Personal use / Education / R&D`。
5. 等下载完成（千兆校园网约 30 分钟；家用 100M 约 2 小时）。

---

## 步骤 3: 安装

### Linux

```bash
# 解压
cd ~/Downloads
tar -xzf Xilinx_Unified_*_*.tar.gz
cd Xilinx_Unified_*_*

# 装依赖 (Ubuntu/Debian)
sudo apt-get install -y libtinfo5 libncurses5 libxrender1 libxtst6 libxi6

# 跑 installer (GUI 模式)
./xsetup
```

GUI 步骤：

1. **Welcome** → Next
2. **Select Product** → `Vivado` → Next
3. **Select Edition** → `Vivado ML Standard`（免费）→ Next
4. **Vivado ML Standard** 默认勾选 7 Series / UltraScale → Next
5. **Accept License Agreements** → 全部勾选 → Next
6. **Select Destination Directory** →
   - 默认 `/tools/Xilinx` 需要 sudo。**推荐改成** `~/Xilinx` （免 sudo）
   - 取消勾选 `Create program group entries`（Linux 无意义）
7. **Installation Summary** → Install → 等 30-45 分钟

### Windows

直接双击 `xsetup.exe`，步骤同上。装到 `C:\Xilinx`。

---

## 步骤 4: 申请并安装 WebPACK License （**最容易卡死的一步**）

Vivado ML Standard 免费，但**必须有 license 文件**才能运行 synth/impl/bitgen。

1. 打开 Vivado License Manager:
   - Linux: `source ~/Xilinx/Vivado/2024.x/settings64.sh && vlm`
   - Windows: 开始菜单 → Xilinx Design Tools → Vivado License Manager
2. 切到 **Obtain License** 标签 → 选 `Get Free Vivado/Vitis ML Standard License`
3. 跳转浏览器到 license 申请页面（自动带账号）
4. 填一份 license 表单 — 选 `Vivado Design Suite: WebPACK License` → Generate Node-Locked License
5. AMD/Xilinx 邮件发来 `.lic` 文件 — 下载到本机。
6. 回到 License Manager → **Manage License** → **Load License** → 选刚下的 `.lic` 文件。
7. 看到 `License install completed successfully` 就 OK。

> **避坑**: license 文件是绑 MAC 地址的（node-locked）。换网卡或换机器后要重新申请。

---

## 步骤 5: 配 PATH

Linux:

```bash
# 把这两行加到 ~/.bashrc 或 ~/.zshrc
export VIVADO_INSTALL_DIR=$HOME/Xilinx/Vivado/2024.2  # 改成你的版本号
source "$VIVADO_INSTALL_DIR/settings64.sh"

# 让当前 shell 立刻生效
source ~/.bashrc

# 验证
which vivado
vivado -version
```

预期输出类似:

```
/home/<user>/Xilinx/Vivado/2024.2/bin/vivado
Vivado v2024.2 (64-bit)
SW Build 5239630 on Fri Nov 08 22:34:34 MST 2024
```

Windows: installer 装完后 PATH 默认就有 `vivado.bat`。打开新的 PowerShell 跑 `vivado -version` 验证。

---

## 步骤 6: 回 ChipOS 通知里点 "I've installed it, rescan"

ChipOS worker 已经在跑了，**不需要**重启 IDE — 直接点通知里的"我已安装完成，重新检测"按钮，worker 会重扫 PATH，看到 `vivado` 就把状态栏的 `EDA: 19/24` 更新成 `20/24`。

如果点了之后通知说 "no newly-installed tools detected"：

- 检查 `which vivado` 是不是真的能跑通
- 检查 ChipOS IDE 启动时的 shell 是不是有 source `~/.bashrc`（GUI 启动的 IDE 有时候不读 `.bashrc`，要把 export 加到 `~/.profile` 或登录脚本里）
- 完全保底: quit + 重启 ChipOS IDE

---

## 已知问题

- **Vivado 启动 ~30 秒挂着不响应**: 第一次启动会扫 license + 缓存 IP catalogs，正常。后续启动 5 秒内出 prompt。
- **`vivado -nojournal -nolog -mode batch` 跑 synth 时报 ERROR: [Common 17-356] license unavailable**: 通常是 license 文件没装好。回 License Manager 看 `Manage License` 列表里有没有 `Vivado_System` 行。
- **license 报 "INCREMENT line type mismatch"**: license 文件被复制到了错误版本目录 — 重新申请一次绑当前 Vivado 版本的 license。
