/**
 * 物品分类（Asset Categories）—— 分类定义唯一真源（v3）。
 *
 * 约定：
 *  - **ID 一旦发布不得修改**（数据库、审计日志、用户手工分类都按 ID 存储）；改名只改 name。
 *  - 结构固定两层：主分类（parentId = null）→ 子分类（parentId = 主分类 ID）。不允许第三层。
 *  - sort 只是展示顺序；主分类之间用于排序，子分类在各自父下排序。
 *  - enabled=0 表示"停用"，UI 不再提供选择，但已有归属保留（不静默改数据）。
 *  - builtin（= API 里的 isSystem）表示**系统分类**：不可删除、不可停用；用户自建分类 builtin=0 可自由增删改。
 *  - v3 = 15 个一级分类（含系统分类「未分类」）+ 80 个二级子分类 = 95 个节点。
 *    v2（14 主 + 79 子）由 migrate 的 taxonomy 步骤增量升级（见 docs/categories-v3.md §3）。
 */

export interface CategoryDef {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  enabled: boolean;
  builtin: boolean;
}

/** 分类归属来源：manual=用户下拉框手选；confirmed=用户采纳了建议；auto=高置信度自动应用；migrated=历史迁移 */
export type CategorySource = "manual" | "confirmed" | "auto" | "migrated";
export const CATEGORY_SOURCES: readonly CategorySource[] = ["manual", "confirmed", "auto", "migrated"];

/** 分类推荐的处置级别：auto=可自动应用；suggest=只给建议等人确认；none=保持未分类 */
export type CategoryLevel = "auto" | "suggest" | "none";

export const CATEGORY_MAX_DEPTH = 2;

/** 系统分类「未分类」的 ID。注意：**未分类的规范存储仍是 items.cat_id IS NULL**，这一行只作导航/筛选/转移目标的入口。 */
export const UNCATEGORIZED_ID = "uncategorized";
export const UNCATEGORIZED_LABEL = "未分类";

const M = (id: string, name: string, sort: number): CategoryDef => ({ id, name, parentId: null, sort, enabled: true, builtin: true });
const C = (parent: string, id: string, name: string, sort: number): CategoryDef => ({ id: parent + "." + id, name, parentId: parent, sort, enabled: true, builtin: true });

/** v3 一级分类（顺序即 spec 顺序）+ 二级子分类。全部为系统分类（builtin=1）。 */
export const DEFAULT_TAXONOMY: readonly CategoryDef[] = [
  // 1 服饰
  M("clothing", "服饰", 100),
  C("clothing", "tops", "上衣", 10),
  C("clothing", "bottoms", "下装", 20),
  C("clothing", "dress", "连衣裙", 30),
  C("clothing", "coat", "外套", 40),
  C("clothing", "shoes_socks", "鞋袜", 50),
  C("clothing", "underwear", "内衣", 60),
  C("clothing", "suit", "套装", 70),
  C("clothing", "accessory", "服饰配件", 80),
  // 2 妆容
  M("makeup", "妆容", 200),
  C("makeup", "eyeshadow", "眼影", 10),
  C("makeup", "eyeliner", "眼线", 20),
  C("makeup", "lashes", "睫毛", 30),
  C("makeup", "brows", "眉毛", 40),
  C("makeup", "blush", "腮红", 50),
  C("makeup", "lips", "唇妆", 60),
  C("makeup", "fullface", "全脸妆", 70),
  C("makeup", "set", "妆容套装", 80),
  // 3 头发
  M("hair", "头发", 300),
  C("hair", "short", "短发", 10),
  C("hair", "long", "长发", 20),
  C("hair", "twintails", "双马尾", 30),
  C("hair", "ponytail", "单马尾", 40),
  C("hair", "braid", "辫子", 50),
  C("hair", "bangs", "刘海", 60),
  C("hair", "set", "发型套装", 70),
  // 4 模型
  M("models", "模型", 400),
  C("models", "avatar", "Avatar", 10),
  C("models", "body", "身体", 20),
  C("models", "head", "头部", 30),
  C("models", "animal", "动物", 40),
  C("models", "pet", "宠物", 50),
  C("models", "prop", "道具模型", 60),
  // 5 材质与纹理
  M("textures", "材质与纹理", 500),
  C("textures", "skin", "皮肤", 10),
  C("textures", "eye", "眼睛", 20),
  C("textures", "hair", "头发", 30),
  C("textures", "clothing", "服饰", 40),
  C("textures", "normal", "法线贴图", 50),
  C("textures", "pbr", "PBR 贴图", 60),
  // 6 Shader
  M("shaders", "Shader", 600),
  C("shaders", "skin", "皮肤 Shader", 10),
  C("shaders", "hair", "头发 Shader", 20),
  C("shaders", "cloth", "布料 Shader", 30),
  C("shaders", "effect", "特效 Shader", 40),
  C("shaders", "general", "通用 Shader", 50),
  // 7 动画与动作
  M("animation", "动画与动作", 700),
  C("animation", "idle", "待机", 10),
  C("animation", "walk", "行走", 20),
  C("animation", "dance", "舞蹈", 30),
  C("animation", "expression", "表情", 40),
  C("animation", "gesture", "手势", 50),
  C("animation", "pose", "姿势", 60),
  C("animation", "set", "动作套装", 70),
  // 8 特效
  M("effects", "特效", 800),
  C("effects", "particle", "粒子", 10),
  C("effects", "light", "光效", 20),
  C("effects", "magic", "魔法特效", 30),
  C("effects", "outline", "描边", 40),
  C("effects", "screen", "屏幕特效", 50),
  // 9 工具
  M("tools", "工具", 900),
  C("tools", "unity", "Unity 编辑器工具", 10),
  C("tools", "avatar", "Avatar 工具", 20),
  C("tools", "installer", "安装工具", 30),
  C("tools", "optimize", "优化工具", 40),
  C("tools", "script", "辅助脚本", 50),
  // 10 饰品
  M("accessories", "饰品", 1000),
  C("accessories", "earring", "耳饰", 10),
  C("accessories", "necklace", "项链", 20),
  C("accessories", "ring", "戒指", 30),
  C("accessories", "glasses", "眼镜", 40),
  C("accessories", "hat", "帽子", 50),
  C("accessories", "hair_ornament", "发饰", 60),
  C("accessories", "wings", "翅膀", 70),
  C("accessories", "tail", "尾巴", 80),
  // 11 音频
  M("audio", "音频", 1100),
  C("audio", "bgm", "BGM", 10),
  C("audio", "ambient", "环境音", 20),
  C("audio", "sfx", "音效", 30),
  C("audio", "voice", "语音", 40),
  // 12 场景
  M("worlds", "场景", 1200),
  C("worlds", "indoor", "室内", 10),
  C("worlds", "outdoor", "室外", 20),
  C("worlds", "skybox", "天空盒", 30),
  C("worlds", "world", "世界场景", 40),
  C("worlds", "prop", "场景道具", 50),
  // 13 UI
  M("ui", "UI", 1300),
  C("ui", "menu", "菜单", 10),
  C("ui", "icon", "图标", 20),
  C("ui", "hud", "HUD", 30),
  C("ui", "interactive", "交互界面", 40),
  // 14 其他
  M("other", "其他", 1400),
  C("other", "unclassed", "暂未归类", 10),
  C("other", "pending", "待整理", 20),
  // 15 未分类（系统分类，无子分类）
  M(UNCATEGORIZED_ID, UNCATEGORIZED_LABEL, 1500),
];

/** 15 个一级分类 ID（含未分类） */
export const TOP_CATEGORY_IDS: readonly string[] = DEFAULT_TAXONOMY.filter((d) => d.parentId === null).map((d) => d.id);

export function topCategories(defs: readonly CategoryDef[] = DEFAULT_TAXONOMY): CategoryDef[] {
  return defs.filter((d) => d.parentId === null).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}

export function childrenOf(id: string, defs: readonly CategoryDef[] = DEFAULT_TAXONOMY): CategoryDef[] {
  return defs.filter((d) => d.parentId === id).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}

export function categoryById(id: string | null | undefined, defs: readonly CategoryDef[] = DEFAULT_TAXONOMY): CategoryDef | null {
  if (!id) return null;
  return defs.find((d) => d.id === id) ?? null;
}

/** 分类路径：[主分类] 或 [主分类, 子分类]；未知 ID 返回 []。 */
export function categoryPath(id: string | null | undefined, defs: readonly CategoryDef[] = DEFAULT_TAXONOMY): CategoryDef[] {
  const self = categoryById(id, defs);
  if (!self) return [];
  if (self.parentId === null) return [self];
  const parent = categoryById(self.parentId, defs);
  return parent ? [parent, self] : [self];
}

export function isAncestor(ancestorId: string, id: string | null | undefined, defs: readonly CategoryDef[] = DEFAULT_TAXONOMY): boolean {
  const self = categoryById(id, defs);
  return !!self && self.parentId === ancestorId;
}

/** 未分类判据（数据库层用 SQL 表达同一语义）：cat_id 为空，或指向系统分类「未分类」。 */
export function isUncategorized(id: string | null | undefined): boolean {
  return !id || id === UNCATEGORIZED_ID;
}

/** 结构化校验：返回错误列表（空 = 合法）。用于测试与迁移前后把关。 */
export function validateTaxonomy(defs: readonly CategoryDef[] = DEFAULT_TAXONOMY): string[] {
  const errors: string[] = [];
  const byId = new Map<string, CategoryDef>();
  for (const d of defs) {
    if (!d.id || !d.name) errors.push("分类缺少 id/name: " + JSON.stringify(d));
    if (byId.has(d.id)) errors.push("分类 ID 重复: " + d.id);
    byId.set(d.id, d);
  }
  for (const d of defs) {
    if (d.parentId !== null) {
      const p = byId.get(d.parentId);
      if (!p) errors.push(d.id + " 的父分类不存在: " + d.parentId);
      else if (p.parentId !== null) errors.push(d.id + " 超过两层（父分类 " + p.id + " 自己也有父分类）");
    }
  }
  const unc = byId.get(UNCATEGORIZED_ID);
  if (unc && unc.parentId !== null) errors.push("未分类必须是系统一级分类");
  if (defs.some((d) => d.parentId === UNCATEGORIZED_ID)) errors.push("未分类不应有子分类");
  return errors;
}
