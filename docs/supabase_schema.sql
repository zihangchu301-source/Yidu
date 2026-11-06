-- ============================================================
--  译读（Yidu）云端同步建表脚本
--  用法：Supabase 后台 → SQL Editor → 新建查询 → 全文粘贴 → Run
--  可以重复执行，不会报错、不会清数据。
-- ============================================================
--
--  设计说明（给以后维护的人 / AI）：
--    只建一张表 yidu_records。所有同步对象（书库、阅读进度、笔记划线、
--    查词记录、界面偏好）都用 (user_id, kind, key) 作主键，内容塞进 jsonb。
--
--    为什么不用多张表：同步逻辑只需要"按主键 upsert + 按时间递增拉取"，
--    多一张表就多一套 RLS、多一段代码。以后加新数据类型只改 kind，不用改表结构。
--    kind 取值：book / progress / annotation / dict / setting
-- ============================================================

-- ① 角色兜底：官方 Supabase 自带这两个角色，阿里云兼容版个别情况没有
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit;
  end if;
end $$;

-- ② 主表
create table if not exists public.yidu_records (
    user_id    uuid        not null,
    kind       text        not null,
    key        text        not null,
    payload    jsonb       not null default '{}'::jsonb,
    deleted    boolean     not null default false,
    updated_at timestamptz not null default now(),
    primary key (user_id, kind, key)
);

-- 说明：这里**故意不加** references auth.users(id)。
-- 官方 Supabase 可以加，但阿里云 AnalyticDB 版的 auth 表结构不完全一致，
-- 加了外键会建表失败。用户已删除时 auth 侧会自己清理，不影响使用。

-- ③ 增量拉取靠这个索引（按 user 分组、按时间排序）
create index if not exists yidu_records_user_updated_idx
    on public.yidu_records (user_id, updated_at desc);

-- ④ 授权：登录用户才能通过 Data API 访问
grant select, insert, update, delete on public.yidu_records to authenticated;

-- ⑤ 行级安全：每个人只能碰自己的数据（这是真正的权限边界，绕不过去）
alter table public.yidu_records enable row level security;

drop policy if exists "yidu read own"   on public.yidu_records;
drop policy if exists "yidu write own"  on public.yidu_records;
drop policy if exists "yidu update own" on public.yidu_records;
drop policy if exists "yidu delete own" on public.yidu_records;

create policy "yidu read own"
    on public.yidu_records for select
    to authenticated
    using ((select auth.uid()) = user_id);

-- with check 是关键：没有它，登录用户可以把 user_id 伪造成别人，往别人库里写数据
create policy "yidu write own"
    on public.yidu_records for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

create policy "yidu update own"
    on public.yidu_records for update
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

create policy "yidu delete own"
    on public.yidu_records for delete
    to authenticated
    using ((select auth.uid()) = user_id);

-- ⑥ 每次 update 自动刷新 updated_at，客户端不用自己传时间（避免设备时钟不准）
create or replace function public.yidu_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists yidu_touch_updated_at on public.yidu_records;
create trigger yidu_touch_updated_at
    before update on public.yidu_records
    for each row execute function public.yidu_touch_updated_at();

-- ⑦ 自检：跑完看一下这两行，确保 policy 有 4 条、rowsecurity 是 true
select relrowsecurity as rls_enabled from pg_class where relname = 'yidu_records';
select policyname, cmd from pg_policies where tablename = 'yidu_records';
