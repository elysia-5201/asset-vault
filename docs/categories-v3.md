# 分类体系 v3（冻结契约）—— 15 大分类 / 二级子分类 / 标签 / 管理页

> 本文件是 v3 的**接口契约**：服务端、前端、测试都按它实现。改动先找 lead。
> v2（14 主分类 / 79 子分类）实现于 0.3.0；v3 在其上**增量迁移**，不重建、不动素材。

## 1. 一级分类（15 个，全部 is_system=1）

| sort | id | name | 子分类数 |
|---|---|---|---|
| 100 | clothing | 服饰 | 8 |
| 200 | makeup | 妆容 | 8 |
| 300 | hair | 头发 | 7 |
| 400 | models | 模型 | 6 |
| 500 | textures | 材质与纹理 | 6 |
| 600 | shaders | Shader | 5 |
| 700 | animation | 动画与动作 | 7 |
| 800 | effects | 特效 | 5 |
| 900 | tools | 工具 | 5 |
| 1000 | accessories | 饰品 | 8 |
| 1100 | audio | 音频 | 4 |
| 1200 | worlds | 场景 | 5 |
| 1300 | ui | UI | 4 |
| 1400 | other | 其他 | 2 |
| 1500 | uncategorized | 未分类 | 0（系统分类） |

- ID 沿用 v2 的 14 个（clothing/makeup/hair/models/textures/shaders/animation/effects/tools/accessories/audio/worlds/ui/other）
  → **素材上的 cat_id 不用改**，只改 name/sort/顺序。
- 新增 `uncategorized`（未分类）：系统分类，无子分类、不可删除/停用，永远可访问；也是删除/合并时的合法转移目标。
- **未分类的规范存储仍是 `items.cat_id IS NULL`**：`uncategorized` 行只是导航/管理页入口，
  统计与筛选把两者视为同一集合（`cat_id IS NULL OR cat_id = (未分类 id)`）。把素材设为「未分类」= 清空 cat_id。
  这样不用给全库素材回写一行，也保持与 0.2/0.3 兼容。

## 2. 二级子分类（80 个，ID = `<父id>.<slug>`）

| 父 | 子（id: 名称） |
|---|---|
| clothing | tops 上衣 / bottoms 下装 / dress 连衣裙 / coat 外套 / shoes_socks 鞋袜 / underwear 内衣 / suit 套装 / accessory 服饰配件 |
| makeup | eyeshadow 眼影 / eyeliner 眼线 / lashes 睫毛 / brows 眉毛 / blush 腮红 / lips 唇妆 / fullface 全脸妆 / set 妆容套装 |
| hair | short 短发 / long 长发 / twintails 双马尾 / ponytail 单马尾 / braid 辫子 / bangs 刘海 / set 发型套装 |
| models | avatar Avatar / body 身体 / head 头部 / animal 动物 / pet 宠物 / prop 道具模型 |
| textures | skin 皮肤 / eye 眼睛 / hair 头发 / clothing 服饰 / normal 法线贴图 / pbr PBR 贴图 |
| shaders | skin 皮肤 Shader / hair 头发 Shader / cloth 布料 Shader / effect 特效 Shader / general 通用 Shader |
| animation | idle 待机 / walk 行走 / dance 舞蹈 / expression 表情 / gesture 手势 / pose 姿势 / set 动作套装 |
| effects | particle 粒子 / light 光效 / magic 魔法特效 / outline 描边 / screen 屏幕特效 |
| tools | unity Unity 编辑器工具 / avatar Avatar 工具 / installer 安装工具 / optimize 优化工具 / script 辅助脚本 |
| accessories | earring 耳饰 / necklace 项链 / ring 戒指 / glasses 眼镜 / hat 帽子 / hair_ornament 发饰 / wings 翅膀 / tail 尾巴 |
| audio | bgm BGM / ambient 环境音 / sfx 音效 / voice 语音 |
| worlds | indoor 室内 / outdoor 室外 / skybox 天空盒 / world 世界场景 / prop 场景道具 |
| ui | menu 菜单 / icon 图标 / hud HUD / interactive 交互界面 |
| other | unclassed 暂未归类 / pending 待整理 |

约束：
1. 只允许两层；子分类的父必须是一级分类。
2. 子分类**可以移动到另一个一级分类**（需求 §6.2）：ID 保持不变（ID 是稳定标识，允许前缀与实际父不一致）。
3. 系统分类（is_system=1）不可删除、不可停用；普通分类（用户自建 is_system=0）可改名/排序/停用/删除/移动/合并。
4. 删除或合并**绝不删除素材**：其下素材必须转移到指定分类或「未分类」，事务内完成。
5. 分类 ID 不依赖排序位置；排序只改 sort。

## 3. 迁移 v2 → v3（幂等 + 事务 + 可回退）

`migrate.ts` 新增 `taxonomy_version` 步骤（写 `schema_meta.taxonomy_version = (版本号)`）：

1. **一级**：已存在的 ID → 更新 name/sort/is_system/enabled；不存在的 → 新建（含未分类）。
2. **二级**：v3 列表内的 → 存在则更新（名/排序/父/启用），不存在则新建。
3. **旧子分类（v2 有、v3 没有）**：先把引用它的素材改指到映射目标（无对应则回到其一级分类，即清空子分类），
   并清理 `cat_suggest_sub_id`；然后删除该行。内置分类的"不可删除"只约束**用户操作**，不约束迁移。
4. **用户自建分类（is_system=0）一律不动**。
5. 全程一个事务；失败整体回滚（库仍是迁移前结构），错误写启动日志。
6. 迁移前后都记录计数（items/assets/categories），便于事后核对。

### 旧 → 新 子分类映射（同父内；`(父)` = 回退到一级分类，清空子分类）

```
clothing.tops→clothing.tops        clothing.bottoms→clothing.bottoms      clothing.dress→clothing.dress
clothing.suit→clothing.suit        clothing.coat→clothing.coat            clothing.underwear→clothing.underwear
clothing.shoes→clothing.shoes_socks  clothing.socks→clothing.shoes_socks
clothing.swimwear→(父)             clothing.other→(父)
makeup.eye→makeup.eyeshadow        makeup.lip→makeup.lips                 makeup.blush→makeup.blush
makeup.face_texture→makeup.fullface  makeup.skin_texture→makeup.fullface  makeup.other→(父)
hair.model→hair.set                hair.texture→(父)                      hair.other→(父)
models.avatar→models.avatar        models.body→models.body                models.head→models.head
models.parts→(父)                  models.other→(父)
textures.eye→textures.eye          textures.skin→textures.skin            textures.texture→(父)
textures.material→(父)             textures.material_preset→(父)          textures.other→(父)
shaders.shader→shaders.general     shaders.effect→shaders.effect          shaders.preset→shaders.general
shaders.postprocess→shaders.general  shaders.other→(父)
animation.dance→animation.dance    animation.pose→animation.pose          animation.expression→animation.expression
animation.gesture→animation.gesture  animation.anim→(父)  animation.controller→(父)  animation.other→(父)
effects.particle→effects.particle  effects.light→effects.light            effects.preset→(父)  effects.other→(父)
tools.unity→tools.unity            tools.avatar_edit→tools.avatar         tools.modular_avatar→tools.avatar
tools.upload→tools.installer       tools.automation→tools.script          tools.other→(父)
accessories.headwear→accessories.hat   accessories.hair_ornament→accessories.hair_ornament
accessories.earring→accessories.earring  accessories.necklace→accessories.necklace
accessories.hand→accessories.ring      accessories.glasses→accessories.glasses
accessories.tail→accessories.tail      accessories.wings→accessories.wings
accessories.horns→(父)             accessories.other→(父)
audio.sfx→audio.sfx  audio.music→audio.bgm  audio.voice→audio.voice  audio.other→(父)
worlds.vrchat→worlds.world  worlds.scene→worlds.world  worlds.skybox→worlds.skybox
worlds.environment→(父)  worlds.other→(父)
ui.component→ui.interactive  ui.icon→ui.icon  ui.hud→ui.hud  ui.menu→ui.menu  ui.other→(父)
```

## 4. 标签（与分类严格分开）

- 存储沿用 `tags(id, name, namespace, color, sort)` + `item_tags(item_id, tag_id, source)`；
  标签身份 = `(namespace, name)`，**颜色不是身份**。
- 默认标签（**只播种一次**，用 `settings.tags_seed_version` 记版本；用户删掉不会被复活）：
  哥特风 / 可爱风 / 赛博风 / 黑色 / 白色 / 免费 / 已购买 / PhysBones / Modular Avatar / Quest 兼容 / 待检查
- 新增 API：

```
GET    /api/tags                     → { tags: [{id,name,namespace,color,sort,itemCount}] }   （已有，补 color/sort）
POST   /api/tags {name,color?}       → 201 {tag}；同名 → 直接返回已存在的（幂等，绝不重复创建）
PATCH  /api/tags/:id {name?,color?}  → { tag }；改名后素材关联自动跟随（按 id 关联）
DELETE /api/tags/:id                 → { removed: n }（同时删 item_tags 关联；不删素材、不删文件）
```

- 素材标签编辑：沿用 `POST /api/items/:id/tags`（追加）与 `PATCH /api/items/:id {tags}`（全量替换）。
- 筛选：`/api/items?tags=a,b&tagsMatch=any|all`（与 avatar 的 ANY/ALL 同语义）；旧的单个 `tag=` 保持兼容。

## 5. 筛选与计数

- 分类语义：选一级 = 命中该一级（含其下所有子分类）；选子分类 = 命中该子分类；
  一级的「全部」= 清掉该一级下的子分类限制；全局「全部」= 清掉分类限制。
- 「未分类」一级 = `cat_id IS NULL OR cat_id = (未分类 id)`，与旧的 `uncategorized=1` 等价。
- 与关键词 / 标签(ANY|ALL) / avatar(ANY|ALL) / 来源 / 状态 / 容器 / 已导入 / 收藏组合，互不覆盖。
- **计数口径**：`GET /api/categories/counts` 接受与 /api/items 相同的筛选参数，返回
  `{ all, uncategorized, tops: [{id,count}], subs: [{id,count}] }`，**用 GROUP BY 一次性算出**（不是每个分类查一次）。
  UI 分类栏显示该计数并标明「当前筛选下」；管理页用全局计数（`GET /api/categories` 的 stats）。

## 6. 分类管理 API

```
GET    /api/categories/:id/impact                → { items, subs, suggestions }   删除/合并前的影响面
POST   /api/categories/:id/move {parentId}       → { category }                   子分类换父（ID 不变）
POST   /api/categories/:id/merge {intoId}        → { moved, deleted }             合并：素材与建议迁到目标后删源（事务）
DELETE /api/categories/:id?transferTo=<id|none>  → { moved, movedSubs, deleted }   删除：素材先转移再删；系统分类 409
POST   /api/categories {id?,name,parentId?,sort?}     → 201 { category }          新建（已有）
PATCH  /api/categories/:id {name?,sort?,enabled?,parentId?} → { category }        改名/排序/停用/移动（已有，需放开子分类换父）
```

## 7. 自动分类与人工优先（沿用 0.3.0 机制，不重建）

- 唯一自动写入口 `repo.applyAutoCategory()`：`cat_source ∈ manual|confirmed` 时**只写建议**，绝不改归属。
- 分级不变（auto ≥0.75 / suggest ≥0.4 / 否则保持未分类）；规则里引用 v3 已不存在的 ID 会被安全忽略。
- 自动分类可产出**建议标签**（仅建议，不自动写入 item_tags）。
- 分类失败不得阻断导入/扫描/入库（`applyCategoryEvidence` 永不抛）。

## 8. 前端（保留三栏 + 深色主题）

- 中栏自上而下：搜索/筛选条 → **一级分类栏**（横向紧凑 chip，带计数，可横向滚动，含「全部」与「未分类」）→
  **二级分类栏**（随所选一级动态变化，首项「全部X」；无子分类则不占位）→ 卡片网格。
- 一级切换：设置一级 → 清空失效的二级 → 重新拉计数与列表 → 保留不冲突的其它筛选。
- 分类管理入口放顶栏（与「查重/批量分类」同级）；管理页左树（一级 + 子）、右侧编辑（改名/排序/启用/移动/删除/合并 + 影响面提示）。
- 卡片：缩略图统一比例、标题截断 + 完整标题可见、标签最多 3 个其余 +N。
- 键盘可达：分类栏按钮可 Tab 聚焦、左右方向键切换、焦点环清晰。

## 9. 写权限边界（避免互相踩）

| 范围 | 归属 |
|---|---|
| `packages/core/src/categories/taxonomy.ts`、`apps/server/src/db/**`、本文件 | lead |
| `packages/core/src/categories/classify.ts`、`packages/core/test/**`、`test/**` | 子代理 A（分类器规则 + 测试） |
| `apps/server/src/http/routes.ts`、`apps/server/src/services/**`、`docs/api.md` | 子代理 B（服务端） |
| `apps/web/**` | 子代理 C（前端） |
