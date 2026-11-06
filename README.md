# Slap Duel · 掌上对决

使用 Cocos Creator 3.8.8 和 TypeScript 制作的简约 3D timing 攻防小游戏。

当前版本是单机 MVP：机器人对战、两种出掌方式、普通格挡、精准反击、攻防练习、结算、暂停和重开。角色仍是原型造型；正式美术、音效及真人联机尚未完成。

**[公网试玩](https://aigateway.club/game/slap-duel/)**，支持浏览器直接打开。

## 玩法

- 点击出掌：点击后经过固定前摇命中，基础伤害 1。
- 蓄力出掌：按住后松手；满 1.2 秒伤害 2，未满伤害 1。
- 防御：较早按下是普通格挡，接近命中时按下可精准反击。防御次数和恢复受规则限制。
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
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-game.ps1 -Target web-desktop -Creator '<CocosCreator.exe 的完整路径>'
node tools/serve.mjs --port 7456
```

打开 <http://127.0.0.1:7456/>。微信构建需要开发者自己的 AppID，配置方法见开发说明。仓库不包含账号身份、AppSecret、预览二维码或构建产物。

## 结构与交付

- `game/assets/scripts/core/`：独立 TypeScript 战斗规则。
- `game/assets/scripts/session/`：本地会话和合法机器人。
- `game/assets/scripts/SlapGame.ts`：Cocos 场景、输入和表现。
- `tests/`：规则、输入、会话和反馈测试。
- `tools/`：构建、校验、静态试玩和发布包工具。

[架构与当前边界](docs/public/architecture.md) · [静态站部署](docs/public/deployment.md) · [公开仓库检查](docs/public/publication.md)
