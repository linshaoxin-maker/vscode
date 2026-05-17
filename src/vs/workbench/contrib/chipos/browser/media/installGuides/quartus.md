# Quartus Prime / Intel FPGA 安装指引

> ChipOS 检测到 `quartus_sh` / `quartus_pgm` 不在 PATH 上。这是 Intel/Altera FPGA
> 的综合 + 烧录工具链，作为 `fpga_synthesize` / `fpga_program` 的 Vivado 备选 backend。
>
> **预期耗时**: 60-90 分钟（含下载 9 GB + installer）。
> **磁盘需求**: 30 GB。
> **平台**: Linux x86_64 / Windows。

---

## 步骤 1: 注册 Intel 账号

1. 注册页: https://www.intel.com/content/www/us/en/forms/global-quartus-registration.html
2. 收激活邮件 → 激活。
3. 登录: https://login.intel.com/

> **注意**: AMD 收购 Xilinx 之后 Altera 被 Intel 收购、又被剥离回 Altera Inc. — 短期 Quartus 下载入口可能在 intel.com 或 altera.com 之间漂移。**以 Intel 域名为准**，altera.com 现在重定向回 intel.com。

---

## 步骤 2: 下载 Quartus Prime Lite (免费版)

1. 下载页:
   https://www.intel.com/content/www/us/en/software-kit/quartus-prime-lite-edition.html
2. 选 **Quartus Prime Lite** （不是 Standard/Pro — 那两个收费）。
3. 选最新版本 (24.x 或 23.x，**Lite 版只支持低端 FPGA 系列**: Cyclone IV / V / 10 LP / MAX 10)。
4. 下载页会让你勾要装哪些 device support pack:
   - **必勾**: Cyclone (你的目标设备系列)
   - 不需要的不勾，能省 3-5 GB。
5. 下载 `qinst-lite-linux-XX.X.X.X.tar` (Linux) 或 `qinst-lite-windows-XX.X.X.X.exe` (Windows)。

---

## 步骤 3: 安装

### Linux

```bash
tar -xf qinst-lite-linux-*.tar
./setup.sh
```

GUI 步骤:

1. **License Agreement** → Accept → Next
2. **Installation directory** → 推荐 `~/intelFPGA_lite/24.1` (改成对应版本号)
3. **Select Components** → 默认勾 `Quartus Prime Lite Edition` + `Cyclone` device family
4. **Installation Summary** → Install → 等 20-30 分钟
5. 装完弹窗问要不要装 USB Blaster driver — **选 Yes**（烧 FPGA 必需）。

### Windows

双击 `qinst-lite-windows-*.exe`，步骤同上，默认装到 `C:\intelFPGA_lite\<version>`。

---

## 步骤 4: License（Quartus Lite 不需要 license 文件）

Quartus Prime Lite 是真免费 — 装完直接能跑 synth/fit/asm/sta。**不需要**像 Vivado 那样申请 license 文件。

> Standard/Pro 才需要 license。如果你用的是 Standard/Pro，license 申请走 Intel Self Service Licensing Center: https://fpgasupport.intel.com/Licensing/license/index.html

---

## 步骤 5: 配 PATH

Linux:

```bash
# 加到 ~/.bashrc 或 ~/.zshrc
export QUARTUS_ROOTDIR=$HOME/intelFPGA_lite/24.1/quartus
export PATH=$QUARTUS_ROOTDIR/bin:$PATH

# 立刻生效
source ~/.bashrc

# 验证
which quartus_sh
quartus_sh --version
```

预期输出:

```
/home/<user>/intelFPGA_lite/24.1/quartus/bin/quartus_sh
Quartus Prime Shell
Version 24.1.0 Build 115 03/19/2024 SC Lite Edition
```

Windows: installer 默认配好 PATH。打开新 PowerShell 跑 `quartus_sh --version` 验证。

### USB Blaster (烧录用)

Linux 用 USB Blaster 需要 udev rule:

```bash
sudo tee /etc/udev/rules.d/51-altera-usb-blaster.rules <<'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="09fb", ATTR{idProduct}=="6001", MODE="0666"
SUBSYSTEM=="usb", ATTR{idVendor}=="09fb", ATTR{idProduct}=="6002", MODE="0666"
SUBSYSTEM=="usb", ATTR{idVendor}=="09fb", ATTR{idProduct}=="6003", MODE="0666"
SUBSYSTEM=="usb", ATTR{idVendor}=="09fb", ATTR{idProduct}=="6010", MODE="0666"
EOF
sudo udevadm control --reload-rules
```

插上 USB Blaster 后跑 `jtagconfig` — 看到 `1) USB-Blaster ... [USB-0]` 就 OK。

---

## 步骤 6: 回 ChipOS 通知里点 "I've installed it, rescan"

点了之后状态栏 `EDA: X/24` 应该 +1，并弹一条 `Detected newly-installed EDA tools: quartus_sh`。

---

## 已知问题

- **`quartus_sh` 启动慢 (~10 秒)**: 第一次跑会初始化 user prefs，正常。
- **`jtagd` 服务**: USB Blaster 编程时如果报 `Error: No JTAG hardware available`，跑 `killall jtagd && jtagd` 重启它。
- **License Error 即使是 Lite 版**: 通常是装错了 Standard/Pro — 检查 Quartus 启动 banner 是不是写 `Lite Edition`。
