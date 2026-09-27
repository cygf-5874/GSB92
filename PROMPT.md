编码结果必须唯一，这点比压缩率更要紧。lzpack 是 Node.js 22 的 LZ77 打包库
（ESM，只用 node: 内置模块，没有第三方依赖），自检走 `scripts/check.sh`
（`check/` 是固定验收程序，别改）。

README 里「线格式」一节把字节布局写死了，「对外契约」有 11 条；`src/` 下两个模块是空壳。
这道题不提供既有用例，正确性全靠固定件。

任务：按 README 把 `encode`、`decode`、`stats` 做出来，让固定件全过。

验收：
- node --test 退出码 0（仓库根目录裸跑；没有测试文件时视为通过）；
- node check/check.mjs 退出码 0，11 个场景全过（roundtrip 3 + match 3 + errors 3 + stats 1 + determinism 1）。

约束：
1. 不改 `check/`；可以新增文件，但 `src/lzpack.mjs` 的导出名不许改。
2. 只用 `node:` 内置模块，`package.json` 里不许出现 `dependencies`。
3. 不许用 `zlib`、`Buffer` 的压缩接口或其他现成压缩实现。
4. 结果必须确定：不许用 `Math.random`、`Date.now`。
