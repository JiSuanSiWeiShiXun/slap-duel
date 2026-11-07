# 静态 Web 部署

当前游戏是单机静态站，可由 Nginx 提供文件。发布包仅包含 Cocos Web 运行文件及校验表，不包含整个仓库。

已部署入口：[Slap Duel 公网试玩](https://aigateway.club/game/slap-duel/)。线上为三职场角色候选 `P1-ea94213-55960c02-20261107T144236754Z`，Web构建时间为2026-11-07T15:13:25.781Z，输入修订c982f16。此ID由相同输入复用，实际产物归属同时核对目标、源码摘要和构建时间。

完成 Web 构建和实际试玩后：

```powershell
node tools/test-web-release.mjs
node tools/package-web-release.mjs
```

工具生成 `game/local/releases/<BUILD_ID>.tar.gz`、独立 SHA-256 和打包回执。包内 `site/` 是唯一公开目录，外层 `release-manifest.json` 和 `SHA256SUMS` 用于部署核验。相同版本拒绝覆盖。上传后先核对归档校验值，再解入独立版本目录并运行 `sha256sum -c SHA256SUMS`。

本项目的目标路由为 `/game/slap-duel/`。入口必须补尾斜杠，Cocos 相对资源才能保持在此路径。以下片段放在已选定的 Nginx `server` 中，绝对目录按部署环境填写：

```nginx
location = /game/slap-duel {
    return 308 /game/slap-duel/$is_args$args;
}
location ^~ /game/slap-duel/ {
    alias /srv/slap-duel/current/site/;
    index index.html;
    autoindex off;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options "nosniff";
    limit_except GET { deny all; }
}
```

先检查现有站点、上游与证书，备份将修改的配置，只增加本路由。用 `nginx -t` 验证后平滑 reload。`current` 指向已校验的版本目录；保留上一版本以便回退。不要将发布包外层、源码或管理记录设为站点根。

更新已存在的站点时，记录旧 `current` 目标和配置哈希，先验包到全新版本目录，再通过同目录临时软链接与原子替换切换 `current`。配置若以单文件绑定进容器，须原位写入并保留 inode。失败时按保存的旧目标与配置快照回退；检测到其他配置改动时停止覆盖。首次部署脚本的“入口不存在”前提不适用于更新。

上线验收包括：尾斜杠跳转、首页及资源 MIME、构建身份、当前版本资源的内容校验、真实浏览器进入练习并出掌，以及原服务入口回归。实际服务器地址和账户不写入公开仓库。生产环境实际部署状态以执行时的验证为准。

## 现有防护规则兼容

如果现有配置在 `server` 层拦截包含 `config.json` 的请求，游戏的 `^~` location 无法跳过该检查。当前运行需要三个确切的公开资源例外；本次更新仅在已有两条后补充resources这一条：

```nginx
/game/slap-duel/assets/main/config.json 0;
/game/slap-duel/assets/internal/config.json 0;
/game/slap-duel/assets/resources/config.json 0;
```

不应放行整个 `/game/` 前缀。实际部署路由使用308跳转并保留查询参数，静态文件禁止目录浏览、仅允许GET/HEAD，响应附加 `no-store` 和 `nosniff`。现有容器未重启，通过配置检查后只执行平滑reload。

## 本次上线结果

- 91个公开资源全部HTTP200，大小、SHA-256与MIME匹配发布清单；三个Cocos配置资源正常加载。
- 5项入口/方法检查与14项私人路径、发布包外层及源码映射检查通过。
- 实际公网浏览器看见三角色立绘，老同事、新人及对手中层的真实形象参战。命中练习中，短掌使生命5→4，满蓄力使4→2；点击模式短掌同样为1点，换角正常。
- 六个原有服务入口与本次切换前新采集的响应基线匹配。旧版本、配置快照和运维回执保留；Nginx通过检查后平滑reload，容器未重启。

公网部署不替代手机测试、用户采用或后续真人联机验收。
