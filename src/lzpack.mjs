/**
 * lzpack —— 确定性 LZ77 打包库。
 *
 * 线格式与 11 条对外契约见仓库根目录的 README.md。
 * 本文件是空壳：导出面齐全，任何调用都抛 `not implemented`。
 */
import { LzError } from './errors.mjs';

export { LzError };

/**
 * 把字节流编码为 lzpack 字节流。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {Uint8Array}
 */
export function encode(bytes) {
  throw new Error("not implemented");
}

/**
 * 把 lzpack 字节流解码回原始字节流。
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{}} [opts] 保留参数；接受省略、`undefined` 与 `{}`.
 * @returns {Uint8Array}
 */
export function decode(bytes, opts) {
  throw new Error("not implemented");
}

/**
 * 解析一份编码产物，返回其 token 统计。
 *
 * @param {Uint8Array|Buffer} encoded `encode` 的产物
 * @returns {{literals: number, matches: number, literalBytes: number, matchBytes: number}}
 */
export function stats(encoded) {
  throw new Error("not implemented");
}
