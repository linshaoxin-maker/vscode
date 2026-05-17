# ChipOS EDA Tool 安装指引

ChipOS worker 依赖 7 个外部 EDA 工具家族。这里是分家族的安装指引。

| 工具 | 分类 | ChipOS 自动安装? | 指引 |
|---|---|---|---|
| `yosys` / `iverilog` / `verilator` / `sv2v` | 开源 | **是** (oss-cad-suite) | [oss-cad-suite.md](./oss-cad-suite.md) |
| `openroad` | 开源（物理设计） | 否 | [openroad.md](./openroad.md) |
| `vivado` | Xilinx 商用 | 否（需 license） | [vivado.md](./vivado.md) |
| `quartus_sh` / `quartus_pgm` | Intel 商用 | 否 | [quartus.md](./quartus.md) |

---

## 我应该装哪些？

**取决于你跑什么任务：**

- **只跑 RTL 仿真 + lint**: `yosys` + `iverilog` 就够 (oss-cad-suite 自动装)
- **加上 SystemVerilog 综合**: 上面 + `verilator` + `sv2v`（同样 oss-cad-suite）
- **要跑 PPA / 物理设计**: 加 `openroad` (单独装)
- **要烧 FPGA**: Vivado 或 Quartus 二选一（看你板卡 vendor）

24 个 MCP tool 的依赖关系详见
[`EDA-PACK-AUDIT.md`](../../../../../../../../document/backend-v2-migration/03-architecture/EDA-PACK-AUDIT.md) §2。

---

## 装完后

每装完一个工具，**不需要重启 ChipOS IDE** — 直接点 EDA 缺失通知里的
**"我已安装完成，重新检测"** 按钮，worker 会原地重扫 PATH。状态栏的
`EDA: X/24` 会立即更新。

如果点了之后没反应，看对应工具指引里的"故障排查"章节。
