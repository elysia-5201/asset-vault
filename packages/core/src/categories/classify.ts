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
  // ---------- 服装 ----------
  r("clothing.primary", "clothing", null, 1.0, ["衣装", "服", "ウェア", "outfit", "clothes", "clothing", "コスチューム", "costume", "衣類", "洋服", "ドレスアップ", "きせかえ", "着せ替え"], { negations: ["服飾小物", "衣服", "不服"] }),
  r("clothing.tops", "clothing", "clothing.tops", 1.0, ["トップス", "シャツ", "shirt", "ブラウス", "blouse", "ニット", "knit", "セーター", "sweater", "パーカー", "hoodie", "tシャツ", "tshirt", "タンク", "tank top", "ベスト", "vest", "チューブトップ"]),
  r("clothing.bottoms", "clothing", "clothing.bottoms", 1.0, ["ボトムス", "スカート", "skirt", "パンツ", "pants", "ズボン", "ショートパンツ", "shorts", "ジーンズ", "jeans", "レギンス", "leggings", "ホットパンツ", "スパッツ"]),
  r("clothing.dress", "clothing", "clothing.dress", 1.0, ["ワンピース", "onepiece", "ワンピ", "dress", "ドレス", "サンドレス", "ロングドレス"]),
  r("clothing.suit", "clothing", "clothing.suit", 1.0, ["セットアップ", "setup", "スーツ", "suit", "制服", "ユニフォーム", "uniform", "セーラー服", "巫女服", "体操服", "着物", "浴衣", "メイド服", "ナース服", "コーデ", "バニー", "bunny", "バニースーツ"]),
  r("clothing.coat", "clothing", "clothing.coat", 1.0, ["コート", "coat", "ジャケット", "jacket", "マント", "cloak", "ケープ", "cape", "ポンチョ", "poncho", "ブルゾン", "羽織", "パーカー"]),
  r("clothing.underwear", "clothing", "clothing.underwear", 1.0, ["下着", "ブラジャー", "ブラ", "bra", "パンティ", "ぱんつ", "ショーツ", "ランジェリー", "lingerie", "インナー", "underwear", "キャミソール", "camisole", "ベビードール"], { negations: ["ブラシ", "ブランド", "ブラウス", "ブラウン"] }),
  r("clothing.swimwear", "clothing", "clothing.swimwear", 1.0, ["水着", "swimsuit", "swimwear", "ビキニ", "bikini", "競泳", "スクール水着", "マイクロビキニ", "タンキニ"]),
  r("clothing.shoes", "clothing", "clothing.shoes", 1.0, ["靴", "くつ", "shoes", "ブーツ", "boots", "サンダル", "sandal", "ヒール", "heels", "パンプス", "pumps", "スニーカー", "sneaker"], { negations: ["靴下"] }),
  r("clothing.socks", "clothing", "clothing.socks", 1.0, ["靴下", "ソックス", "socks", "ニーソ", "ニーハイ", "ストッキング", "stockings", "タイツ", "tights", "ガーター", "ガーターベルト", "網タイツ"]),

  // ---------- 工具 ----------
  r("tools.primary", "tools", null, 0.9, ["ツール", "tool", "エディタ拡張", "editor extension", "プラグイン", "plugin", "スクリプト", "script", "ユーティリティ", "utility"], { negations: ["アセットストア"] }),
  r("tools.unity", "tools", "tools.unity", 1.0, ["unity", "unitypackage", "upm", "vpm", "editorwindow", "editorextension", "unity editor", "エディター拡張", "メニューに追加"]),
  r("tools.avatar_edit", "tools", "tools.avatar_edit", 1.0, ["アバター編集", "blendshape", "シェイプキー", "shape key", "ボーン", "bone", "rig", "リギング", "ウェイトペイント", "weightpaint", "メッシュ編集", "mesh edit", "改変", "お着替え", "着せ替えツール", "ポリゴン削減", "デシメート", "decimate"]),
  r("tools.modular_avatar", "tools", "tools.modular_avatar", 1.2, ["modular avatar", "modularavatar", "modular-avatar", "ndmf", "vrcfury", "vrchat fury", "モジュラーアバター", "ma component"]),
  r("tools.upload", "tools", "tools.upload", 1.0, ["アップロード", "upload", "vrcsdk", "vrchat sdk", "blueprint id", "ブループリント", "管理ツール", "アカウント管理"]),
  r("tools.automation", "tools", "tools.automation", 1.0, ["自動化", "automation", "automate", "ビルドスクリプト", "batch", "バッチ", "自動生成", "ジェネレータ", "generator", "スクリプト生成"]),

  // ---------- 饰品 ----------
  r("accessories.primary", "accessories", null, 1.0, ["アクセサリー", "accessory", "accessories", "アクセ", "装飾品", "小物", "ornament", "ジュエリー", "jewelry"]),
  r("accessories.headwear", "accessories", "accessories.headwear", 1.0, ["ヘッドドレス", "headwear", "帽子", "hat", "キャップ", "cap", "ベレー", "beret", "ティアラ", "tiara", "クラウン", "crown", "花冠", "ミニハット", "ナース帽"], { negations: ["キャップレス", "ハットトリック"] }),
  r("accessories.hair_ornament", "accessories", "accessories.hair_ornament", 1.1, ["ヘアピン", "hairpin", "ヘアゴム", "シュシュ", "リボン", "ribbon", "カチューシャ", "headband", "ヘアクリップ", "髪飾り", "かんざし", "簪", "ヘアアクセ"]),
  r("accessories.earring", "accessories", "accessories.earring", 1.0, ["イヤリング", "earring", "ピアス", "pierce", "耳飾り", "イヤーカフ"]),
  r("accessories.necklace", "accessories", "accessories.necklace", 1.0, ["ネックレス", "necklace", "チョーカー", "choker", "ペンダント", "pendant", "首輪", "鈴付き首輪", "ネックカバー"]),
  r("accessories.hand", "accessories", "accessories.hand", 1.0, ["指輪", "ブレスレット", "bracelet", "リストバンド", "wristband", "グローブ", "glove", "手袋", "ネイル", "nail", "爪", "マニキュア"], { negations: ["指輪っか"] }),
  r("accessories.glasses", "accessories", "accessories.glasses", 1.1, ["メガネ", "めがね", "眼鏡", "glasses", "サングラス", "sunglasses", "ゴーグル", "goggles", "アイウェア", "eyewear"]),
  r("accessories.tail", "accessories", "accessories.tail", 1.1, ["しっぽ", "尻尾", "テイル", "tail", "尾っぽ"], { negations: ["テイルズ", "ディテール"] }),
  r("accessories.wings", "accessories", "accessories.wings", 1.1, ["翼", "つばさ", "ウイング", "wing", "羽根", "フェザーウィング"]),
  r("accessories.horns", "accessories", "accessories.horns", 1.1, ["獣耳", "けもみみ", "ケモミミ", "猫耳", "ねこみみ", "犬耳", "うさみみ", "兎耳", "狐耳", "きつねみみ", "animal ears", "ホーン", "つの", "角"]),

  // ---------- 妆容 ----------
  r("makeup.primary", "makeup", null, 1.0, ["メイク", "makeup", "メイクアップ", "化粧", "コスメ", "cosmetics", "メイク道具"]),
  r("makeup.eye", "makeup", "makeup.eye", 1.1, ["アイメイク", "アイシャドウ", "eyeshadow", "アイライン", "eyeliner", "まつげ", "まつ毛", "睫毛", "eyelash", "アイラッシュ", "目元メイク"]),
  r("makeup.lip", "makeup", "makeup.lip", 1.1, ["リップ", "lip", "口紅", "ルージュ", "rouge", "グロス", "lipgloss", "リップスティック", "リップメイク"]),
  r("makeup.blush", "makeup", "makeup.blush", 1.1, ["チーク", "cheek", "blush", "頬紅", "ほっぺ"]),
  r("makeup.face_texture", "makeup", "makeup.face_texture", 1.1, ["顔テクスチャ", "フェイステクスチャ", "face texture", "顔のテクスチャ", "顔面テクスチャ", "シェーディングテクスチャ"]),
  r("makeup.skin_texture", "makeup", "makeup.skin_texture", 1.1, ["肌テクスチャ", "スキンテクスチャ", "skin texture", "肌のテクスチャ", "ボディテクスチャ余白"], { negations: ["肌着"] }),

  // ---------- 头发 ----------
  r("hair.primary", "hair", null, 1.0, ["髪", "ヘア", "hair", "ウィッグ", "wig", "前髪", "bangs", "ロングヘア", "ショートヘア", "ツインテール", "ポニーテール"], { negations: ["ヘアピン", "ヘアゴム", "ヘアクリップ", "ヘアアクセ", "ヘアバンド", "ヘアカラー剤"] }),
  r("hair.model", "hair", "hair.model", 1.1, ["ヘアモデル", "髪型", "hairstyle", "hair style", "ヘアセット", "ヘアアセット", "ウィッグ", "wig", "髪モデル", "ウィッグモデル"]),
  r("hair.texture", "hair", "hair.texture", 1.1, ["ヘアテクスチャ", "hair texture", "髪テクスチャ", "ヘアカラーテクスチャ", "ヘアマテリアル"]),

  // ---------- Avatar 与模型 ----------
  // 注意：不要把「モデル」「アバター」当主分类关键词——几乎每个 VRChat 素材的 BOOTH 分类都带「3Dモデル」，
// 那会让 models 成为所有条目的第二分类、把别的分类全部拖进"歧义降权"。模型类只靠更具体的词判定。
  r("models.primary", "models", null, 0.9, ["素体", "ベースモデル", "アバターモデル", "モデルデータ", "3dモデル本体"]),
  r("models.avatar", "models", "models.avatar", 1.2, ["アバター本体", "アバターセット", "フルセット", "full set", "完成品アバター", "vrm", "アバター一式", "アバターデータ"]),
  r("models.body", "models", "models.body", 1.0, ["素体", "base body", "ボディ", "body", "身体", "体モデル", "ヌードモデル", "ボディモデル"], { negations: ["ボディスーツ", "ボディアクセ", "ボディペイント"] }),
  r("models.head", "models", "models.head", 1.0, ["頭部", "head model", "頭モデル", "顔モデル", "顔面モデル", "ヘッドモデル"]),
  r("models.parts", "models", "models.parts", 0.9, ["パーツ", "parts", "部品", "メッシュ", "mesh", "差分パーツ", "追加パーツ"]),

  // ---------- 纹理与材质 ----------
  r("textures.primary", "textures", null, 0.9, ["テクスチャ", "texture", "マテリアル", "material", "テクスチャー", "マテリアルセット"]),
  r("textures.texture", "textures", "textures.texture", 1.0, ["テクスチャ", "texture", "ノーマルマップ", "normalmap", "法線マップ", "テクスチャセット", "高解像度テクスチャ"], { negations: ["テクスチャなし"] }),
  r("textures.material", "textures", "textures.material", 1.0, ["マテリアル", "material", ".mat", "matファイル", "マテリアルファイル", "材質"]),
  r("textures.material_preset", "textures", "textures.material_preset", 1.0, ["マテリアルプリセット", "material preset", "プリセット", "preset", "設定ファイル付き", "マテリアル設定"]),
  r("textures.eye", "textures", "textures.eye", 1.1, ["瞳テクスチャ", "eye texture", "アイテクスチャ", "瞳", "iris", "目玉", "瞳のテクスチャ", "eyes texture"], { negations: ["瞳の色変更のみ", "目的", "項目", "注目", "目次"] }),
  r("textures.skin", "textures", "textures.skin", 1.0, ["肌テクスチャ", "スキンテクスチャ", "skin texture", "肌", "スキン", "body texture"], { negations: ["肌着", "スキンケア"] }),

  // ---------- Shader 与渲染 ----------
  r("shaders.primary", "shaders", null, 1.0, ["シェーダー", "shader", "シェーダ", "hlsl", "cginc", "liltoon", "poiyomi", "unitychan toon", "シェーディング"], { negations: ["シェーダーなし"] }),
  r("shaders.shader", "shaders", "shaders.shader", 1.2, ["シェーダー", "shader", ".shader", "hlsl", "cginc", "liltoon", "poiyomi", "toon shader", "シェーダーファイル"]),
  r("shaders.preset", "shaders", "shaders.preset", 1.0, ["シェーダー設定", "shader preset", "プリセット", "preset", "設定ファイル", "matcap"]),
  r("shaders.effect", "shaders", "shaders.effect", 1.0, ["影", "shadow", "アウトライン", "outline", "リムライト", "rim light", "発光", "emission", "グロウ", "glow", "ハイライト", "反射", "reflection", "スペキュラ", "specular"], { negations: ["影なし", "シャドウなし", "no shadow", "影を落とさない", "影が出ない", "アウトラインなし"] }),
  r("shaders.postprocess", "shaders", "shaders.postprocess", 1.2, ["ポストプロセス", "post process", "postprocess", "post processing", "ブルーム", "bloom", "被写界深度", "dof", "色収差", "カラーグレーディング", "トーンマップ", "tonemap", "画面効果"]),

  // ---------- 动画与动作 ----------
  r("animation.primary", "animation", null, 0.9, ["アニメーション", "animation", "アニメ", "モーション", "motion", "キーフレーム"]),
  r("animation.anim", "animation", "animation.anim", 1.0, ["アニメーション", "animation", ".anim", "animファイル", "キーフレーム", "アニメカーブ", "アニメーションデータ"]),
  r("animation.dance", "animation", "animation.dance", 1.2, ["ダンス", "dance", "踊り", "踊ってみた", "振り付け", "ダンスモーション", "ダンスアニメ"]),
  r("animation.pose", "animation", "animation.pose", 1.1, ["ポーズ", "pose", "立ちポーズ", "座りポーズ", "静止ポーズ", "ポーズ集"]),
  r("animation.expression", "animation", "animation.expression", 1.0, ["表情", "expression", "シェイプキー", "blendshape", "まばたき", "瞬き", "口パク", "リップシンク", "アイトラッキング", "表情セット"]),
  r("animation.gesture", "animation", "animation.gesture", 1.1, ["ジェスチャー", "gesture", "ハンドサイン", "hand sign", "フィンガー", "finger", "指アニメ"]),
  r("animation.controller", "animation", "animation.controller", 1.0, ["アニメーター", "animator", "コントローラー", "controller", "ステートマシン", "statemachine", "アニメーションパラメータ", "exmenu", "expression menu"]),

  // ---------- 特效 ----------
  r("effects.primary", "effects", null, 1.0, ["エフェクト", "effect", "vfx", "パーティクル", "particle", "ギミック効果"]),
  r("effects.particle", "effects", "effects.particle", 1.1, ["パーティクル", "particle", "エミッター", "emitter", "煙", "smoke", "炎", "火炎", "花びら", "petal", "雪", "snow", "星屑", "キラキラ", "きらきら", "kirakira"]),
  r("effects.preset", "effects", "effects.preset", 1.0, ["エフェクトプリセット", "effect preset", "エフェクト集", "パーティクルプリセット"]),
  r("effects.light", "effects", "effects.light", 1.0, ["ライト", "light", "発光", "glow", "ネオン", "neon", "レーザー", "laser", "オーラ", "aura", "光の輪"]),

  // ---------- 音频 ----------
  r("audio.primary", "audio", null, 1.0, ["音声", "ボイス", "voice", "サウンド", "sound", "音楽", "music", "効果音", "オーディオ", "audio"], { negations: ["サウンドトラックのみ"] }),
  r("audio.sfx", "audio", "audio.sfx", 1.2, ["効果音", "se素材", "sfx", "effect sound", "サウンドエフェクト", "システム音"]),
  r("audio.music", "audio", "audio.music", 1.2, ["音楽", "music", "楽曲", "ソング", "song", "bgm", "インスト曲"]),
  r("audio.voice", "audio", "audio.voice", 1.2, ["ボイス", "voice", "音声素材", "セリフ", "台詞", "ボイス素材", "しゃべり", "喋り"]),

  // ---------- 场景与世界 ----------
  r("worlds.primary", "worlds", null, 0.9, ["ワールド", "world", "シーン", "scene", "環境", "environment", "背景"]),
  r("worlds.vrchat", "worlds", "worlds.vrchat", 1.2, ["vrchat world", "vrchatワールド", "ワールドデータ", "アップロード用ワールド", "worldsファイル"]),
  r("worlds.scene", "worlds", "worlds.scene", 1.1, ["unity scene", ".unity", "シーンファイル", "ステージ", "stage", "ステージセット"]),
  r("worlds.skybox", "worlds", "worlds.skybox", 1.2, ["スカイボックス", "skybox", "空のテクスチャ", "スカイ", "夕焼け", "星空", "hdri", "パノラマ", "空mod"]),
  r("worlds.environment", "worlds", "worlds.environment", 1.0, ["環境", "environment", "地形", "terrain", "植栽", "建物", "building", "街並み", "部屋", "room", "背景セット"]),

  // ---------- UI 与界面 ----------
  r("ui.primary", "ui", null, 0.8, ["ui", "ユーザーインターフェース", "インターフェース", "ui素材", "uiセット"]),
  r("ui.component", "ui", "ui.component", 1.1, ["uiコンポーネント", "ui component", "ウィジェット", "widget", "ボタン素材", "パネル素材", "スライダー"]),
  r("ui.icon", "ui", "ui.icon", 1.0, ["アイコン", "icon", "サムネイル素材", "プレビュー画像", "ロゴ", "logo", "アイコンセット"]),
  r("ui.hud", "ui", "ui.hud", 1.2, ["hud", "オーバーレイ", "常時表示ui", "ヘッドマウント表示"]),
  r("ui.menu", "ui", "ui.menu", 1.0, ["メニュー", "menu", "エクスプレッションメニュー", "expression menu", "選択メニュー"]),

  // ---------- 其他 ----------
  r("other.primary", "other", null, 0.7, ["その他", "other素材", "misc", "雑多", "詰め合わせ"], { fields: ["title", "tag", "filename", "description"] }),
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
  // 同一处证据只算一次：主分类规则与子分类规则常共享关键词（shaders.primary 与 shaders.shader 都含「シェーダー」），
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
