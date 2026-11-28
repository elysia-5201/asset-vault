export const SEARCH_LEXICON_VERSION = 1;
export const AVATAR_SEARCH_NAMES: Readonly<Record<string, readonly string[]>> = {
  manuka: ["玛努卡", "瑪努卡", "マヌカ"],
  kikyo: ["桔梗", "キキョウ"],
  shinano: ["信浓", "信濃", "しなの"],
  chocolat: ["巧克力", "ショコラ"],
  milfy: ["米尔菲", "ミルフィ"],
  mamehinata: ["豆雏", "まめひなた"],
  selestia: ["塞蕾斯蒂亚", "セレスティア"],
  milltina: ["米尔缇娜", "ミルティナ"],
};

export interface SearchConcept {
  id: string;
  label: string;
  words: readonly string[];
  related?: readonly string[];
  type?: string;
  field?: "color" | "style";
  generic?: boolean;
}

export const SEARCH_LEXICON: readonly SearchConcept[] = [
  { id: "clothes", label: "服饰", type: "clothing", words: ["服饰", "衣服", "服装", "衣装", "衣著", "衣着", "clothing", "clothes", "outfit"] },
  { id: "dress", label: "连衣裙", type: "clothing.dress", words: ["连衣裙", "連衣裙", "ワンピース", "dress"], related: ["裙子", "スカート", "skirt"] },
  { id: "skirt", label: "裙子", words: ["裙子", "半身裙", "スカート", "skirt"], related: ["连衣裙", "ワンピース", "dress"] },
  { id: "long-skirt", label: "长裙", words: ["长裙", "長裙", "ロングスカート", "long skirt", "maxi skirt"], related: ["长款连衣裙", "maxi dress"] },
  { id: "shoes", label: "鞋袜", type: "clothing.shoes_socks", words: ["鞋子", "鞋袜", "シューズ", "靴", "shoes", "socks"] },
  { id: "tops", label: "上衣", type: "clothing.tops", words: ["上衣", "トップス", "tops", "shirt"] },
  { id: "hoodie", label: "卫衣", words: ["卫衣", "連帽衫", "连帽衫", "パーカー", "hoodie"] },
  { id: "coat", label: "外套", type: "clothing.coat", words: ["外套", "コート", "coat", "jacket"] },
  { id: "hair", label: "发型", type: "hair", words: ["发型", "头发", "髮型", "髪型", "ヘア", "髪", "hair", "hairstyle"] },
  { id: "long-hair", label: "长发", type: "hair.long", words: ["长发", "長髮", "ロングヘア", "long hair"] },
  { id: "short-hair", label: "短发", type: "hair.short", words: ["短发", "短髮", "ショートヘア", "short hair"] },
  { id: "twintails", label: "双马尾", type: "hair.twintails", words: ["双马尾", "ツインテール", "twin tails", "twintails"] },
  { id: "ponytail", label: "单马尾", type: "hair.ponytail", words: ["单马尾", "ポニーテール", "ponytail"] },
  { id: "accessories", label: "饰品", type: "accessories", words: ["饰品", "配饰", "アクセサリー", "accessories", "accessory"] },
  { id: "necklace", label: "项链", type: "accessories.necklace", words: ["项链", "項鏈", "ネックレス", "necklace", "choker", "チョーカー"] },
  { id: "earring", label: "耳饰", type: "accessories.earring", words: ["耳饰", "耳环", "ピアス", "イヤリング", "earrings", "earring"] },
  { id: "makeup", label: "妆容", type: "makeup", words: ["妆容", "妝容", "化妆", "メイク", "makeup", "make up"] },
  { id: "blush", label: "腮红", type: "makeup.blush", words: ["腮红", "チーク", "blush"] },
  { id: "eyeliner", label: "眼线", type: "makeup.eyeliner", words: ["眼线", "アイライン", "eyeliner"] },
  { id: "material", label: "材质", words: ["材质", "材質", "マテリアル", "material", "materials"], related: [".mat"] },
  { id: "texture", label: "贴图", words: ["贴图", "纹理", "テクスチャ", "texture", "textures"] },
  { id: "black", label: "黑色", field: "color", words: ["黑色", "黑", "黒色", "黒", "ブラック", "black"] },
  { id: "white", label: "白色", field: "color", words: ["白色", "白", "ホワイト", "white"] },
  { id: "red", label: "红色", field: "color", words: ["红色", "赤色", "赤", "レッド", "red"] },
  { id: "blue", label: "蓝色", field: "color", words: ["蓝色", "青色", "ブルー", "blue"] },
  { id: "pink", label: "粉色", field: "color", words: ["粉色", "粉红色", "ピンク", "pink"] },
  { id: "purple", label: "紫色", field: "color", words: ["紫色", "パープル", "purple"] },
  { id: "gothic", label: "哥特", field: "style", words: ["哥特", "哥特风", "哥特风格", "ゴシック", "gothic", "goth"] },
  { id: "cyberpunk", label: "赛博朋克", field: "style", words: ["赛博朋克", "赛博风", "サイバーパンク", "cyberpunk"] },
  { id: "cute", label: "可爱风", field: "style", words: ["可爱", "可爱风", "かわいい", "可愛い", "キュート", "cute", "kawaii"] },
  { id: "animation", label: "动画", type: "animation", words: ["动画", "动作", "アニメーション", "animation", "anim"] },
  { id: "expression", label: "表情", type: "animation.expression", words: ["表情", "expression", "facial expression"] },
  { id: "pose", label: "姿势", type: "animation.pose", words: ["姿势", "姿态", "ポーズ", "pose"] },
  { id: "shader", label: "着色器", type: "shaders", words: ["着色器", "シェーダー", "shader"] },
  { id: "shadow", label: "阴影", words: ["阴影", "陰影", "シャドウ", "影", "shadow"] },
  { id: "tool", label: "工具", type: "tools", words: ["工具", "ユーティリティ", "ツール", "tool"] },
  { id: "plugin", label: "插件", words: ["插件", "プラグイン", "ギミック", "plugin", "gimmick"], related: ["system", "システム", "ツール"], generic: true },
  { id: "headpat", label: "抚摸", words: ["抚摸", "摸头", "なでなで", "撫で", "なで", "headpat", "head pat", "petting", "nadenade"] },
  { id: "sfx", label: "音效", type: "audio.sfx", words: ["音效", "効果音", "サウンド", "さうんど", "撫で音", "なで音", "sfx", "sound effect", "sound"], related: ["audio", "音"] },
  { id: "outfit-switch", label: "换装", words: ["换装", "着せ替え", "衣装切替", "outfit switch", "clothes toggle"] },
  { id: "physbone", label: "PhysBone", words: ["physbone", "phys bone", "物理骨骼", "フィズボーン"] },
  { id: "modular-avatar", label: "Modular Avatar", words: ["modular avatar", "モジュラーアバター"], related: ["ma"] },
  { id: "unitypackage", label: "UnityPackage", words: ["unitypackage", "unity package", "ユニティパッケージ"] },
  { id: "fbx", label: "FBX", words: ["fbx", "fbx模型"] },
  { id: "prefab", label: "Prefab", words: ["prefab", "预制体", "プレハブ"] },
  { id: "psd", label: "PSD", words: ["psd", "photoshop source", "psd源文件"] },
];
