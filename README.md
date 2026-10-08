# cf-nav

极简现代的个人导航站，运行在 Cloudflare Workers + KV 上：密码保护、搜索与标签筛选、链接状态检测、可视化后台（自动 ID、拖拽排序、标签管理）。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USER/YOUR_REPO)

## 一键部署

1. 点击上方按钮，授权 GitHub 并选择账号。
2. 在部署页填写 `PASSWORD`（访问密码，至少 6 位）。KV 命名空间会自动创建。
3. 部署完成后打开 Worker 地址，用刚才的密码登录，右上角 ⚙️ 进入后台添加链接。

> 点击按钮后 Cloudflare 会把仓库复制到你的 GitHub 账号下，并开启自动构建，之后推送代码即自动更新。

## 手动部署

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO && cd YOUR_REPO
npm install
npx wrangler kv namespace create LINKS_KV   # 把输出的 id 填进 wrangler.jsonc
npx wrangler secret put PASSWORD
npm run deploy
```

## 配置

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `PASSWORD` | Secret | 是 | 访问密码，至少 6 位；未设置时站点只显示配置提示页 |
| `LINKS_KV` | KV 绑定 | 是 | 保存链接数据 |
| `APEX_DOMAIN` | 变量 | 否 | 填裸域名（如 `example.com`），访问时 301 跳转到 `www` |
| `SITE_DOMAIN` | 变量 | 否 | 页面标题和页脚显示的域名，默认取请求域名 |

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填上 PASSWORD
npm install
npm run dev
```

## 安全说明

- 登录后下发 7 天有效的 HMAC 签名 Cookie（HttpOnly / Secure / SameSite=Strict）。
- 链接状态检测由 Worker 服务端发起请求，只会请求你自己保存的链接。
- 请使用足够强的密码；登录接口没有内置限速，建议在 Cloudflare 里为 `/login` 加一条速率限制规则。

## 许可证

MIT
