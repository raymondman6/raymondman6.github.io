# 2027 DSE 学习信箱

妹妹通过手机网页提问；dot 直接回写答案，并向哥哥本人 dot 对话同步原问题与完整回答。GitHub Pages 负责网页，私有共享存储负责问答记录，dot 负责实际 AI 工作。

## 当前交付状态（2026-10-18）

- 已准备：手机网页、后端业务逻辑、SQL schema、dot 接管说明与顾问规则。
- 网页预览具有明确演示标识，样例只在页面内存中，不会提交或模拟已经联网成功。
- `config.js` 保持 `ready:false`。后台生产部署、真实邀请访问、图片生产存储、dot 接管、自动检查和私人对话通知尚未完成。
- Sites 当前执行器缺少官方发布 helper，无法在此轮完成支持的发布流程。没有创建空 Site 或声称后台已上线。

## 页面

- 学习信箱：新问题、线程、追问、图片。
- 哥哥同步：保留每次妹妹原问题与 AI 完整回复，并显示私人通知是否已确认送达。
- 学生档案：2027 HKDSE 已确认，其余由真实资料补充。
- 邀请：通过哥哥管理入口生成学生专属访问链接。

生产网页地址计划：`https://raymondman6.github.io/dse2027/mailbox/`。

## 代码结构

- `index.html` / `config.js`：GitHub Pages 前端。
- `backend/worker.mjs`：Web Standards Worker，使用 DB(D1)、BUCKET(私有 R2)。
- `backend/migrations/0001_mailbox.sql`：首次迁移，在部署时执行；请求处理不会建表。
- `backend/.env.example`：环境键名，无真实秘密。
- `tests/`：真实 SQLite 适配的业务测试，R2 使用内存替身；不代表云端已验证。
- `docs/dot-handoff.md`：dot 接手部署、验证和监控的完整任务。
- `docs/advisor-rules.md`：学习与升学顾问规则。
- `docs/api.md`：接口及权限合同。

本地项目的前端位于 `frontend/`；同步到 GitHub 的本目录时，前端两文件放到本目录根部。

## 验证

使用 Node.js 22.13 或以上：`npm test`。25 项本地集成测试已通过，涵盖授权、共享读写、追问、完整问答同步、通知确认、并发重试和事务回滚。测试只使用明确的合成题目和一次性访问凭据；云端 D1/R2 与 dot 实际投递仍待部署后联调。

## 上线需要完成

1. 使用可用、受支持的托管流程部署 Worker、私有数据库与图片存储，迁移后端数据表。
2. 在托管平台配置秘密与精确的 GitHub 网页来源，选择符合妹妹实际访问条件的登录／邀请方式。保持问答数据私有。
3. 填入真实 `apiBase` 与 `ownerUrl`，完成两端读写验证后再启用 `ready:true`。
4. dot 完成受支持连接，验证读取、回写及向哥哥本人对话投递，然后保存定时任务。默认每小时检查一次，香港时间。

后台可提供 `/mcp`，但完整 OAuth／插件安装由支持的宿主负责；代码没有假设匿名网页可以读写私人记录。没有内嵌任何 OpenAI API key，也没有网页自己生成 AI 答案的功能。

## 实现参考

- GitHub Pages：https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Cloudflare D1 的 prepare / batch 与事务：https://developers.cloudflare.com/d1/worker-api/d1-database/
- Cloudflare R2 Worker 接口：https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- dot 的任务与上下文：https://learn.chatgpt.com/docs/dots/tasks-and-memory
- Sites 外部访问说明：https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites
