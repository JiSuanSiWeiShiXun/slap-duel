# 静态 Web 部署

当前游戏是单机静态站，可由 Nginx 提供文件。发布包仅包含 Cocos Web 运行文件及校验表，不包含整个仓库。

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
