# 接口合同

所有 `/api/` 数据请求需要身份或 `Authorization: Bearer …`；`/api/health` 仅返回通用状态。GitHub 前端凭邀请获得仅此家庭信箱的学生访问权限，后台仅存邀请的 SHA-256 摘要。OWNER_API_KEY 与 AGENT_API_KEY 仅在私有托管密钥管理或受支持的代理连接中使用。

| 方法和路径 | 用途 |
|---|---|
| GET /api/bootstrap | 身份、线程列表、顾问真实检查状态、档案 |
| POST /api/threads | 新问题：title/category/body/attachment_ids/idempotency_key |
| GET /api/threads/:id | 问题和完整消息列表 |
| POST /api/threads/:id/messages | 追问：body/attachment_ids/idempotency_key |
| POST /api/attachments | multipart 的 file，最多 5 MB；留言最多三张 |
| GET /api/attachments/:id | 经授权读取图片；前端 fetch 后创建 Blob URL |
| GET /api/profile | 读取已确认档案 |
| PUT /api/profile | 哥哥管理档案；保留历史版本 |
| POST /api/invitations | 哥哥建立学生邀请，role=student；只返回一次原始链接 |
| DELETE /api/invitations/:id | 哥哥撤销指定邀请 |
| GET /api/sync | 哥哥查看完整问题／回答的同步记录 |
| GET /api/agent/pending | dot 读取待回答问题及前文 |
| POST /api/agent/replies | thread_id/through_message_id/body/status；原子回写和建立 outbox |
| GET /api/agent/sync | dot 读取未确认送达哥哥的记录 |
| POST /api/agent/sync/ack | sync_id/delivery_reference；实际送达之后调用 |
| POST /api/agent/heartbeat | 记录实际检查时间，不建立定时任务 |
| PUT /api/agent/config | 哥哥登记已实际建立的任务 ID 与频率 |
| POST /mcp | 初始化、工具发现和受授权工具调用 |

状态为 `pending`、`needs_info`、`replied`；新真人消息会使线程重新 pending。AI 回答必须对应当前最后一条真人消息 ID；过时的读写返回 409。重复问题提交复用客户端同一个 idempotency_key；重复 AI 回写复用 thread_id + through_message_id。

同步记录包括 `question_text`、带附件信息的 `question_messages`、`answer_text` 和 `thread_url`。原帖链接以配置的 `FRONTEND_URL` 加上 `?thread=…` 构成，不包含访问凭据；打开时仍须具备信箱访问权限。

问题和回复以纯文本存储，前端安全渲染。邀请秘密不放查询参数或公开文件；前端从 URL fragment 取出后清除地址栏 fragment。GitHub 网页和后台跨域时，配置精确允许来源，并以 Bearer 访问数据；不能期待跨站共享 ChatGPT 登录 Cookie。

仅在 Sites dispatch 后开启 TRUST_SITES_IDENTITY。普通 Cloudflare Worker 不能信任客户端自行填写的 oai-authenticated-user-* 请求头。MCP 部署成功不等于 dot 已安装连接；工具连接与任务投递需要各自实际验证。
