# 订阅账单分析与更正平台 (Subscription Billing & Correction)

零依赖（仅用 Node.js 24 内置模块：`node:sqlite` / `node:http` / `node:test`）实现的订阅计费系统，覆盖**升级降级、按日计费、暂停恢复、退款、时区边界、不可变账单更正、幂等回调、失败恢复与审计**。

## 快速开始

```bash
npm run seed     # 生成演示数据（跨月锚点、DST 时区、回溯更正、暂停、退款、回调重放）
npm start        # http://localhost:3000 （启动时自动恢复未完成更正）
npm test         # 45 个测试：金额/时区/引擎/生命周期/幂等/并发/HTTP/故障恢复
```

演示场景：
- **Acme Corp (America/New_York)**：锚点 1 月 31 日（跨月 clamp + 夏令时），2 月升级、3 月暂停/恢复、出账后收到**回溯生效**的回调，触发账单版本化与差异；
- **Kiwi Cloud (Pacific/Auckland, UTC+13)**：月末锚点、暂停顺延、取消后的尾段账单。

## 核心设计

### 1. 不可变账单 + 版本化更正（不能覆盖已出账记录）

- `invoice_records`：只追加的账单表，SQLite 触发器在 `issued/paid/voided` 后物理阻止 UPDATE/DELETE；
- `invoice_versions`：可变指针表，把「订阅 + 账期」指向当前版本；更正时**插入 v2/v3 新记录并移动指针**，旧记录金额原样保留；
- `invoice_diffs`：每次更正逐账期记录旧账单、新账单与带符号差额 `delta = new − old`；
- `corrections`：两阶段（reserve → apply），携带重算范围 `recalc_from → recalc_to`；
- `notifications`：事务内 outbox，每个新账单版本一条 `invoice_corrected`，幂等键唯一，独立投递并记录尝试次数。

### 2. 纯函数计费引擎（确定性、可重算）

`src/billing/engine.js` 只依赖不可变的订阅事件：

- **按日计费**：日费率 = 月费 ÷ 当月名义天数（28/29/30/31 自适应），整数分半入取整；
- **升级/降级**：按生效日把账期切成多段分别计价；
- **暂停/恢复**：暂停日 0 计费，账期边界顺延直到累计满名义活跃天数；
- **取消**：产出按活跃日计价的尾段账单；
- 同一组事件重算永远得到同一金额 —— 这是更正安全、可审计的基础。

### 3. 时区边界

- 时间戳一律 UTC 毫秒存储，账单日按订阅 IANA 时区的**本地日历日**解释（`Intl.DateTimeFormat` 求偏移，无需第三方库）；
- 本地午夜 ↔ UTC 双向转换；DST 23/25 小时天不影响日历日计数（有专门测试）；
- 月末锚点跨月 clamp（1/31 → 2/28，闰年 2/29）。

### 4. 幂等与并发

| 机制 | 保证 |
| --- | --- |
| `webhook_events.event_id` 主键 | 同一回调重放标记 `duplicate`，处理逻辑绝不执行第二次 |
| 事件/更正/退款/通知各自幂等键 | 即使外层状态未更新也不会重复生效 |
| 更正键 `corr:<sub>:<triggerEvent>` | 同一触发事件的任意次重投递只产生一次更正 |
| `BEGIN IMMEDIATE` + `busy_timeout` | 多连接写事务串行化（worker 线程实测无重复出账） |
| 订阅 `version` 乐观锁 | 陈旧的并发管理端变更返回 409 |

### 5. 失败恢复

- 更正分两个事务：reserve 落 `pending` 标记；apply 失败整体回滚（不会出现半截账单），标记转 `failed`；
- 服务启动与 `POST /api/corrections/recover` 都会重放 pending/failed 更正；
- `POST /api/test/inject-fault` 可在演示/测试中注入 apply 阶段异常。

## HTTP API（节选）

```
POST /api/subscriptions                         创建（支持 idempotencyKey）
POST /api/subscriptions/:id/events              plan_changed/paused/resumed/canceled（expectedVersion 乐观锁）
POST /api/billing/run                           出账任务（幂等，开放账期跳过）
POST /api/subscriptions/:id/corrections         按触发事件发起更正
GET  /api/corrections/:id                       更正详情 + 重算范围 + 逐期差异
GET  /api/invoices/:oldId/diff/:newId           行级账单差异
POST /api/subscriptions/:id/refunds             退款（独立信用记录，不超余额，幂等）
POST /api/webhooks                              回调入口（event_id 幂等）
POST /api/notifications/deliver                 通知投递（失败重试计数）
GET  /api/subscriptions/:id/timeline            事件/账单/更正/退款合并时间线
GET  /api/subscriptions/:id/analysis            引擎重算 vs 已出账对照（偏差检测）
GET  /api/audit                                 审计日志（before/after JSON）
```

## 页面（http://localhost:3000）

七个标签页：**订阅时间线、账单分析/重算范围、账单与版本差异、更正记录、回调模拟器（可一键重放验证幂等）、通知状态、审计日志**；侧栏可直接发起升级/降级、暂停/恢复、取消、退款与故障注入。

## 测试矩阵

```
test/01-money.test.js               整数分取整、分配守恒
test/02-time.test.js                DST 春令/秋令、UTC+13、跨月 clamp、日历日计数
test/03-engine.test.js              升降级分段、暂停顺延、跨月、取消尾段、同日事件
test/04-billing-lifecycle.test.js   不可变触发器、版本链 v1→v2→v3、差异对账、退款上限、故障恢复
test/05-webhooks-concurrency.test.js 回调重放幂等、乐观锁冲突、状态机非法转换
test/06-http-api.test.js            全链路 HTTP、错误码、静态资源、通知重试
test/07-concurrency-workers.test.js 多连接真实锁竞争（worker 线程 + 共享文件库）
```

## 数据模型

```
plans ──< subscriptions ──< subscription_events (不可变事件流)
                    │                │
                    ├─< invoice_records (触发器冻结) ─< invoice_lines
                    │        ▲ invoice_versions 指针
                    ├─< corrections ──< invoice_diffs ── 关联新旧 invoice_records
                    ├─< refunds (独立信用)
                    ├─< notifications (outbox)
                    └─< audit_log (append-only)
webhook_events (event_id 去重)
```
