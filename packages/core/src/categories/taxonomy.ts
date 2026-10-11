/**
 * 物品分类（Asset Categories）——分类定义唯一真源。
 *
 * 约定：
 *  - **ID 一旦发布不得修改**（数据库、审计日志、用户手工分类都按 ID 存储）；改名只改 name。
 *  - 结构固定两层：主分类（parentId = null）→ 子分类（parentId = 主分类 ID）。不允许第三层。
 *  - sort 只是展示顺序；主分类之间用于排序，子分类在各自父下排序。
 *  - enabled=0 表示"停用"，UI 不再提供选择，但已有归属保留（不静默改数据）。
 *  - 本文件的 DEFAULT_TAXONOMY 是**初始**定义；首次建库/迁移时写进 categories 表，
 *    之后以数据库为准（用户可增删改）。任何"新库要预置什么"都以本文件为准。
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

const M = (id: string, name: string, sort: number): CategoryDef => ({ id, name, parentId: null, sort, enabled: true, builtin: true });
const C = (parent: string, id: string, name: string, sort: number): CategoryDef => ({ id: parent + "." + id, name, parentId: parent, sort, enabled: true, builtin: true });

export const DEFAULT_TAXONOMY: readonly CategoryDef[] = [
  // 1 服装
  M("clothing", "服装", 100),
  C("clothing", "tops", "上衣", 10),
  C("clothing", "bottoms", "下装", 20),
  C("clothing", "dress", "连衣裙", 30),
  C("clothing", "suit", "套装", 40),
  C("clothing", "coat", "外套", 50),
  C("clothing", "underwear", "内衣", 60),
  C("clothing", "swimwear", "泳装", 70),
  C("clothing", "shoes", "鞋子", 80),
  C("clothing", "socks", "袜子", 90),
  C("clothing", "other", "其他服装", 99),
  // 2 工具
  M("tools", "工具", 200),
  C("tools", "unity", "Unity 工具", 10),
  C("tools", "avatar_edit", "Avatar 编辑工具", 20),
  C("tools", "modular_avatar", "Modular Avatar 工具", 30),
  C("tools", "upload", "上传与管理工具", 40),
  C("tools", "automation", "自动化工具", 50),
  C("tools", "other", "其他工具", 99),
  // 3 饰品
  M("accessories", "饰品", 300),
  C("accessories", "headwear", "头饰", 10),
  C("accessories", "hair_ornament", "发饰", 20),
  C("accessories", "earring", "耳饰", 30),
  C("accessories", "necklace", "项链", 40),
  C("accessories", "hand", "手饰", 50),
  C("accessories", "glasses", "眼镜", 60),
  C("accessories", "tail", "尾巴", 70),
  C("accessories", "wings", "翅膀", 80),
  C("accessories", "horns", "角与兽耳", 90),
  C("accessories", "other", "其他饰品", 99),
  // 4 妆容
  M("makeup", "妆容", 400),
  C("makeup", "eye", "眼妆", 10),
  C("makeup", "lip", "唇妆", 20),
  C("makeup", "blush", "腮红", 30),
  C("makeup", "face_texture", "面部贴图", 40),
  C("makeup", "skin_texture", "皮肤贴图", 50),
  C("makeup", "other", "其他妆容", 99),
  // 5 头发
  M("hair", "头发", 500),
  C("hair", "model", "发型模型", 10),
  C("hair", "texture", "发型贴图", 20),
  C("hair", "other", "其他头发资源", 99),
  // 6 Avatar 与模型
  M("models", "Avatar 与模型", 600),
  C("models", "avatar", "完整 Avatar", 10),
  C("models", "body", "身体模型", 20),
  C("models", "head", "头部模型", 30),
  C("models", "parts", "模型部件", 40),
  C("models", "other", "其他模型", 99),
  // 7 纹理与材质
  M("textures", "纹理与材质", 700),
  C("textures", "texture", "贴图", 10),
  C("textures", "material", "材质", 20),
  C("textures", "material_preset", "材质预设", 30),
  C("textures", "eye", "眼睛资源", 40),
  C("textures", "skin", "皮肤资源", 50),
  C("textures", "other", "其他纹理材质", 99),
  // 8 Shader 与渲染
  M("shaders", "Shader 与渲染", 800),
  C("shaders", "shader", "Shader", 10),
  C("shaders", "preset", "Shader 预设", 20),
  C("shaders", "effect", "渲染效果", 30),
  C("shaders", "postprocess", "后处理", 40),
  C("shaders", "other", "其他渲染资源", 99),
  // 9 动画与动作
  M("animation", "动画与动作", 900),
  C("animation", "anim", "动画", 10),
  C("animation", "dance", "舞蹈", 20),
  C("animation", "pose", "姿势", 30),
  C("animation", "expression", "表情", 40),
  C("animation", "gesture", "手势", 50),
  C("animation", "controller", "动画控制器", 60),
  C("animation", "other", "其他动画资源", 99),
  // 10 特效
  M("effects", "特效", 1000),
  C("effects", "particle", "粒子系统", 10),
  C("effects", "preset", "特效预设", 20),
  C("effects", "light", "光效", 30),
  C("effects", "other", "其他特效", 99),
  // 11 音频
  M("audio", "音频", 1100),
  C("audio", "sfx", "音效", 10),
  C("audio", "music", "音乐", 20),
  C("audio", "voice", "语音", 30),
  C("audio", "other", "其他音频", 99),
  // 12 场景与世界
  M("worlds", "场景与世界", 1200),
  C("worlds", "vrchat", "VRChat World", 10),
  C("worlds", "scene", "Unity 场景", 20),
  C("worlds", "skybox", "天空盒", 30),
  C("worlds", "environment", "环境资源", 40),
  C("worlds", "other", "其他场景资源", 99),
  // 13 UI 与界面
  M("ui", "UI 与界面", 1300),
  C("ui", "component", "UI 组件", 10),
  C("ui", "icon", "图标", 20),
  C("ui", "hud", "HUD", 30),
  C("ui", "menu", "菜单", 40),
  C("ui", "other", "其他 UI 资源", 99),
  // 14 其他
  M("other", "其他", 1400),
  C("other", "uncategorized", "未分类", 10),
  C("other", "review", "待人工确认", 20),
  C("other", "misc", "其他资源", 30),
];

/** 未分类的判据：items.cat_id IS NULL。注意与分类树里的 other.uncategorized（人工显式选择"未分类"）区分。 */
export const UNCATEGORIZED_LABEL = "未分类";

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

/** 结构化校验：返回错误列表（空 = 合法）。用于测试与建库前把关。 */
export function validateTaxonomy(defs: readonly CategoryDef[] = DEFAULT_TAXONOMY): string[] {
  const errors: string[] = [];
  const byId = new Map<string, CategoryDef>();
  for (const d of defs) {
    if (!d.id || !d.name) errors.push(`分类缺少 id/name: ${JSON.stringify(d)}`);
    if (byId.has(d.id)) errors.push(`分类 ID 重复: ${d.id}`);
    byId.set(d.id, d);
  }
  for (const d of defs) {
    if (d.parentId !== null) {
      const p = byId.get(d.parentId);
      if (!p) errors.push(`${d.id} 的父分类不存在: ${d.parentId}`);
      else if (p.parentId !== null) errors.push(`${d.id} 超过两层（父分类 ${p.id} 自己也有父分类）`);
    }
  }
  return errors;
}
