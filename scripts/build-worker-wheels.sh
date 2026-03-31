#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# build-worker-wheels.sh
#
# CI 构建脚本：构建 Worker wheel 包并复制到 IDE resources 目录。
# 用法：在 coderust 根目录下执行  bash vscode/scripts/build-worker-wheels.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BACKEND_ROOT="$REPO_ROOT/backend_v2"
SHARED_PKG="$BACKEND_ROOT/packages/shared"
EXECUTION_PKG="$BACKEND_ROOT/packages/execution"
RESOURCE_DIR="$REPO_ROOT/vscode/extensions/chipos-remote-ssh/resources/chipos-worker"

echo "=== Build Worker Wheels ==="
echo "Backend root : $BACKEND_ROOT"
echo "Resource dir : $RESOURCE_DIR"

# 0. 检查 poetry
if ! command -v poetry &>/dev/null; then
    echo "ERROR: poetry not found. Install with: pip install poetry" >&2
    exit 1
fi

# 1. 清理旧产物
rm -rf "$SHARED_PKG/dist" "$EXECUTION_PKG/dist"
mkdir -p "$RESOURCE_DIR"
rm -f "$RESOURCE_DIR"/*.whl "$RESOURCE_DIR/deps.txt"

# 2. 构建 shared wheel
echo "--- Building shared wheel ---"
(cd "$SHARED_PKG" && poetry build -f wheel)
cp "$SHARED_PKG"/dist/*.whl "$RESOURCE_DIR/"
echo "  -> $(ls "$SHARED_PKG"/dist/*.whl)"

# 3. 构建 execution wheel
echo "--- Building execution wheel ---"
(cd "$EXECUTION_PKG" && poetry build -f wheel)
cp "$EXECUTION_PKG"/dist/*.whl "$RESOURCE_DIR/"
echo "  -> $(ls "$EXECUTION_PKG"/dist/*.whl)"

# 4. 从 execution 的 pyproject.toml 提取第三方依赖，写入 deps.txt
#    跳过 python、本地路径依赖（chipos-shared）
echo "--- Generating deps.txt ---"
PYPROJECT="$EXECUTION_PKG/pyproject.toml"
IN_DEPS=0
> "$RESOURCE_DIR/deps.txt"

while IFS= read -r line; do
    # 检测进入 [tool.poetry.dependencies] 段
    if [[ "$line" =~ ^\[tool\.poetry\.dependencies\] ]]; then
        IN_DEPS=1
        continue
    fi
    # 检测离开段落
    if [[ "$IN_DEPS" -eq 1 && "$line" =~ ^\[ ]]; then
        IN_DEPS=0
        continue
    fi
    if [[ "$IN_DEPS" -eq 0 ]]; then
        continue
    fi

    # 跳过空行和注释
    trimmed="$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue

    # 跳过 python
    [[ "$trimmed" == python* ]] && continue

    # 跳过本地路径依赖（包含 path =）
    [[ "$trimmed" == *"path ="* || "$trimmed" == *"path="* ]] && continue

    # 解析: name = "^1.26.0" 或 name = ">=1.60.0"
    if [[ "$trimmed" =~ ^([a-zA-Z0-9_-]+)[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
        name="${BASH_REMATCH[1]}"
        version="${BASH_REMATCH[2]}"
        # 转换 ^ 为 >=
        if [[ "$version" == ^* ]]; then
            version=">=${version:1}"
        fi
        echo "${name}${version}" >> "$RESOURCE_DIR/deps.txt"
    fi
done < "$PYPROJECT"

echo "  -> deps.txt contents:"
cat "$RESOURCE_DIR/deps.txt" | sed 's/^/     /'

# 5. 汇总
echo ""
echo "=== Done ==="
echo "Files in $RESOURCE_DIR:"
ls -lh "$RESOURCE_DIR"
