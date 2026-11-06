# 云端账号与同步（Supabase）

> 目标：手机和电脑用同一个账号，书库、阅读进度、笔记划线、查词记录自动对齐。
> 不配置也能正常用，只是不能跨设备。

---

## 0. 先选后端：官方还是阿里云

| | 官方 Supabase | 阿里云 Supabase 兼容版 |
|---|---|---|
| 地址 | `https://xxx.supabase.co` | `https://xxx.supabase.opentrust.net` |
| 机房 | AWS 新加坡 / 东京 | 杭州 |
| 国内实测延迟 | 200–500 ms，弱网经常超时 | 几十毫秒 |
| 免费额度 | 500 MB 库，**7 天不用会暂停项目** | 1C2G / 1 GB 存储 |
| 申请入口 | supabase.com | 阿里云控制台 → 云原生数据仓库 AnalyticDB PostgreSQL 版 → Supabase |

**建议用阿里云那版。** 代码里地址是可配的，两边 API 完全一致，随时可换（换了地址会自动要求重新登录）。

---

## 1. 建项目

官方：注册 → New project → 记下 **Project URL** 和 **anon public key**。
阿里云：控制台 → AnalyticDB PostgreSQL 版 → Supabase → 创建项目 → 选「免费测试创建」→ 规格 1核2GB → 建好后点「登录 Dashboard」，在里面拿 URL 和 anon key。

> 只抄 **anon / public** key。`service_role` key 会绕过所有权限校验，绝不能填进 App，也不能提交进仓库。

## 2. 建表

Dashboard → **SQL Editor** → 新建查询 → 粘贴 [`supabase_schema.sql`](./supabase_schema.sql) 全文 → Run。

跑完最后会打印两行自检结果：`rls_enabled = true`，以及 4 条 policy。少了就是这个脚本没执行完。

这一步做的事：

- 建一张 `yidu_records` 表，主键 `(user_id, kind, key)`，内容放 `jsonb`
- 开 RLS + 4 条策略（只能读写自己的行）
- 建触发器，每次 update 自动刷 `updated_at`（不信任设备时钟）

## 3. 关掉邮箱验证（强烈建议）

Authentication → Sign In / Providers → Email → 关掉 **Confirm email**。

不关的话注册后要收验证邮件才能登录，而免费项目的邮件服务经常延迟甚至发不出去，体验很差。

## 4. 在 App 里填地址

设置 → **账号与同步** → 填「项目地址」和「anon key」→ 保存并启用同步。

- 桌面版等价于直接改 `config.ini` 的 `[cloud]` 段，两种都行
- 安卓版**只能**在界面里填：`config.ini` 在应用私有目录，普通用户摸不到
- 地址会写回 config.ini，重启后仍然有效

## 5. 注册 / 登录 / 同步

1. 填邮箱 + 密码 → 点「注册新账号」
2. 登录成功后自动同步一次
3. 另一台设备同样的地址和密钥 → 登录 → 自动把书库、进度、笔记、查词拉下来

「立即同步」可以手动触发。同步是增量的，正常情况一两秒完成。

---

## 同步了什么，没同步什么

| 数据 | 同步 | 说明 |
|---|---|---|
| 书库信息（书名 / 作者 / 章数 / 语种） | ✅ | epub 文件本身不传，另一台设备需要自己导入一次 |
| 阅读进度（第几章） | ✅ | 换设备打开同一本书直接回到那一章 |
| 笔记 / 书签 / 划线 | ✅ | 按内容生成稳定 uid，两台设备不会重复 |
| 查词记录 | ✅ | 单词 + 在哪本书哪一章查的 |
| 字号 / 显示语言 | ✅ | |
| 主题（深色 / 浅色） | ❌ | 存在本机 config.ini，故意的：手机夜里深色、电脑白天浅色更合理 |
| 翻译缓存（segments） | ❌ | 体积大，一本书几百到几千条；需要的话另做按需同步 |
| 阅读时长统计 | ✅ | 按设备分别记账（`read_time_dev` 表），合并时同一设备取较大值、总分取各设备之和 |

## 冲突怎么处理

不看设备时钟（手机时间不准就会打架），只看**内容指纹**：

- 本地内容和"上次同步时的内容"不一致 → 认定本地改过 → 以本地为准推上去
- 一致 → 接受云端版本

所以两边同时改同一条时，本地会赢，云端那次改动丢失。日常使用（一台设备读、另一台偶尔看）几乎碰不到。

删除是软删除：云端留一条 `deleted=true` 的记录，另一台设备拉到后本地也删，不会"删了又复活"。

---

## 常见报错对照

| 提示 | 原因 | 怎么办 |
|---|---|---|
| 云端还没有建表 | 第 2 步没做 | 跑一遍 `supabase_schema.sql` |
| 云端权限被拒 / HTTP 403 | RLS 策略没建全 | 同上，重跑脚本 |
| 连不上云端（timed out） | 用的是官方新加坡节点，国内网络不通 | 换阿里云杭州实例，或换网络 |
| 邮箱或密码不正确 | 密码错，或账号还没注册 | 先点「注册新账号」 |
| 邮箱还没验证 | Confirm email 没关 | 第 3 步 |
| 登录已失效 | refresh token 过期（长期不用） | 重新登录 |

---

## 技术实现（给以后维护的人 / AI）

```
前端 app.js  ──►  本地 Flask (127.0.0.1)  ──►  Supabase REST/Auth
                    source/cloud.py
```

- **不让前端直连 Supabase**：WebView 的 origin 是 `http://127.0.0.1:<端口>`，端口一变 origin 就变、localStorage 全丢（见 HANDOFF 的端口漂移问题）；令牌放后端就与 origin 无关，anon key 也不会落到网页里。
- **不用 `supabase-py`**：它依赖 pydantic v2（Rust 原生扩展），Chaquopy 打不进 APK。`cloud.py` 只用标准库 `urllib` 直连 REST，零新增依赖，APK 体积不变。
- **本地指纹表 `sync_meta`**：存"每条记录上次同步成功时的内容 sha1"。同步时比对指纹就知道哪些要传，不需要给 6 张业务表都加 `updated_at` 列。
- **删除墓碑 `sync_tombstone`**：本地删了就真删了，没有墓碑下次同步会从云端拉回来。
- **`ON CONFLICT` 不能用**：minSdk 24 对应 Android 7 的 SQLite 3.9，不支持 upsert 语法，`state_manager._upsert()` 用 UPDATE→INSERT 两步实现。
- **时间**：水位只和云端时间比，绝不拿本机时钟比云端时钟。

新增一种同步数据只要三步：`sync_source()` 里加一类 `kind`、`apply_remote()` 里加一个分支、`apply_remote_delete()` 里加一个分支。云端不用改表。
