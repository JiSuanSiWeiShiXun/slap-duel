# 开发与构建

引擎固定为 Cocos Creator 3.8.8，逻辑测试使用引擎附带的 TypeScript 4.9.5。Node.js 22 已用于本项目开发。无需安装额外 npm 运行依赖。

## 工具路径

默认安装路径只是便利值；安装位置不同时设置：

```powershell
$env:COCOS_INSTALL = '<Creator 3.8.8 安装目录>'
$env:COCOS_ENGINE = Join-Path $env:COCOS_INSTALL 'resources/resources/3d/engine'
$env:COCOS_TSC = Join-Path $env:COCOS_ENGINE 'node_modules/typescript/bin/tsc'
```

`npm test` 和 `npm run typecheck` 使用 `COCOS_TSC`；真实 Cocos 类型检查使用 `COCOS_ENGINE`。构建包装器的 `-Creator` 参数指定 Creator 可执行文件。PowerShell 脚本用于 Windows，本地静态服务和逻辑测试为 Node.js 工具。

## 验证

```powershell
node tools/bootstrap-game.mjs --check
npm test
npm run typecheck
node tools/check-game.mjs --typecheck
node tools/test-build-config.mjs
node tools/test-tooling.mjs
node tools/check-public-tree.mjs
```

规则测试覆盖同时命中、去重、蓄力阈值、防御窗口、冷却、受击打断、会话暂停、重开和机器人限制。自动测试不替代实际设备体验。

## 构建与来源标识

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-game.ps1 -Target web-desktop -Creator '<CocosCreator.exe 路径>'
node tools/check-game.mjs --target web-desktop
node tools/serve.mjs --port 7456
```

公开构建模板使用 `project://build`；包装器将实际路径写入被忽略的 `game/local/build-config/`，再交给 Creator。构建前记录源码指纹，构建后核验可执行代码中的构建标识并生成 `build-manifest.json`。源码改变后必须重建。Creator 的成功退出码 36 由包装器归一为 0。

## 微信小游戏

公开模板不包含真实 AppID。设置开发者自己的身份：

```powershell
$env:WECHAT_APP_ID = '<你的小游戏 AppID>'
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-game.ps1 -Target wechatgame -Creator '<CocosCreator.exe 路径>'
powershell -NoProfile -ExecutionPolicy Bypass -File tools/open-wechat.ps1 -Cli '<微信开发者工具 cli.bat 路径>'
```

也可在被忽略的 `game/local/wechat-config.json` 中设置 `appid`。只需要 AppID，不需要 AppSecret。切换身份后重新构建；启动工具会拒绝配置和产物身份不一致的项目。

## 资源

保留 Cocos `.meta` 文件及 UUID。当前角色和动作由代码生成，正式资源生产链尚未完成。`game/settings/` 只保存可公开项目设置，账号信息、编辑器缓存和预览包留在本地。
