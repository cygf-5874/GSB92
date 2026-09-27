# lzpack

确定性 LZ77 打包库。Node.js 22、ESM，只用 `node:` 内置模块，**零第三方依赖**。

- 入口：`src/lzpack.mjs`（导出 `encode` / `decode` / `stats` / `LzError`）
- 错误类型：`src/errors.mjs`（导出 `LzError`）
- 自检：`bash scripts/check.sh`（等价于在仓库根目录执行 `node check/check.mjs`）
- 固定验收程序：`check/check.mjs`（**不要修改**）

```bash
node check/check.mjs            # 跑全部场景
node check/check.mjs -list      # 只列出 组/名
node check/check.mjs --only roundtrip
bash scripts/check.sh --only errors
```

---

## 线格式

`encode` 的产物是一个**字节流**，由若干 **token** 顺序拼接而成。每个 token 由
「1 个首字节 + 载荷」组成，首字节的**最高位是类型位**。

### 字面量 token

| 字段 | 字节数 | 取值 |
| --- | --- | --- |
| 首字节 | 1 | `0x00 \| (len - 1)`，`len ∈ 1..128`，故首字节 ∈ `0x00..0x7F` |
| 原始字节 | `len` | 逐字节原样拷贝 |

### 匹配 token

| 字段 | 字节数 | 取值 |
| --- | --- | --- |
| 首字节 | 1 | `0x80 \| (len - 3)`，`len ∈ 3..130`，故首字节 ∈ `0x80..0xFF` |
| offset | 2 | **小端**无符号整数，`offset ∈ 1..32768` |

匹配的含义：**从当前输出位置往前 `offset` 字节处，复制 `len` 个字节**。
复制过程按字节顺序进行，因此**允许 `offset < len`（自复制 / 重叠复制）**：
先写出去的字节会被本次复制继续当作源使用。

`offset = 0` 不可能由编码器产生，属于**非法 token**。

### 编码规则（保证编码唯一）

从位置 `0` 开始，反复执行：

1. 在当前输出位置，于 **32 KiB 滑动窗口**（`offset ≤ 32768`，且不越过输入开头）内找
   **最长**匹配（长度上限 `130`，且不超过剩余输入）；
2. **并列时取最近**（`offset` 最小）；
3. 若最长匹配长度 `≥ 3`：输出一个匹配 token，位置前进该长度；
4. 否则：该字节并入**当前字面量 token**。字面量连续收集，最多 `128` 字节；
   一旦「下一个位置的最长匹配 `≥ 3`」或已满 `128` 字节，就把当前字面量 token 封口输出。

空输入编码为**空字节流**。以上规则使得**同一输入只有一种合法编码**。

---

## 导出面

- `encode(bytes) -> Uint8Array`
- `decode(bytes, opts) -> Uint8Array`
- `stats(encoded) -> { literals, matches, literalBytes, matchBytes }`
- `LzError`（由 `src/errors.mjs` 定义，`src/lzpack.mjs` 一并再导出）

## 对外契约（11 条）

① `encode` 必须在 32 KiB 滑动窗口内取**最长**匹配。
② 并列时取**最近**（`offset` 最小）的匹配。
③ 匹配长度 `< 3` 一律输出字面量。
④ `decode(encode(x))` 与 `x` **逐字节相同**（任意输入，含空输入与超长输入）。
⑤ `decode` 必须拒绝**越界 offset**（`offset > 已输出长度`）、**非法 token**（`offset = 0`）、
**截断载荷**（token 声明的载荷不足）→ 抛 `LzError`；不得返回部分结果，也不得抛 `RangeError`。
⑥ 编码**确定性**：同一输入任意次编码**逐字节相同**。
⑦ `stats(encoded)` 的四个字段必须与**编码产物本身**逐字段一致：`literals` / `matches` 为
token 个数，`literalBytes` 为字面量 token 的原始字节总量，`matchBytes` 为匹配 token 展开后的
字节总量。固定件会自己解析产物核对，不采信内部计数。
⑧ 边界：空输入 → 空输出；单字节输入；全同字节（长匹配）；输入 `> 32768` 字节（窗口滑出）
都必须正确。
⑨ 纯函数：无模块级可变状态，`encode` 可重入。
⑩ 接受 `Uint8Array` 与 `Buffer`，一律返回 `Uint8Array`；不同输入之间不得相互影响。
⑪ 结果不得依赖 `Map` / `Set` 的迭代顺序。

### 约定

- `decode` 的 `opts` 是**保留参数**：实现必须接受省略、`undefined` 与 `{}`；当前未定义任何选项字段。
- `LzError`（`src/errors.mjs` 导出）必须继承 `Error`，其实例满足
  `err instanceof LzError` 且 `err.name === 'LzError'`。
- `encode` / `decode` 一律返回 `Uint8Array`（即使入参是 `Buffer`）。
- 输出不得依赖 `Math.random()`、`Date.now()` 等非确定来源。

---

## 约束

- 只用 `node:` 内置模块；`package.json` 里**不许出现 `dependencies`**。
- 不许用 `zlib`、`Buffer` 的压缩接口或其他现成压缩实现。
- 不改 `check/`；可以新增文件，但 `src/lzpack.mjs` 的导出名不许改。
