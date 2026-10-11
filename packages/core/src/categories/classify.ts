/**
 * 可解释的物品分类推荐（规则评分）。
 *
 * 设计原则（对应需求 §5/§6）：
 *  1. **可解释**：每条命中都留证据（字段 / 命中词 / 规则 / 权重），前端可原样展示。
 *  2. **不夸大**：单个关键词只给一半置信度；阈值可配置，未校准时不得当成真实概率。
 *  3. **否定语境**：命中词前后 4 字符内出现"なし/無し/不要/no"等 → 丢弃该条证据。
 *  4. **歧义惩罚**：第一名与第二名接近（< 35%）时降权，避免"标题里出现一个词就定性"。
 *  5. **只给建议**：本模块只做推理；"是否覆盖用户手选分类"由调用方按 CategorySource 决定。
 */

import { categoryById, type CategoryDef, type CategoryLevel, DEFAULT_TAXONOMY } from "./taxonomy";

export type EvidenceField =
  | "title" | "tag" | "description" | "filename" | "archive_path" | "unitypackage_path" | "booth_category" | "shop" | "notes";

/** 字段可信度：标题/文件名最可信，描述最弱。 */
export const FIELD_WEIGHT: Record<EvidenceField, number> = {
  title: 1, tag: 0.8, description: 0.5, filename: 0.9, archive_path: 0.6,
  unitypackage_path: 0.7, booth_category: 0.9, shop: 0.3, notes: 0.4,
};

export const FIELD_LABEL: Record<EvidenceField, string> = {
  title: "标题", tag: "标签", description: "描述", filename: "文件名", archive_path: "包内路径",
  unitypackage_path: "unitypackage 路径", booth_category: "BOOTH 分类", shop: "店铺", notes: "备注",
};

export interface CategoryRule {
  /** 规则 ID（稳定，便于追溯与测试） */
  id: string;
  categoryId: string;
  subCategoryId?: string | null;
  weight: number;
  keywords: string[];
  /** 只在这些字段生效；缺省 = 除 shop/notes 外的全部字段 */
  fields?: EvidenceField[];
  /** 命中词窗口内出现这些串 → 该条证据作废（否定/更专指的词） */
  negations?: string[];
  /** 说明，用于报告 */
  note?: string;
}

const ALL_FIELDS: EvidenceField[] = ["title", "tag", "description", "filename", "archive_path", "unitypackage_path", "booth_category"];

const r = (id: string, categoryId: string, subCategoryId: string | null, weight: number, keywords: string[], extra: Partial<CategoryRule> = {}): CategoryRule =>
  ({ id, categoryId, subCategoryId, weight, keywords, ...extra });

export const CATEGORY_RULES: readonly CategoryRule[] = [
  // ================= v3 规则表 ================= 
  // 约定：规则 ID = 目标子分类 ID（一级规则用 <top>.primary）；规则表里不得出现 taxonomy v3 之外的 ID，
  // 否则 recommendCategory 会静默忽略（用户看到的就是「规则写了但永远不生效」）。
  // v2 子分类的落点见 docs/categories-v3.md §3：一对一改名的直接换 ID；「回退到一级分类」的并入 <top>.primary。

  // ---------- 1 服饰 ----------
  r("clothing.primary", "clothing", null, 1.0, ["衣装", "服", "ウェア", "outfit", "clothes", "clothing", "コスチューム", "costume", "衣類", "洋服", "ドレスアップ", "きせかえ", "着せ替え",
    // v2 clothing.swimwear →（父）：v3 没有泳装子分类，只归到「服饰」
    "水着", "swimsuit", "swimwear", "ビキニ", "bikini", "競泳", "スクール水着", "マイクロビキニ", "タンキニ"],
    { negations: ["服飾小物", "衣服", "不服"], note: "v2 clothing.swimwear 已并入一级（迁移契约 §3）" }),
  r("clothing.tops", "clothing", "clothing.tops", 1.0, ["トップス", "シャツ", "shirt", "ブラウス", "blouse", "ニット", "knit", "セーター", "sweater", "パーカー", "hoodie", "tシャツ", "tshirt", "タンク", "tank top", "ベスト", "vest", "チューブトップ"]),
  r("clothing.bottoms", "clothing", "clothing.bottoms", 1.0, ["ボトムス", "スカート", "skirt", "パンツ", "pants", "ズボン", "ショートパンツ", "shorts", "ジーンズ", "jeans", "レギンス", "leggings", "ホットパンツ", "スパッツ"]),
  r("clothing.dress", "clothing", "clothing.dress", 1.0, ["ワンピース", "onepiece", "ワンピ", "dress", "ドレス", "サンドレス", "ロングドレス"]),
  r("clothing.suit", "clothing", "clothing.suit", 1.0, ["セットアップ", "setup", "スーツ", "suit", "制服", "ユニフォーム", "uniform", "セーラー服", "巫女服", "体操服", "着物", "浴衣", "メイド服", "ナース服", "コーデ", "バニー", "bunny", "バニースーツ"]),
  r("clothing.coat", "clothing", "clothing.coat", 1.0, ["コート", "coat", "ジャケット", "jacket", "マント", "cloak", "ケープ", "cape", "ポンチョ", "poncho", "ブルゾン", "羽織", "パーカー"]),
  r("clothing.underwear", "clothing", "clothing.underwear", 1.0, ["下着", "ブラジャー", "ブラ", "bra", "パンティ", "ぱんつ", "ショーツ", "ランジェリー", "lingerie", "インナー", "underwear", "キャミソール", "camisole", "ベビードール"], { negations: ["ブラシ", "ブランド", "ブラウス", "ブラウン"] }),
  // v2 clothing.shoes + clothing.socks → v3 clothing.shoes_socks（两个旧子分类合并成一条规则）
  r("clothing.shoes_socks", "clothing", "clothing.shoes_socks", 1.0, ["靴", "くつ", "shoes", "ブーツ", "boots", "サンダル", "sandal", "ヒール", "heels", "パンプス", "pumps", "スニーカー", "sneaker",
    "靴下", "ソックス", "socks", "ニーソ", "ニーハイ", "ストッキング", "stockings", "タイツ", "tights", "ガーター", "ガーターベルト", "網タイツ"],
    { note: "v2 clothing.shoes + clothing.socks 合并（迁移契约 §3）" }),
  // v3 新增：服饰配件（腰带/领带/围巾等，与「饰品」区分）
  r("clothing.accessory", "clothing", "clothing.accessory", 1.0, ["ベルト", "belt", "ネクタイ", "necktie", "tie", "サスペンダー", "suspenders", "スカーフ", "scarf", "マフラー", "muffler", "ストール", "stole", "腕章", "服饰配件"]),

  // ---------- 2 妆容 ----------
  r("makeup.primary", "makeup", null, 1.0, ["メイク", "makeup", "メイクアップ", "化粧", "コスメ", "cosmetics", "メイク道具"]),
  // v2 makeup.eye 拆分：眼影 / 眼线 / 睫毛 / 眉毛（v3 新增）
  r("makeup.eyeshadow", "makeup", "makeup.eyeshadow", 1.1, ["アイシャドウ", "アイシャドー", "eyeshadow", "eye shadow", "アイメイク", "目元メイク", "アイカラー", "eye color", "眼影"]),
  r("makeup.eyeliner", "makeup", "makeup.eyeliner", 1.1, ["アイライン", "アイライナー", "eyeliner", "eye liner", "ライン入りアイ", "眼线"]),
  r("makeup.lashes", "makeup", "makeup.lashes", 1.1, ["まつげ", "まつ毛", "睫毛", "eyelash", "eyelashes", "アイラッシュ", "つけまつげ", "付け睫毛"]),
  r("makeup.brows", "makeup", "makeup.brows", 1.1, ["眉毛", "まゆげ", "マユゲ", "アイブロウ", "eyebrow", "eyebrows", "眉"]),
  r("makeup.blush", "makeup", "makeup.blush", 1.1, ["チーク", "cheek", "blush", "頬紅", "ほっぺ"]),
  r("makeup.lips", "makeup", "makeup.lips", 1.1, ["リップ", "lip", "口紅", "ルージュ", "rouge", "グロス", "lipgloss", "リップスティック", "リップメイク", "唇"]),
  // v2 makeup.face_texture + makeup.skin_texture → v3 makeup.fullface（两个旧子分类合并）
  r("makeup.fullface", "makeup", "makeup.fullface", 1.1, ["顔テクスチャ", "フェイステクスチャ", "face texture", "顔のテクスチャ", "顔面テクスチャ", "シェーディングテクスチャ",
    "肌テクスチャ", "スキンテクスチャ", "skin texture", "肌のテクスチャ", "ボディテクスチャ余白", "全脸妆"], { negations: ["肌着"], note: "v2 makeup.face_texture + makeup.skin_texture 合并" }),
  r("makeup.set", "makeup", "makeup.set", 1.0, ["メイクセット", "makeup set", "コスメセット", "メイク一式", "化粧セット", "コスメキット"]),

  // ---------- 3 头发 ----------
  r("hair.primary", "hair", null, 1.0, ["髪", "ヘア", "hair", "ウィッグ", "wig", "前髪", "bangs", "ロングヘア", "ショートヘア", "ツインテール", "ポニーテール"], { negations: ["ヘアピン", "ヘアゴム", "ヘアクリップ", "ヘアアクセ", "ヘアバンド", "ヘアカラー剤"] }),
  // v3 新增：短发 / 长发 / 双马尾 / 单马尾 / 辫子 / 刘海
  r("hair.short", "hair", "hair.short", 1.1, ["ショートヘア", "ショートヘアー", "ショートカット", "ショートボブ", "ベリーショート", "ショート", "short hair", "ボブ", "bob", "短发"]),
  r("hair.long", "hair", "hair.long", 1.1, ["ロングヘア", "ロングヘアー", "ロングストレート", "セミロング", "超ロング", "ロング", "long hair", "腰まで", "长发"]),
  r("hair.twintails", "hair", "hair.twintails", 1.1, ["ツインテール", "ツインテールズ", "ツインテ", "twintail", "twintails", "双马尾", "雙馬尾", "二つ結び"]),
  r("hair.ponytail", "hair", "hair.ponytail", 1.1, ["ポニーテール", "ポニテ", "サイドテール", "ponytail", "ハーフアップ", "単马尾", "单马尾", "一つ結び"]),
  r("hair.braid", "hair", "hair.braid", 1.1, ["三つ編み", "編み込み", "編み下ろし", "おさげ", "braid", "braids", "辫子", "辮子"]),
  r("hair.bangs", "hair", "hair.bangs", 1.1, ["前髪", "ぱっつん", "bangs", "刘海", "劉海"]),
  // v2 hair.model → v3 hair.set（发型套装）
  r("hair.set", "hair", "hair.set", 1.1, ["ヘアモデル", "ヘアセット", "ヘアアセット", "ヘアスタイル", "髪型", "hairstyle", "hair style", "ウィッグ", "wig", "髪モデル", "ウィッグモデル", "发型", "髮型"]),

  // ---------- 4 模型 ----------
  // 注意：不要把「モデル」「アバター」当主分类关键词——几乎每个 VRChat 素材的 BOOTH 分类都带「3Dモデル」，
  // 那会让 models 成为所有条目的第二分类、把别的分类全部拖进"歧义降权"。模型类只靠更具体的词判定。
  // v2 models.parts →（父）：其关键词并入 models.primary。
  r("models.primary", "models", null, 0.9, ["素体", "ベースモデル", "アバターモデル", "モデルデータ", "3dモデル本体",
    "パーツ", "parts", "部品", "メッシュ", "mesh", "差分パーツ", "追加パーツ"], { note: "v2 models.parts 已并入一级" }),
  r("models.avatar", "models", "models.avatar", 1.2, ["アバター本体", "アバターセット", "フルセット", "full set", "完成品アバター", "vrm", "アバター一式", "アバターデータ"]),
  r("models.body", "models", "models.body", 1.0, ["素体", "base body", "ボディ", "body", "身体", "体モデル", "ヌードモデル", "ボディモデル"], { negations: ["ボディスーツ", "ボディアクセ", "ボディペイント"] }),
  r("models.head", "models", "models.head", 1.0, ["頭部", "head model", "頭モデル", "顔モデル", "顔面モデル", "ヘッドモデル"]),
  // v3 新增：动物 / 宠物 / 道具模型
  r("models.animal", "models", "models.animal", 1.1, ["動物モデル", "アニマル", "animal", "animal model", "犬モデル", "猫モデル", "狼", "ドラゴン", "モンスター", "生物モデル", "动物"], { negations: ["animal ears"] }),
  r("models.pet", "models", "models.pet", 1.1, ["ペット", "pet", "ペットモデル", "コンパニオン", "ペット用", "相棒モデル", "宠物"]),
  r("models.prop", "models", "models.prop", 1.0, ["プロップ", "prop", "小道具", "道具モデル", "武器", "weapon", "剣", "sword", "盾", "家具", "furniture", "椅子", "机", "道具模型"]),

  // ---------- 5 材质与纹理 ----------
  // v2 textures.texture / textures.material / textures.material_preset →（父）：通用关键词并入 textures.primary；
  //   其中「法线贴图」单独拆成 v3 的 textures.normal。
  r("textures.primary", "textures", null, 0.9, ["テクスチャ", "texture", "テクスチャー", "マテリアル", "material", "マテリアルセット",
    ".mat", "matファイル", "マテリアルファイル", "材質", "テクスチャセット", "高解像度テクスチャ",
    "マテリアルプリセット", "material preset", "プリセット", "preset", "設定ファイル付き", "マテリアル設定"], { negations: ["テクスチャなし"], note: "v2 textures.texture/material/material_preset 已并入一级" }),
  r("textures.skin", "textures", "textures.skin", 1.0, ["肌テクスチャ", "スキンテクスチャ", "skin texture", "肌", "スキン", "body texture"], { negations: ["肌着", "スキンケア"] }),
  r("textures.eye", "textures", "textures.eye", 1.1, ["瞳テクスチャ", "eye texture", "アイテクスチャ", "瞳", "iris", "目玉", "瞳のテクスチャ", "eyes texture"], { negations: ["瞳の色変更のみ", "目的", "項目", "注目", "目次"] }),
  // v3 新增：头发/服饰贴图（v2 hair.texture 在 v3 没有对应子分类，按语义落到 textures.hair）
  r("textures.hair", "textures", "textures.hair", 1.0, ["ヘアテクスチャ", "hair texture", "髪テクスチャ", "ヘアカラーテクスチャ", "ヘアマテリアル"], { note: "v2 hair.texture 的关键词重新归属到 textures.hair" }),
  r("textures.clothing", "textures", "textures.clothing", 1.0, ["服テクスチャ", "clothing texture", "衣装テクスチャ", "服のテクスチャ", "コスチュームテクスチャ", "服地"]),
  // v3 新增：法线贴图 / PBR 贴图
  r("textures.normal", "textures", "textures.normal", 1.1, ["ノーマルマップ", "normalmap", "normal map", "法線マップ", "法線テクスチャ", "normal texture", "法线贴图"]),
  r("textures.pbr", "textures", "textures.pbr", 1.1, ["pbr", "pbrテクスチャ", "pbr texture", "メタリック", "metallic", "ラフネス", "roughness", "オクルージョンマップ", "ormマップ", "物理ベース", "pbr贴图"]),

  // ---------- 6 Shader ----------
  r("shaders.primary", "shaders", null, 1.0, ["シェーダー", "shader", "シェーダ", "hlsl", "cginc", "liltoon", "poiyomi", "unitychan toon", "シェーディング"], { negations: ["シェーダーなし"] }),
  // v2 shaders.shader + shaders.preset + shaders.postprocess → v3 shaders.general（三个旧子分类合并）
  r("shaders.general", "shaders", "shaders.general", 1.2, ["シェーダー", "shader", ".shader", "hlsl", "cginc", "liltoon", "poiyomi", "toon shader", "シェーダーファイル",
    "シェーダー設定", "shader preset", "プリセット", "preset", "matcap",
    "ポストプロセス", "post process", "postprocess", "post processing", "ブルーム", "bloom", "被写界深度", "dof", "色収差", "カラーグレーディング", "トーンマップ", "tonemap"],
    // 更专指的同现词作废通用规则：'スキンシェーダー' 应落到 shaders.skin，而不是被这里的「シェーダー」抢走
    { negations: ["シェーダーなし", "スキンシェーダー", "肌シェーダー", "ヘアシェーダー", "髪シェーダー", "布シェーダー", "服シェーダー", "クロスシェーダー", "skin shader", "hair shader", "cloth shader", "fabric shader"], note: "v2 shaders.shader/preset/postprocess 合并（迁移契约 §3）" }),
  // v3 新增：皮肤 / 头发 / 布料 Shader
  r("shaders.skin", "shaders", "shaders.skin", 1.0, ["スキンシェーダー", "skin shader", "肌シェーダー", "肌shader", "肌用シェーダー"]),
  r("shaders.hair", "shaders", "shaders.hair", 1.0, ["ヘアシェーダー", "hair shader", "髪シェーダー", "髪shader", "髪用シェーダー"]),
  r("shaders.cloth", "shaders", "shaders.cloth", 1.0, ["布シェーダー", "cloth shader", "服シェーダー", "服shader", "布地シェーダー", "fabric shader", "クロスシェーダー"]),
  r("shaders.effect", "shaders", "shaders.effect", 1.0, ["影", "shadow", "アウトライン", "outline", "リムライト", "rim light", "発光", "emission", "グロウ", "glow", "ハイライト", "反射", "reflection", "スペキュラ", "specular"], { negations: ["影なし", "シャドウなし", "no shadow", "影を落とさない", "影が出ない", "アウトラインなし"] }),

  // ---------- 7 动画与动作 ----------
  // v2 animation.anim + animation.controller →（父）：关键词并入 animation.primary。
  r("animation.primary", "animation", null, 0.9, ["アニメーション", "animation", "アニメ", "モーション", "motion", "キーフレーム",
    ".anim", "animファイル", "アニメカーブ", "アニメーションデータ",
    "アニメーター", "animator", "コントローラー", "controller", "ステートマシン", "statemachine", "アニメーションパラメータ", "exmenu", "expression menu"],
    { note: "v2 animation.anim/controller 已并入一级" }),
  // v3 新增：待机 / 行走 / 动作套装
  r("animation.idle", "animation", "animation.idle", 1.1, ["待機", "idle", "待機モーション", "立ちモーション", "呼吸モーション", "待機アニメ", "待机"]),
  r("animation.walk", "animation", "animation.walk", 1.1, ["歩き", "歩行", "歩行モーション", "walk", "walking", "走る", "走行", "run", "ランニング", "walkアニメ", "行走"]),
  r("animation.dance", "animation", "animation.dance", 1.2, ["ダンス", "dance", "踊り", "踊ってみた", "振り付け", "ダンスモーション", "ダンスアニメ"]),
  r("animation.expression", "animation", "animation.expression", 1.0, ["表情", "expression", "シェイプキー", "blendshape", "まばたき", "瞬き", "口パク", "リップシンク", "アイトラッキング", "表情セット"]),
  r("animation.gesture", "animation", "animation.gesture", 1.1, ["ジェスチャー", "gesture", "ハンドサイン", "hand sign", "フィンガー", "finger", "指アニメ"]),
  r("animation.pose", "animation", "animation.pose", 1.1, ["ポーズ", "pose", "立ちポーズ", "座りポーズ", "静止ポーズ", "ポーズ集"]),
  r("animation.set", "animation", "animation.set", 1.0, ["アニメーションセット", "モーションセット", "モーション集", "動作セット", "アニメセット", "animation set"]),

  // ---------- 8 特效 ----------
  // v2 effects.preset →（父）：关键词并入 effects.primary。
  r("effects.primary", "effects", null, 1.0, ["エフェクト", "effect", "vfx", "パーティクル", "particle", "ギミック効果",
    "エフェクトプリセット", "effect preset", "エフェクト集", "パーティクルプリセット"], { note: "v2 effects.preset 已并入一级" }),
  r("effects.particle", "effects", "effects.particle", 1.1, ["パーティクル", "particle", "エミッター", "emitter", "煙", "smoke", "炎", "火炎", "花びら", "petal", "雪", "snow", "星屑", "キラキラ", "きらきら", "kirakira"]),
  r("effects.light", "effects", "effects.light", 1.0, ["ライト", "light", "発光", "glow", "ネオン", "neon", "レーザー", "laser", "オーラ", "aura", "光の輪"]),
  // v3 新增：魔法特效 / 描边 / 屏幕特效
  r("effects.magic", "effects", "effects.magic", 1.1, ["魔法", "マジック", "magic", "魔法陣", "魔方陣", "呪文", "スペル", "spell", "魔法エフェクト", "マジックエフェクト", "魔法特效"]),
  r("effects.outline", "effects", "effects.outline", 1.1, ["アウトライン", "outline", "描边", "描邊", "輪郭線", "縁取り", "アウトライン化"], { negations: ["アウトラインなし", "outlineなし", "no outline"] }),
  r("effects.screen", "effects", "effects.screen", 1.1, ["画面エフェクト", "screen effect", "スクリーンエフェクト", "スクリーン効果", "画面効果", "ポストエフェクト", "フルスクリーンエフェクト", "屏幕特效"]),

  // ---------- 9 工具 ----------
  r("tools.primary", "tools", null, 0.9, ["ツール", "tool", "エディタ拡張", "editor extension", "プラグイン", "plugin", "スクリプト", "script", "ユーティリティ", "utility"], { negations: ["アセットストア"] }),
  // 不要把 "unitypackage" 当关键词：资产文件名天然是 *.unitypackage，会让每个带包的素材都往"Unity 工具"偏
  // （实测把一个 Avatar 商品拖到 0.9 分，把真正的 models/avatar 挤成"歧义"→ 直接掉成未分类）
  r("tools.unity", "tools", "tools.unity", 1.0, ["unity", "upm", "vpm", "editorwindow", "editorextension", "unity editor", "エディター拡張", "メニューに追加"]),
  // v2 tools.avatar_edit + tools.modular_avatar → v3 tools.avatar（两个旧子分类合并）
  r("tools.avatar", "tools", "tools.avatar", 1.0, ["アバター編集", "blendshape", "シェイプキー", "shape key", "ボーン", "bone", "rig", "リギング", "ウェイトペイント", "weightpaint", "メッシュ編集", "mesh edit", "改変", "お着替え", "着せ替えツール",
    "modular avatar", "modularavatar", "modular-avatar", "ndmf", "vrcfury", "vrchat fury", "モジュラーアバター", "ma component"], { note: "v2 tools.avatar_edit + tools.modular_avatar 合并" }),
  // v2 tools.upload → v3 tools.installer
  r("tools.installer", "tools", "tools.installer", 1.0, ["アップロード", "upload", "vrcsdk", "vrchat sdk", "blueprint id", "ブループリント", "管理ツール", "アカウント管理", "インストーラー", "installer", "セットアップツール"]),
  // v3 新增：优化工具（把 v2 avatar_edit 里的「减面/轻量化」拆出来）
  r("tools.optimize", "tools", "tools.optimize", 1.1, ["最適化", "最適化ツール", "optimize", "optimizer", "軽量化", "ポリゴン削減", "デシメート", "decimate", "メッシュ圧縮", "負荷軽減"]),
  // v2 tools.automation → v3 tools.script
  r("tools.script", "tools", "tools.script", 1.0, ["自動化", "automation", "automate", "ビルドスクリプト", "batch", "バッチ", "自動生成", "ジェネレータ", "generator", "スクリプト生成"]),

  // ---------- 10 饰品 ----------
  // v2 accessories.horns →（父）：关键词并入 accessories.primary。
  r("accessories.primary", "accessories", null, 1.0, ["アクセサリー", "accessory", "accessories", "アクセ", "装飾品", "小物", "ornament", "ジュエリー", "jewelry",
    "獣耳", "けもみみ", "ケモミミ", "猫耳", "ねこみみ", "犬耳", "うさみみ", "兎耳", "狐耳", "きつねみみ", "animal ears", "ホーン", "つの", "角"], { note: "v2 accessories.horns 已并入一级" }),
  // v2 accessories.headwear → v3 accessories.hat
  r("accessories.hat", "accessories", "accessories.hat", 1.0, ["ヘッドドレス", "headwear", "帽子", "hat", "キャップ", "cap", "ベレー", "beret", "ティアラ", "tiara", "クラウン", "crown", "花冠", "ミニハット", "ナース帽"], { negations: ["キャップレス", "ハットトリック"] }),
  r("accessories.hair_ornament", "accessories", "accessories.hair_ornament", 1.1, ["ヘアピン", "hairpin", "ヘアゴム", "シュシュ", "リボン", "ribbon", "カチューシャ", "headband", "ヘアクリップ", "髪飾り", "かんざし", "簪", "ヘアアクセ"]),
  r("accessories.earring", "accessories", "accessories.earring", 1.0, ["イヤリング", "earring", "ピアス", "pierce", "耳飾り", "イヤーカフ"]),
  r("accessories.necklace", "accessories", "accessories.necklace", 1.0, ["ネックレス", "necklace", "チョーカー", "choker", "ペンダント", "pendant", "首輪", "鈴付き首輪", "ネックカバー"]),
  // v2 accessories.hand → v3 accessories.ring（迁移契约：手部饰品统一落到「戒指」）
  r("accessories.ring", "accessories", "accessories.ring", 1.0, ["指輪", "リング", "指環", "戒指", "ブレスレット", "bracelet", "リストバンド", "wristband", "グローブ", "glove", "手袋", "ネイル", "nail", "爪", "マニキュア"], { negations: ["指輪っか"], note: "v2 accessories.hand 已改名为 accessories.ring" }),
  r("accessories.glasses", "accessories", "accessories.glasses", 1.1, ["メガネ", "めがね", "眼鏡", "glasses", "サングラス", "sunglasses", "ゴーグル", "goggles", "アイウェア", "eyewear"]),
  r("accessories.tail", "accessories", "accessories.tail", 1.1, ["しっぽ", "尻尾", "テイル", "tail", "尾っぽ"], { negations: ["テイルズ", "ディテール"] }),
  r("accessories.wings", "accessories", "accessories.wings", 1.1, ["翼", "つばさ", "ウイング", "wing", "羽根", "フェザーウィング"]),

  // ---------- 11 音频 ----------
  r("audio.primary", "audio", null, 1.0, ["音声", "ボイス", "voice", "サウンド", "sound", "音楽", "music", "効果音", "オーディオ", "audio"], { negations: ["サウンドトラックのみ"] }),
  // v2 audio.music → v3 audio.bgm
  r("audio.bgm", "audio", "audio.bgm", 1.2, ["音楽", "music", "bgm", "楽曲", "ソング", "song", "インスト曲", "背景音楽", "作業用bgm"]),
  // v3 新增：环境音
  r("audio.ambient", "audio", "audio.ambient", 1.2, ["環境音", "ambient", "ambience", "アンビエント", "環境音楽", "自然音", "波の音", "雨音", "鳥の声", "焚き火"]),
  r("audio.sfx", "audio", "audio.sfx", 1.2, ["効果音", "se素材", "sfx", "effect sound", "サウンドエフェクト", "システム音"]),
  r("audio.voice", "audio", "audio.voice", 1.2, ["ボイス", "voice", "音声素材", "セリフ", "台詞", "ボイス素材", "しゃべり", "喋り"]),

  // ---------- 12 场景 ----------
  // v2 worlds.environment →（父）：其关键词并入 worlds.primary（「部屋/room」归 v3 的 worlds.indoor）。
  r("worlds.primary", "worlds", null, 0.9, ["ワールド", "world", "シーン", "scene", "環境", "environment", "背景",
    "地形", "terrain", "植栽", "建物", "building", "街並み", "背景セット"],
    { fields: ["title", "tag", "filename"], note: "v2 worlds.environment 已并入一级；泛词只吃强字段（描述里「環境/背景/シーン」太常见）" }),
  // v3 新增：室内 / 室外 / 场景道具
  r("worlds.indoor", "worlds", "worlds.indoor", 1.1, ["室内", "indoor", "部屋", "room", "部屋セット", "インテリア", "室内用", "家の中", "室内モデル"]),
  // 只留复合词：单字「海/森/山/街」在日文描述里到处都是（海水/海外/山ほど…），实测把人体商品误判成"场景›室外"
  r("worlds.outdoor", "worlds", "worlds.outdoor", 1.1, ["室外", "outdoor", "屋外", "屋外セット", "公園", "自然環境", "ビーチ", "砂浜", "森林", "山岳", "街並み", "屋外モデル"]),
  r("worlds.skybox", "worlds", "worlds.skybox", 1.2, ["スカイボックス", "skybox", "空のテクスチャ", "スカイ", "夕焼け", "星空", "hdri", "パノラマ", "空mod"]),
  // v2 worlds.vrchat + worlds.scene → v3 worlds.world（两个旧子分类合并）
  r("worlds.world", "worlds", "worlds.world", 1.2, ["vrchat world", "vrchatワールド", "ワールドデータ", "アップロード用ワールド", "worldsファイル",
    "unity scene", ".unity", "シーンファイル", "ステージ", "stage", "ステージセット", "世界场景", "世界場景"], { note: "v2 worlds.vrchat + worlds.scene 合并" }),
  r("worlds.prop", "worlds", "worlds.prop", 1.0, ["场景道具", "場景道具", "ステージ小物", "セット小物", "背景小物", "シーン小物", "部屋の小物"]),

  // ---------- 13 UI ----------
  r("ui.primary", "ui", null, 0.8, ["ui", "ユーザーインターフェース", "インターフェース", "ui素材", "uiセット"]),
  // v2 ui.component → v3 ui.interactive
  r("ui.interactive", "ui", "ui.interactive", 1.1, ["uiコンポーネント", "ui component", "ウィジェット", "widget", "ボタン素材", "パネル素材", "スライダー", "交互界面", "インタラクティブui", "操作パネル"]),
  r("ui.icon", "ui", "ui.icon", 1.0, ["アイコン", "icon", "サムネイル素材", "プレビュー画像", "ロゴ", "logo", "アイコンセット"]),
  r("ui.hud", "ui", "ui.hud", 1.2, ["hud", "オーバーレイ", "常時表示ui", "ヘッドマウント表示"]),
  r("ui.menu", "ui", "ui.menu", 1.0, ["メニュー", "menu", "エクスプレッションメニュー", "expression menu", "選択メニュー"]),

  // ---------- 14 其他 ----------
  // v2 other.misc → v3 other.unclassed、v2 other.review → v3 other.pending（迁移契约 §3）
  r("other.primary", "other", null, 0.7, ["その他", "other素材", "misc", "雑多", "詰め合わせ"], { fields: ["title", "tag", "filename", "description"] }),
  r("other.unclassed", "other", "other.unclassed", 1.0, ["暂未归类", "暫未歸類", "未分类", "未分類", "分類なし", "分类待定", "分類未定"]),
  r("other.pending", "other", "other.pending", 1.0, ["待整理", "未整理", "要整理", "分類待ち", "保留中", "あとで整理", "分类待办"]),
];

export interface CategoryEvidenceInput {
  title?: string | null;
  titleJa?: string | null;
  description?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  shopName?: string | null;
  boothCategory?: { name?: string | null; parent?: string | null } | null;
  fileNames?: string[] | null;
  archivePaths?: string[] | null;
  unitypackagePaths?: string[] | null;
}

export interface CategoryEvidenceHit {
  field: EvidenceField;
  fieldLabel: string;
  ruleId: string;
  matched: string;
  keyword: string;
  gain: number;
  categoryId: string;
  subCategoryId: string | null;
}

export interface CategoryRecommendation {
  categoryId: string | null;
  subCategoryId: string | null;
  /** 归一化置信度 0..1（未校准，仅用于阈值比较） */
  confidence: number;
  /** 原始加权得分 */
  score: number;
  runnerUpScore: number;
  level: CategoryLevel;
  ambiguous: boolean;
  evidence: CategoryEvidenceHit[];
  /** 人类可读的依据说明 */
  reason: string;
}

export interface CategoryThresholds { autoThreshold: number; suggestThreshold: number }
export const DEFAULT_CATEGORY_THRESHOLDS: CategoryThresholds = { autoThreshold: 0.75, suggestThreshold: 0.4 };
/** 得分为多少时置信度达到 1.0（饱和点；改这里等于改"多强才算明确"） */
export const CONFIDENCE_SATURATION = 2.0;
const AMBIGUITY_MARGIN = 0.35;
const AMBIGUITY_PENALTY = 0.6;
const MAX_EVIDENCE = 12;
/**
 * "包内含某类文件"是**弱证据**（需求 §7：一个衣服商品包含材质文件，不代表它是材质）。
 * 包内路径（archive_path / unitypackage_path）对同一分类的贡献上限，避免"包里带了 lilToon 就被判成 Shader"。
 */
const PATH_GAIN_CAP = 0.6;
const PATH_FIELDS: ReadonlySet<EvidenceField> = new Set<EvidenceField>(["archive_path", "unitypackage_path"]);

export function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

const ASCII_KW = /^[a-z0-9.\-_ ]+$/;

/** 命中判断：ASCII 关键词要求词边界（避免 mat 命中 material 之类）；CJK 直接子串。 */
function containsKeyword(text: string, kw: string): { index: number; length: number } | null {
  if (!kw) return null;
  if (ASCII_KW.test(kw)) {
    const needle = kw.trim();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx < 0) return null;
      const before = idx === 0 ? "" : text[idx - 1];
      const after = idx + needle.length >= text.length ? "" : text[idx + needle.length];
      const boundaryBefore = before === "" || !/[a-z0-9]/.test(before);
      const boundaryAfter = after === "" || !/[a-z0-9]/.test(after);
      if (boundaryBefore && boundaryAfter) return { index: idx, length: needle.length };
      from = idx + 1;
    }
  }
  const idx = text.indexOf(kw);
  return idx < 0 ? null : { index: idx, length: kw.length };
}

function negated(text: string, hit: { index: number; length: number }, negations: readonly string[]): boolean {
  if (negations.length === 0) return false;
  const from = Math.max(0, hit.index - 6);
  const to = Math.min(text.length, hit.index + hit.length + 6);
  const window = text.slice(from, to);
  return negations.some((n) => window.includes(fold(n)));
}

function specificity(kw: string): number {
  const folded = fold(kw);
  if (ASCII_KW.test(folded)) return 1.0;
  return folded.length >= 3 ? 1.15 : 0.85;
}

interface Doc { field: EvidenceField; text: string }

/** 把输入摊平成"证据文档"，供规则逐字段匹配。 */
export function evidenceDocuments(input: CategoryEvidenceInput): Doc[] {
  const docs: Doc[] = [];
  const push = (field: EvidenceField, raw: string | null | undefined) => {
    const t = fold(String(raw ?? "")).trim();
    if (t) docs.push({ field, text: t });
  };
  push("title", [input.title, input.titleJa].filter(Boolean).join(" "));
  push("description", input.description);
  push("notes", input.notes);
  push("shop", input.shopName);
  const bc = input.boothCategory;
  if (bc) push("booth_category", [bc.parent, bc.name].filter(Boolean).join(" "));
  for (const t of input.tags ?? []) push("tag", t);
  for (const f of input.fileNames ?? []) push("filename", f);
  for (const p of input.archivePaths ?? []) push("archive_path", p);
  for (const p of input.unitypackagePaths ?? []) push("unitypackage_path", p);
  return docs;
}

/** 核心：规则评分 + 歧义惩罚 + 阈值分级。taxonomy 传入是为了校验 ID 合法（未知 ID 的规则会被忽略）。 */
export function recommendCategory(
  input: CategoryEvidenceInput,
  thresholds: CategoryThresholds = DEFAULT_CATEGORY_THRESHOLDS,
  defs: readonly CategoryDef[] = DEFAULT_TAXONOMY,
  rules: readonly CategoryRule[] = CATEGORY_RULES,
): CategoryRecommendation {
  const docs = evidenceDocuments(input);
  const hits: CategoryEvidenceHit[] = [];
  for (const rule of rules) {
    if (!categoryById(rule.categoryId, defs)) continue;
    if (rule.subCategoryId && !categoryById(rule.subCategoryId, defs)) continue;
    const fields = rule.fields ?? ALL_FIELDS;
    for (const doc of docs) {
      if (!fields.includes(doc.field)) continue;
      // 本规则在本字段命中的所有关键词，先收集再"长词优先"过滤（子串重复只算最专指的那条）
      const matched: { kw: string; folded: string; gain: number }[] = [];
      for (const kw of rule.keywords) {
        const folded = fold(kw);
        const found = containsKeyword(doc.text, folded);
        if (!found) continue;
        if (negated(doc.text, found, rule.negations ?? [])) continue;
        matched.push({ kw, folded, gain: rule.weight * FIELD_WEIGHT[doc.field] * specificity(folded) });
      }
      matched.sort((a, b) => b.folded.length - a.folded.length);
      const kept: typeof matched = [];
      for (const m of matched) {
        if (kept.some((k) => k.folded.includes(m.folded))) continue; // 已被更长的词覆盖
        kept.push(m);
      }
      for (const m of kept) {
        hits.push({
          field: doc.field, fieldLabel: FIELD_LABEL[doc.field], ruleId: rule.id, matched: m.folded,
          keyword: m.kw, gain: Math.round(m.gain * 1000) / 1000, categoryId: rule.categoryId, subCategoryId: rule.subCategoryId ?? null,
        });
      }
    }
  }

  // 每个 (主, 子) 组合累加；同一规则同一字段同一关键词只算一次（去重）
  // 同一处证据只算一次：主分类规则与子分类规则常共享关键词（shaders.primary 与 shaders.general 都含「シェーダー」），
  // 若各记一次，"描述里提了一句 lilToon" 就能把商品拉成 auto=Shader。按 顶分类|字段|命中词 去重，保留权重最高的一条。
  const seen = new Set<string>();
  const strongBuckets = new Map<string, number>();
  const pathBuckets = new Map<string, number>();
  const deduped: CategoryEvidenceHit[] = [];
  for (const h of hits.sort((a, b) => b.gain - a.gain)) {
    const key = [h.categoryId, h.field, h.matched].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
    const bucketKey = h.subCategoryId ?? h.categoryId;
    const target = PATH_FIELDS.has(h.field) ? pathBuckets : strongBuckets;
    target.set(bucketKey, (target.get(bucketKey) ?? 0) + h.gain);
  }
  const strongOf = (key: string) => strongBuckets.get(key) ?? 0;
  const pathOf = (key: string) => pathBuckets.get(key) ?? 0;
  const bucketScore = (key: string) => strongOf(key) + Math.min(PATH_GAIN_CAP, pathOf(key));

  const tops = defs.filter((d) => d.parentId === null);
  const ranked: { categoryId: string; subCategoryId: string | null; score: number; strongScore: number }[] = [];
  for (const top of tops) {
    const subScores = defs.filter((d) => d.parentId === top.id).map((sub) => ({ id: sub.id, score: bucketScore(sub.id) }));
    const bestSub = subScores.reduce<{ id: string; score: number } | null>((acc, cur) => (cur.score > 0 && (!acc || cur.score > acc.score) ? cur : acc), null);
    // 路径型证据的上限按"主分类 + 最佳子分类合计"施加（否则父桶、子桶各吃一份上限，等于没限制）
    const strongTotal = strongOf(top.id) + (bestSub ? strongOf(bestSub.id) : 0);
    const pathTotal = pathOf(top.id) + (bestSub ? pathOf(bestSub.id) : 0);
    const score = strongTotal + Math.min(PATH_GAIN_CAP, pathTotal);
    if (score > 0) ranked.push({ categoryId: top.id, subCategoryId: bestSub?.id ?? null, score: Math.round(score * 1000) / 1000, strongScore: Math.round(strongTotal * 1000) / 1000 });
  }
  ranked.sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      categoryId: null, subCategoryId: null, confidence: 0, score: 0, runnerUpScore: 0,
      level: "none", ambiguous: false, evidence: [], reason: "没有任何分类证据，保持未分类",
    };
  }

  const best = ranked[0]!;
  const runnerUpScore = ranked[1]?.score ?? 0;
  // 歧义判定只看"强证据"：第二名若只是"包里带了某类文件"（路径证据被上限压到 0.6），不构成真正的歧义。
  // 双方都没有强证据时才退回总分比较。
  const runnerUpStrong = ranked[1]?.strongScore ?? 0;
  const useStrong = best.strongScore > 0 || runnerUpStrong > 0;
  const cmpTop = useStrong ? best.strongScore : best.score;
  const cmpSecond = useStrong ? runnerUpStrong : runnerUpScore;
  const ambiguous = cmpSecond > 0 && cmpTop - cmpSecond < AMBIGUITY_MARGIN * cmpTop;
  let confidence = Math.min(1, best.score / CONFIDENCE_SATURATION);
  if (ambiguous) confidence *= AMBIGUITY_PENALTY;
  confidence = Math.round(confidence * 1000) / 1000;

  const level: CategoryLevel = confidence >= thresholds.autoThreshold ? "auto"
    : confidence >= thresholds.suggestThreshold ? "suggest" : "none";

  const shown = deduped.filter((h) => h.subCategoryId === best.subCategoryId || h.categoryId === best.categoryId).slice(0, MAX_EVIDENCE);
  const parts = shown.slice(0, 4).map((h) => `${FIELD_LABEL[h.field]}含「${h.keyword}」+${h.gain.toFixed(2)}`);
  const bestPath = [defs.find((d) => d.id === best.categoryId)?.name, best.subCategoryId ? defs.find((d) => d.id === best.subCategoryId)?.name : null].filter(Boolean).join(" › ");
  const reason = `${parts.join("；")} → ${bestPath}（得分 ${best.score.toFixed(2)}，置信度 ${confidence.toFixed(2)}${ambiguous ? "，与第二分类接近已降权" : ""}）`;

  return {
    categoryId: best.categoryId,
    subCategoryId: best.subCategoryId,
    confidence,
    score: best.score,
    runnerUpScore,
    level,
    ambiguous,
    evidence: shown,
    reason,
  };
}

/** 证据 → 可存库的紧凑 JSON（去掉冗余的 label） */
export function evidenceToJson(rec: CategoryRecommendation): string {
  return JSON.stringify(rec.evidence.map((e) => ({ field: e.field, rule: e.ruleId, matched: e.matched, gain: e.gain, cat: e.categoryId, sub: e.subCategoryId })));
}
