/**
 * lzpack 的错误类型。
 *
 * 契约（见 README「约定」）：
 * - 继承 `Error`；
 * - 实例满足 `err instanceof LzError`；
 * - `err.name === 'LzError'`。
 */
export class LzError extends Error {
  constructor(message, options) {
    super(message, options);
    throw new Error("not implemented");
  }
}
