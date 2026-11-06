# 静态 Web 部署

当前游戏是单机静态站，可由 Nginx 提供文件。发布包仅包含 Cocos Web 运行文件及校验表，不包含整个仓库。

已部署入口：[Slap Duel 公网试玩](https://aigateway.club/game/slap-duel/)。线上构建为 `P1-74b7d54-c36899a2-20261106T131115401Z`；公开源码整理随后调整了构建配置，不能将该既有产物声明为新源码重新构建。

完成 Web 构建和实际试玩后：

```powershell
node tools/test-web-release.mjs
node tools/package-web-release.mjs
```

工具生成 `game/local/releases/<BUILD_ID>.tar.gz`、独立 SHA-256 和打包回执。包内 `site/` 是唯一公开目录，外层 `release-manifest.json` 和 `SHA256SUMS` 用于部署核验。相同版本拒绝覆盖。上传后先核对归档校验值，再解入独立版本目录并运行 `sha256sum -c SHA256SUMS`。

本项目的目标路由为 `/game/slap-duel/`。入口必须补尾斜杠，Cocos 相对资源才能保持在此路径。以下片段放在已选定的 Nginx `server` 中，绝对目录按部署环境填写：

```nginx
location = /game/slap-duel {
    return 301 /game/slap-duel/;
}
location ^~ /game/slap-duel/ {
    alias /srv/slap-duel/current/site/;
    index index.html;
    add_header Cache-Control "no-cache";
    add_header X-Content-Type-Options "nosniff";
}
```

先检查现有站点、上游与证书，备份将修改的配置，只增加本路由。用 `nginx -t` 验证后平滑 reload。`current` 指向已校验的版本目录；保留上一版本以便回退。不要将发布包外层、源码或管理记录设为站点根。

上线验收包括：尾斜杠跳转、首页及资源 MIME、构建身份、当前版本资源的内容校验、真实浏览器进入练习并出掌，以及原服务入口回归。实际服务器地址和账户不写入公开仓库。生产环境实际部署状态以执行时的验证为准。

## 现有防护规则兼容

如果现有配置在 `server` 层拦截包含 `config.json` 的请求，游戏的 `^~` location 无法跳过该检查。本次对现有可疑路径 `map` 仅添加两个确切的公开资源例外：

```nginx
/game/slap-duel/assets/main/config.json 0;
/game/slap-duel/assets/internal/config.json 0;
```

不应放行整个 `/game/` 前缀。实际部署路由使用308跳转并保留查询参数，静态文件禁止目录浏览、仅允许GET/HEAD，响应附加 `no-store` 和 `nosniff`。现有容器未重启，通过配置检查后只执行平滑reload。

## 本次上线结果

- 33个公开资源全部HTTP200，大小、SHA-256与MIME匹配发布清单；两个Cocos配置资源均正常加载。
- 缺失资源404、POST403；私人路径、发布包外层及源码映射未公开。
- 实际公网浏览器进入命中练习：点击后生命5→4、显示“命中 -1”；蓄力约1.8秒后5→3、显示“重击命中 -2”。
- 抽查的原有六个服务入口状态、字节数与内容校验值均与部署前一致。配置备份、主机路径及完整运维记录保留在私人交付记录中。

公网部署不替代手机测试、用户采用或后续真人联机验收。
