# logicprobe 模型归档（可复现哈希）

| 模型 | 文件 | 校验工具 | 结果 | modelHash |
|---|---|---|---|---|
| 导入作业状态机 v9（13 状态 / 21 转移） | `import-job.sm.v9.json` | `logicprobe_verify` | 0 error（S1-S4/S6-S8 + A3-A14 全过，A4 锁平衡） | `0e6eeaf667e374349aa0da5839c8bd0ed53d4577ee81516063681604648aef02` |
| 数据模型归档变体（15 实体；约束集与首轮一致，字段做了裁剪） | `vault.dm.v2.json` | `logicprobe_datamodel_verify` | 0 error（DS1-DS4 / DA1,4-12 全过；DA2/DA3 各 4/6 条预期警告） | `a4ae16a11f51bdc1f218f0167e5612f4873253446bab3ed74259327b97c520b8` |
| （首轮全字段版，未归档） | — | `logicprobe_datamodel_verify` | 0 error | `6a641bc318908424cf2bcdf6a7d377bc4f7e01ce1e55745976d4f64508b52295` |

复现方式：把对应 JSON 作为 `model` 参数传给同名工具，比较返回的 `modelHash`。
注意：`packages/core/src/contracts.ts` 的 `resolveTransition` 是 SM 模型的可执行镜像；
verifier 的 `test/machine/*.test.ts` 对 13×15 全矩阵逐格断言——两者必须同步修改（改一处即需重跑两个测试）。
