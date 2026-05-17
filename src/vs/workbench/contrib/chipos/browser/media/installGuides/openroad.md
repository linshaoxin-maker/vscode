# OpenROAD / ORFS 安装指引

> ChipOS 检测到 `openroad` 不在 PATH 上。这是开源 ASIC 物理设计工具，
> 5 个 MCP tool 依赖它: `orfs_setup` / `orfs_init_design` / `orfs_update_config` /
> `orfs_run_make` / `orfs_collect_results`。
>
> **预期耗时**: 60-120 分钟（编译 OpenROAD-flow-scripts，含依赖）。
> **磁盘需求**: 20 GB（含 PDK + 工具二进制 + 中间产物）。
> **平台**: Linux x86_64 (推荐 Ubuntu 22.04/24.04) / macOS（仅 Docker 模式）。

---

## 方案选择

ChipOS 支持三种安装方式：

| 方式 | 适用 | 耗时 | 风险 |
|---|---|---|---|
| (1) **OpenROAD-flow-scripts 本地编译** | 长期开发，自定 PDK | 60-120 min | 编译依赖多，新机器最容易卡住 |
| (2) **预编译二进制** | 快速试用 | 5-10 min | 仅 Ubuntu 22.04 提供官方 binary |
| (3) **Docker 镜像** | 隔离环境 / macOS | 15-30 min | 需要 Docker，调试不直观 |

**推荐**: 长期用走 (1)，先试一下走 (2)。

---

## 方案 (1): OpenROAD-flow-scripts 本地编译

```bash
# 选个常用位置（不一定要 /opt，但 install 脚本默认会写 /opt 路径）
sudo mkdir -p /opt/orfs && sudo chown $(whoami):$(whoami) /opt/orfs
cd /opt/orfs

# clone（约 200 MB）
git clone --depth 1 --recursive https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts.git .

# 装系统依赖（脚本会探测 Ubuntu/Fedora/etc 并 apt/dnf）
sudo ./etc/DependencyInstaller.sh

# 编译 (CPU 强建议 -j8 起，编译 OpenROAD 主体 + Yosys + 其他)
./build_openroad.sh --local

# 编译完产物在 ./tools/install/OpenROAD/bin/openroad
```

> **避坑**:
> - `DependencyInstaller.sh` 在 Ubuntu 24.04 上有时报 `libstdc++` 版本不对 —
>   要 `sudo apt install gcc-13 g++-13 && export CC=gcc-13 CXX=g++-13` 后再跑。
> - 编译会被 GitHub 限速干扰（拉 boost / kdtree / pdk-utility）—
>   失败重跑即可，已下完的不会重复。
> - 全程 ~60-90 分钟（i7-12700H, -j16, Ubuntu 22.04）。8 GB 内存可能 OOM —
>   推荐 16 GB 起。

配 PATH:

```bash
echo 'export PATH=/opt/orfs/tools/install/OpenROAD/bin:$PATH' >> ~/.bashrc
echo 'export PATH=/opt/orfs/tools/install/yosys/bin:$PATH' >> ~/.bashrc
echo 'export FLOW_HOME=/opt/orfs/flow' >> ~/.bashrc
source ~/.bashrc

# 验证
which openroad
openroad -version
```

预期:

```
/opt/orfs/tools/install/OpenROAD/bin/openroad
v2.0-13456-gabcdef
```

---

## 方案 (2): 预编译二进制 (Ubuntu 22.04 only)

> 不在 Ubuntu 22.04 的话**跳过**走方案 (1) 或 (3)。

```bash
# 从 GitHub Releases 拿预编译 .deb
cd /tmp
wget https://github.com/The-OpenROAD-Project/OpenROAD/releases/latest/download/openroad_2.0.0-1_amd64-ubuntu22.04.deb

# 装
sudo apt install -y ./openroad_2.0.0-1_amd64-ubuntu22.04.deb

# 验证
which openroad
openroad -version
```

ORFS flow scripts 还是要拿一份，但**不用**编译:

```bash
git clone https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts.git ~/orfs
echo 'export FLOW_HOME=$HOME/orfs/flow' >> ~/.bashrc
source ~/.bashrc
```

---

## 方案 (3): Docker

```bash
# 拉镜像（约 3 GB）
docker pull openroad/orfs:latest

# 跑工具
docker run --rm -it -v $(pwd):/work openroad/orfs:latest openroad -version
```

ChipOS worker 不会自动用 docker 跑 openroad — 走这条路要在你的 `~/.zshrc` / `~/.bashrc` 里加 wrapper 函数：

```bash
openroad() {
    docker run --rm -i -v "$(pwd):/work" -w /work openroad/orfs:latest openroad "$@"
}
```

> **警告**: docker wrapper 会让 ChipOS 看到 `openroad`，但 ORFS make 链路里 spawn 的子工具
> （如 `yosys` / `klayout`）需要单独 wrap，复杂度高。**只推荐 macOS 用户**用这条路。

---

## 步骤 4: 装完后回 ChipOS 点 "I've installed it, rescan"

点了之后状态栏会 +1，并弹一条 `Detected newly-installed EDA tools: openroad`。

如果点了通知说 "no newly-installed tools detected":

- `which openroad` 在终端能找到吗？
- `echo $PATH` 是不是有 OpenROAD 装的 bin 目录？
- ChipOS IDE 启动时的环境是否读了 `~/.bashrc`？
  （Linux GUI 启动有时不读 `.bashrc`，加到 `~/.profile` 或登录 shell 里）

完全保底: quit + 重启 ChipOS IDE 一次。

---

## 已知问题

- **`openroad -version` 报 GLIBC_2.32 not found**: Ubuntu 20.04 系统 GLIBC 太老，要么升级 22.04 要么走 Docker。
- **ORFS `make` 报 `flow_summary.html` 不存在**: 中途某步骤失败但 ORFS 没退出，跑 `make logs` 看最后 stderr。常见原因: PDK 路径错 / `DESIGN_NAME` 没设。
- **PDK 缺失**: ORFS 默认带 `nangate45` PDK；要 `sky130` 需要单独跑 `cd flow/platforms/sky130hd && make download`。
