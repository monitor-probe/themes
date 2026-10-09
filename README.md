# Monitor 主题

[Monitor](https://github.com/monitor-probe/monitor) 公开状态页的主题列表：**<https://monitor-themes.pages.dev>**

每个主题都能在线预览。看中了就复制它的安装地址，粘贴到 hub 面板「主题」页，点「从 GitHub 安装」（hub 1.3.2 起支持）。

预览页里的节点和数字都是生成的，不对应任何真实服务器。主题是在访客浏览器里运行的第三方代码，和 hub 同源，只装信得过的来源。

## 收录你的主题

按[主题开发文档](https://monitor-document.pages.dev/dev/theme)做好主题，发布 release，然后提一个 PR，在 `themes.txt` 末尾加一行仓库地址：

```text
https://github.com/<owner>/<repo>
```

只写这一行。名称、简介、作者、版本、截图都从你仓库最新正式 release 的 `theme.tar.gz` 里读取，不用在这里再写一遍。

### 要求

| 要求 | 原因 |
|---|---|
| 公开仓库，根目录有许可证文件（`LICENSE`） | 预览站要托管主题的构建产物 |
| 最新正式 release（不是预发布或草稿）里有名为 `theme.tar.gz` 的文件 | hub 的「从 GitHub 安装」和一键更新只认这个名字 |
| 这个包能装进最新版 hub | 和用户安装时走同一套检查 |
| `theme.json` 的 `url` 是这个仓库的地址 | 一键更新从 `url` 指向的仓库取新版 |
| `theme.json` 的 `version` 与 release 的 tag 一致（`v1.2.0` 对 `1.2.0`） | 不一致时，每次点更新都会重装一遍 |
| 包里有 `preview.png` | 列表页的截图 |
| `short` 不与已收录的主题重复，不是 `main` 或 `default`；转成小写、字母数字以外的字符换成 `-` 之后不超过 28 个字符，且不以 `-` 开头或结尾 | 预览地址是 `https://<转换后的 short>.monitor-themes.pages.dev` |

打包可以照抄默认主题的 [release.yml](https://github.com/monitor-probe/monitor-theme-default/blob/main/.github/workflows/release.yml)：推送 `v*` tag 时检查 tag 与 `version` 一致，构建后打包 `dist`、`theme.json`、`preview.png` 并发布 release。

### 检查

PR 的检查会下载你仓库最新正式 release 里的 `theme.tar.gz`，装进最新版 hub，再逐条核对上面的要求。没通过时检查失败，检查结果的 Summary 里列出全部原因，改好后发一个新 release，再点 PR 页面上的「Re-run」。

第一次向本仓库提 PR 的账号，检查要维护者批准后才会运行。

## 收录之后

- 网站每天更新一次，取各主题仓库的最新正式 release。发新版不用再来这里提 PR。
- 最新 release 没通过检查时，主题从网站下架，在线预览也一并删除；修好后发新 release，下次更新时自动恢复。
- 不想再被收录，提 PR 删掉 `themes.txt` 里的那一行。

## 在线预览

每个主题部署在自己的子域名下，路径和装在 hub 上时一样：`/assets/...`、客户端路由、刷新详情页都能用。

`/api` 由 `preview/hub.js` 里的一个假 hub 在浏览器里回答：它注入在每个页面的 `<head>` 最前面，接管页面里对 `/api` 的 `fetch`、`XMLHttpRequest` 和 WebSocket，不发网络请求，形状与 hub 1.3.2 的公开接口一致：

- `GET /api/me`、`/api/nodes`、`/api/nodes/{id}/metrics`、`/api/themes/{short}/config`、`/api/ws`，WebSocket 每 2 秒推送一次
- 30 个节点，包括离线、刚连上还没上报、分组、已过期和今天到期、多种货币与付款周期、公开备注、超长名字
- 未登录，主题设置为空，主题按自己的默认值显示；写操作一律拒绝，`/admin` 没有后台
- 在 Service Worker 或 Web Worker 里发出的 `/api` 请求接管不到，拿不到数据

包里的 `_worker.js`、`_routes.json`、`_redirects`、`_headers`、`404.html` 会在部署前删掉：它们在 Cloudflare Pages 上会被当作服务端代码或配置。

## 许可证

本仓库的代码以 [MIT](LICENSE) 许可发布。各主题的许可证见各自的仓库。
