# Slap Duel · 掌上对决

使用 Cocos Creator 3.8.8 和 TypeScript 制作的简约 3D timing 攻防小游戏。

当前版本是单机候选：可选职场中层、经验老同事和新人，局前显示自己的长处与对手的负面行为，实际对战使用所选角色。包含机器人对战、两种出掌方式、普通格挡、精准反击、攻防练习、结算、暂停和重开。后续将继续打磨音效与操作手感，再接入真人联机。

人物美术正在返工：本轮先将职场中层替换为完整人形与西装实模，其余两人仍为旧版，待首样确认后扩展。v2 资产采用有来源记录的 CC0 基础及项目定制，首样已接入实际 Cocos Web 选角与对战；生成入口为 `python tools/create-office-human.py --role manager`，前置资源、许可和导入步骤见[角色制作说明](docs/public/assets.md)。人物质量采用、手机验证及新版完整干净重建仍待完成。

**[公网试玩](https://aigateway.club/game/slap-duel/)**，支持浏览器直接打开。

## 玩法

- 点击出掌：点击后经过固定前摇命中，基础伤害 1。
- 蓄力出掌：按住后松手；满 1.2 秒伤害 2，未满伤害 1。
- 防御：较早按下是普通格挡，接近命中时按下可精准反击。防御次数和恢复受规则限制。
- 精准反击：一手护脸接掌时不扣血，180毫秒后另一手反掌命中扣1；伤害由规则事件决定，骨骼动画消费结果。
- 双方初始生命 5，最长 60 秒，结束时按剩余生命决定结果。

两套攻击共用确定性规则和机器人，数值仍会根据试玩调整。

## 启动

需要 Node.js 22、Cocos Creator 3.8.8。用 Creator 打开 `game/`，完成资源导入。构建工具支持通过参数或环境变量指定安装位置，参见[开发说明](docs/public/development.md)。

```powershell
npm test
npm run typecheck
node tools/check-game.mjs --typecheck
node tools/test-build-config.mjs
node tools/test-tooling.mjs
node --test tools/test-wechat-package.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-game.ps1 -Target web-desktop -Creator '<CocosCreator.exe 的完整路径>'
node tools/serve.mjs --port 7456
```

打开 <http://127.0.0.1:7456/>。微信构建需要开发者自己的 AppID，配置方法见开发说明。仓库不包含账号身份、AppSecret、预览二维码或构建产物。

微信使用本地 `resources` 分包；配置由 `game/settings/v2/packages/builder.json` 的专用预设及 `resources.meta` 引用共同确定，Web 保持本地资源包。微信构建会检查分包声明、启动资源和主包原始字节预算，避免包体超限到生成预览时才暴露；静态检查通过仍需官方预览和实际设备验证。

## 角色制作服务配置

将根目录的 [.env.example](.env.example) 复制为 `.env`，填入自己的 `VIGGLE_API_KEY`。实际 `.env` 被 Git 忽略；这项配置仅由本地制作工具读取。

```powershell
# 已有 .env 时保留原配置。
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run workflow:preflight
npm run workflow:credits
```

`workflow:preflight` 离线检查凭据是否已配置；`workflow:credits` 只请求余额和验证认证，不生成素材。命令自动读取根目录 `.env`，已有进程环境变量优先；日志不输出密钥。服务生成、动捕和角色质量尚待实际验证。

## 结构与交付

- `game/assets/scripts/core/`：独立 TypeScript 战斗规则。
- `game/assets/scripts/session/`：本地会话和合法机器人。
- `game/assets/scripts/SlapGame.ts`：Cocos 场景、输入和表现。
- `game/assets/resources/office-cast/`：三角色参数、同源立绘、蒙皮模型与动作清单。
- `tests/`：规则、输入、会话和反馈测试。
- `tools/`：构建、校验、静态试玩和发布包工具。

[角色制作与重建管线](docs/public/assets.md) · [架构与当前边界](docs/public/architecture.md) · [静态站部署](docs/public/deployment.md) · [公开仓库检查](docs/public/publication.md)

[模型、绑定与双人动作的复用流程](docs/public/animation-pipeline.md) · [新角色接入模板](docs/public/animation-intake-template.md)：从模型标准姿到动捕重定向、成对接触与实际游戏衔接逐层验收，并区分每角色动作接入和角色组合回归。当前尚无任意新模型一键适配能力。
