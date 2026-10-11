/**
 * 默认标签（v3 需求 §4.2）——只播种一次（settings.tags_seed_version），用户删掉不会被复活。
 * 身份 = (namespace, name)；color 只是显示用，不作为身份。
 * 分类 ≠ 标签：「连衣裙」是子分类，「哥特风」是标签。
 */
export interface DefaultTag { name: string; color?: string; namespace?: string; sort?: number }

export const DEFAULT_TAGS: readonly DefaultTag[] = [
  { name: "哥特风", color: "#8b5cf6", sort: 10 },
  { name: "可爱风", color: "#ec4899", sort: 20 },
  { name: "赛博风", color: "#06b6d4", sort: 30 },
  { name: "黑色", color: "#6b7280", sort: 40 },
  { name: "白色", color: "#e5e7eb", sort: 50 },
  { name: "免费", color: "#22c55e", sort: 60 },
  { name: "已购买", color: "#3b82f6", sort: 70 },
  { name: "PhysBones", color: "#f59e0b", sort: 80 },
  { name: "Modular Avatar", color: "#a855f7", sort: 90 },
  { name: "Quest 兼容", color: "#14b8a6", sort: 100 },
  { name: "待检查", color: "#ef4444", sort: 110 },
];

/** 只播种一次用的版本号；改默认标签表时 +1（已播种过的不再补，避免复活用户删掉的标签） */
export const TAGS_SEED_VERSION = "1";
