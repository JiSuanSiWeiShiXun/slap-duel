# 原创职场角色与可重建资源

三名虚构成人角色 `manager`、`veteran`、`rookie` 使用项目原创参数网格、材质、29 骨 Armature、归一化蒙皮和性格动作。没有第三方模型、贴图、肖像或外部绑定服务。来源声明与授权文字逐角色保存在 `manifest.json` 的 `source.provenance`，当前为 `Project original assets; editable generation source included`；这份说明不另行授予不同许可。

公开制作源为 `tools/create-office-cast.py` 和 `game/assets/resources/office-cast/<role>/manifest.json` 的 `source`。本地可编辑原生源位于 `game/local/character-source/<role>.blend`，不进入公开树。FBX 和透明立绘位于对应角色目录，立绘直接渲染同一模型、材质、骨架的介绍姿势。原生源、工具回执、概念与运行证据保持私有。

## 固定制作合同

- Blender **4.5.14 LTS**，官方 Windows x64 portable；沿用项目内已核验的安装与 SHA256 回执，不复制或下载另一套工具。
- Cocos Creator **3.8.8**，使用已安装的 FBX converter 和真实编辑器导入。
- 生成器 SHA256：`abd8f3d38e0735c59e427cae2bca1c3436cb72aa1415e07f4b3a55407630711e`。检查器拒绝生成器字节变更。
- `sourceHash = SHA256(完整生成器字节 + UTF-8规范化source JSON)`；递归排序键、无空格、不转义中文。`generated` 不参与哈希。
- FBX binary 7400；60 FPS；forward `-Z`、up `Y`、scale 1；不加 leaf bones、不导出所有 actions/NLA、不使用 bake-space-transform、不嵌入外部媒体。
- 每人独立网格、权重、逆绑定和 Skeleton；语义骨名相同不代表可以共享 bind pose。每顶点最多四个有效权重，权重和误差小于 `0.00001`。
- 每人同源 512×512 RGBA8 透明 PNG。公开扫描只允许固定 PNG chunks，检查 CRC、解压预算与私密字符串；FBX 同时扫描原始字符串和受限解压数组。未查看的新立绘不得把 `portraitReviewed` 改为 true。

## 角色与稳定引用

| role | sourceHash | 模型 UUID | 立绘 texture UUID |
|---|---|---|---|
| manager | `b15f0eb6c5e925308dbaf3c3e2385cb17823adaadcfae367691a55a0d1887b8e` | `8af9517d-1571-47c9-b22f-6fb91a0afca4` | `fc0ad401-c0db-4fa3-aff6-bbdb55133752@6c48a` |
| veteran | `a45a72b8037f85fd3008ef692c2acbd3dd9067354136e9ab6e1ce12bb2275359` | `eb906a0a-3d3c-4ab4-a760-b56686894636` | `8ed28d51-44fa-402f-b718-2d2944653f36@6c48a` |
| rookie | `a4eab106bfec150cc87c92666241b98467505a3de1246d72bc76ee69d32fea1b` | `021449a0-b54e-4700-8e40-2f6e856d27ed` | `ec04eed2-d7ad-4aa3-9305-0744f28c9df2@6c48a` |

每个 FBX 的 prefab 子 UUID 为模型 UUID 加 `@9d5eb`，Skeleton 为模型 UUID 加 `@438fe`。13 个实际 clip UUID、全部骨路径、输出大小与 SHA256 以该角色 `generated.imports/outputs` 为准；检查器逐项比对真实 `.meta` 和导入后的 library。保留现有 `.meta`，不能自行编造新子资产 UUID。

## 动作时间线

| clip | 源时间秒 from→to |
|---|---|
| idle | 0→2 |
| intro-positive | 2.0333333333→3.0333333333 |
| intro-negative | 3.0666666667→4.0666666667 |
| charge | 4.1→5.3 |
| attack-light | 5.3333333333→6.3333333333 |
| attack-heavy | 6.3666666667→7.3666666667 |
| recovery | 7.4→8.4 |
| guard | 8.4333333333→9.4333333333 |
| hit | 9.4666666667→9.9666666667 |
| counter | 10→11 |
| counter-recovery | 11.0333333333→12.0333333333 |
| victory | 12.0666666667→13.5666666667 |
| defeat | 13.6→15.1 |

所有 split/import sample 为 60。源 clip 采样映射到独立规则时间；普通掌伤害 1、1200ms 满掌伤害 2、精准格挡伤害 0、180ms 后另一手反击伤害 1、再恢复 260ms。动画回调不改变 HP。

`CharacterView` 在首次激活前设 `useBakedAnimation=false`，update 采样、引擎应用后 lateUpdate 对齐真实 deform 骨。两侧都使用正缩放和外层旋转。`lead` 对左演员映射 `Hand.L`、对右演员映射 `Hand.R`，`rear` 相反；掌心与脸颊由当前骨 worldMatrix 取点，再经 `characterContacts` / two-bone IK 对齐。因此双侧锚点来自各自真实皮肤，不能把同骨名当作同一绑定。

## 检查与干净重建

在仓库根目录执行：

```text
node --test tests/character-assets.test.cjs
node tools/check-character-assets.mjs --check
node tools/check-character-assets.mjs --rebuild
node tools/check-public-tree.mjs
```

`--check` 验证三角色原创源/hash、FBX/PNG 签名与输出 hash、完整 clip 区间、全部真实 meta UUID；再用冻结原脚本重转换 FBX 验证 JOINTS/WEIGHTS/逆绑定，读取真实 Creator Skeleton、SkinnedMeshRenderer 和 clip 数据。它会更新被忽略的 converter 诊断；它的通过结论是文件与导入身份，实际画面和体验另行验证。

`--rebuild` 在 `game/local/asset-rebuild/` 创建一个新的唯一目录，也支持 `--name UNIQUE_NAME`。已有目标拒绝覆盖，不能传任意 source/output/tool 路径。复制来自公开跟踪文件的明确白名单：源码、源参数、meta、构建模板与配置、必要工具/测试/公开说明；不复制 FBX/PNG 成品、凭据、账号配置、规划、portable、library/temp/build/profiles 或私人文件。源路径和目标路径中的 symlink/junction 均拒绝。

随后只调用**原项目冻结脚本**的受控 `--source-root/--output-root` 模式重生三人 FBX、同源 PNG 与副本 blend；不执行副本生成器。全新缓存导入由副本的真实 `build-game.ps1 -Target web-desktop` 完成。初导造成输入指纹变化时，保留失败回执、同步真实 import/meta，再稳定构建；不跳过指纹保护。

每个副本保留 `rebuild-report.json`：公开输入逐文件 hash、生成器退出码、复制前无旧缓存事实、每次 Creator 构建日志、稳定 build manifest、三人独立 bindPose 与引用检查。`runtimePassed` 初始为 false；生成、导入和构建成功不会自动把实际运行写成通过。按返回副本路径使用其 `tools/serve.mjs --port 7457` 提供本地 Web，实际选择三人并观察代表轻击、普通格挡和两段反击，再保存运行证据。

造型修改应在 manifest.source 支持的合法参数内进行，并依次完成生成、Creator 导入、Web 构建、立绘与皮肤直接查看。恢复源值之后同样真实重建和查看。临时 sourceHash 与固定 FK fixture 不一致是预期保护，不能永久放宽断言。最终参数、meta UUID、文件检查与公开扫描必须恢复有效。

## 已执行的干净重建

2026-11-07 使用 `node tools/check-character-assets.mjs --rebuild --name phase2-09-clean-final-20261107` 实际重生三人。副本复制 89 个白名单输入，复制前 library/temp/build/local/profiles 均不存在；三次生成退出码 0，首次真实 Creator 导入与 Web 构建退出码 36，wrapper 成功。稳定构建为 `P1-b25a9a0-d4789a78-20261107T143053867Z`；新产物严格二进制政策及复制前后完整 import 身份比较通过。

390×844 桌面原生输入实际选择三人进入介绍与对战，每人实际 renderer=1、joints=29；manager 蓄力模式短掌伤害 1，veteran 点击模式普通格挡伤害 0，rookie 精准格挡在 1680ms 伤害 0、1860ms 反掌伤害 1。原始立绘及连续反击画面已直接查看。首次 rookie 防御按早了，正确得到普通格挡，仅重试进入精准窗口的案例计作反击通过。运行证据与回执保持在本地私有目录。

## 验证边界

公开源与完整性检查不代表微信新角色运行、手机安全区、性能、真实 TOUCH_CANCEL、本人视觉或手感采用通过；这些结论按具体构建和设备另验。单机资源在联机中的复用也须后续两端实际验证。
