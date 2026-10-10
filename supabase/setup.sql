-- Oil Palm Seedling Reservation System — one-shot setup for a fresh Supabase project.
-- Paste into Dashboard → SQL Editor → Run. Equivalent to migrations 001 + 002 + 003 + 004.

create extension if not exists pgcrypto;

-- ---------- staff allow-list ----------
create table public.staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'editor' check (role in ('editor','viewer')),
  created_at timestamptz not null default now()
);

-- RLS helpers live outside the exposed API schema
create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = (select auth.uid()));
$$;

create or replace function private.is_editor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = (select auth.uid()) and role = 'editor');
$$;

revoke execute on function private.is_staff(), private.is_editor() from public, anon;
grant  execute on function private.is_staff(), private.is_editor() to authenticated;

-- ---------- data tables ----------
create table public.varieties (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(trim(name)) > 0),
  note       text not null default '',
  adjust     integer not null default 0,           -- manual correction added to net (ยอดปรับ)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ponds (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(trim(name)) > 0),
  lot        text check (lot in ('L1','L2')),
  capacity   integer not null default 0 check (capacity >= 0),
  variety_id uuid references public.varieties(id) on delete restrict,
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plantings (
  id         uuid primary key default gen_random_uuid(),
  lot        text not null check (lot ~ '^\d{4}-L[12]$'),   -- e.g. 2026-L2
  date       date not null,
  pond_id    uuid not null references public.ponds(id) on delete restrict,
  variety_id uuid not null references public.varieties(id) on delete restrict,
  qty        integer not null check (qty > 0),
  culled     integer not null default 0 check (culled >= 0 and culled <= qty),
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bookings (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text unique,                      -- BK{yy BE}{MMDD}-{0001}, issued on first print
  date             date not null,
  lot              text not null check (lot ~ '^\d{4}-L[12]$'),
  variety_id       uuid not null references public.varieties(id) on delete restrict,
  qty              integer not null check (qty > 0),
  customer         text not null check (length(trim(customer)) > 0),
  phone            text not null default '',
  pickup_date      date,
  note             text not null default '',
  status           text not null default 'reserved' check (status in ('reserved','confirmed','delivered','cancelled')),
  print_count      integer not null default 0,
  first_printed_at timestamptz,
  last_printed_at  timestamptz,
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index on public.ponds (variety_id);
create index on public.plantings (pond_id);
create index on public.plantings (variety_id, lot);
create index on public.bookings (variety_id, lot);
create index on public.bookings (date);
create index on public.bookings (created_by);

-- ---------- updated_at ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger trg_varieties_upd before update on public.varieties for each row execute function public.set_updated_at();
create trigger trg_ponds_upd     before update on public.ponds     for each row execute function public.set_updated_at();
create trigger trg_plantings_upd before update on public.plantings for each row execute function public.set_updated_at();
create trigger trg_bookings_upd  before update on public.bookings  for each row execute function public.set_updated_at();

-- ---------- overbooking guard (same rule as the app's checkAvail) ----------
-- available = min(Lot bucket net − Lot booked, variety net (incl. adjust) − variety booked)
create or replace function public.check_booking_capacity() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_bucket_net int; v_bucket_booked int; v_var_net int; v_var_booked int; v_avail int;
begin
  if new.status = 'cancelled' then return new; end if;
  -- status changes / edits that don't add demand skip the check
  if tg_op = 'UPDATE' and old.status <> 'cancelled' and new.qty <= old.qty
     and new.lot = old.lot and new.variety_id = old.variety_id then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('palm-booking:' || new.variety_id::text));

  select greatest(0, coalesce(sum(qty - culled), 0)) into v_bucket_net
    from public.plantings where lot = new.lot and variety_id = new.variety_id;
  select coalesce(sum(qty), 0) into v_bucket_booked
    from public.bookings where lot = new.lot and variety_id = new.variety_id and status <> 'cancelled' and id <> new.id;
  select greatest(0,
           coalesce((select sum(qty - culled) from public.plantings where variety_id = new.variety_id), 0)
         + coalesce((select adjust from public.varieties where id = new.variety_id), 0)) into v_var_net;
  select coalesce(sum(qty), 0) into v_var_booked
    from public.bookings where variety_id = new.variety_id and status <> 'cancelled' and id <> new.id;

  v_avail := least(v_bucket_net - v_bucket_booked, v_var_net - v_var_booked);
  if new.qty > v_avail then
    raise exception 'ยอดไม่พอ จองได้สูงสุด % ต้น', greatest(v_avail, 0) using errcode = 'P0001';
  end if;
  return new;
end $$;

revoke execute on function public.check_booking_capacity() from public, anon, authenticated;

create trigger trg_bookings_capacity before insert or update on public.bookings
  for each row execute function public.check_booking_capacity();

-- ---------- document number + print counter (run as the caller, so RLS applies) ----------
create or replace function public.assign_doc_no(p_booking_id uuid) returns text
language plpgsql security invoker set search_path = '' as $$
declare v_date date; v_doc text; v_prefix text; v_next int;
begin
  if not private.is_editor() then
    raise exception 'บัญชีนี้ไม่มีสิทธิ์ออกเลขที่ใบจอง' using errcode = '42501';
  end if;
  select date, doc_no into v_date, v_doc from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'ไม่พบรายการจอง' using errcode = 'P0002'; end if;
  if v_doc is not null then return v_doc; end if;

  v_prefix := 'BK' || right((extract(year from v_date)::int + 543)::text, 2) || to_char(v_date, 'MMDD') || '-';
  perform pg_advisory_xact_lock(hashtext('palm-docno:' || v_prefix));
  select coalesce(max(substring(doc_no from length(v_prefix) + 1)::int), 0) + 1 into v_next
    from public.bookings where doc_no like v_prefix || '%';
  v_doc := v_prefix || lpad(v_next::text, 4, '0');
  update public.bookings set doc_no = v_doc, first_printed_at = coalesce(first_printed_at, now())
    where id = p_booking_id;
  return v_doc;
end $$;

create or replace function public.mark_printed(p_booking_id uuid) returns integer
language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  if not private.is_editor() then
    raise exception 'บัญชีนี้ไม่มีสิทธิ์บันทึก' using errcode = '42501';
  end if;
  update public.bookings set print_count = print_count + 1, last_printed_at = now()
    where id = p_booking_id returning print_count into n;
  return n;
end $$;

revoke execute on function public.assign_doc_no(uuid), public.mark_printed(uuid) from public, anon;
grant  execute on function public.assign_doc_no(uuid), public.mark_printed(uuid) to authenticated;

-- ---------- Row Level Security ----------
alter table public.staff     enable row level security;
alter table public.varieties enable row level security;
alter table public.ponds     enable row level security;
alter table public.plantings enable row level security;
alter table public.bookings  enable row level security;

create policy "own staff row" on public.staff for select to authenticated
  using (user_id = (select auth.uid()));

do $$
declare t text;
begin
  foreach t in array array['varieties','ponds','plantings','bookings'] loop
    execute format('create policy "staff read"    on public.%I for select to authenticated using ((select private.is_staff()))', t);
    execute format('create policy "editor insert" on public.%I for insert to authenticated with check ((select private.is_editor()))', t);
    execute format('create policy "editor update" on public.%I for update to authenticated using ((select private.is_editor())) with check ((select private.is_editor()))', t);
    execute format('create policy "editor delete" on public.%I for delete to authenticated using ((select private.is_editor()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
revoke all on public.staff from anon;

-- ---------- Realtime ----------
alter publication supabase_realtime add table public.varieties, public.ponds, public.plantings, public.bookings;

-- ---------- multi-line bookings (migration 003) ----------
-- One booking can hold several Lot / variety lines.
-- bookings.items = [{"lot":"2026-L1","variety_id":"<uuid>","qty":110}, ...] is the source of truth.
-- The old single-line columns stay for older clients: qty always holds the total, lot/variety_id are
-- filled only when the booking has exactly one line, and a row written without items gets them from lot/variety_id/qty.

alter table public.bookings add column if not exists items jsonb;
-- backfill without touching updated_at (the list sorts by it)
alter table public.bookings disable trigger trg_bookings_upd;
update public.bookings
   set items = jsonb_build_array(jsonb_build_object('lot', lot, 'variety_id', variety_id, 'qty', qty))
 where items is null;
alter table public.bookings enable trigger trg_bookings_upd;
alter table public.bookings alter column items set not null;
alter table public.bookings alter column lot drop not null, alter column variety_id drop not null;

-- ---------- overbooking guard (same rule as the app's availFor / itemsFit) ----------
-- per line bucket: lines of this booking in (lot, variety) <= Lot bucket net − Lot booked
-- per variety:     lines of this booking in variety       <= variety net (incl. adjust) − variety booked
create or replace function public.check_booking_capacity() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  ln record; v text; v_name text; v_net int; v_booked int; v_avail int;
begin
  if new.items is null or jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 then
    if new.lot is null or new.variety_id is null then
      raise exception 'ใบจองต้องมีอย่างน้อย 1 รายการ' using errcode = '23514';
    end if;
    new.items := jsonb_build_array(jsonb_build_object('lot', new.lot, 'variety_id', new.variety_id, 'qty', new.qty));
  end if;

  for ln in select e->>'lot' as lot, (e->>'variety_id')::uuid as variety_id, (e->>'qty')::int as qty
              from jsonb_array_elements(new.items) e loop
    if ln.lot is null or ln.lot !~ '^\d{4}-L[12]$' or ln.qty is null or ln.qty <= 0
       or not exists (select 1 from public.varieties where id = ln.variety_id) then
      raise exception 'รายการจองไม่ถูกต้อง' using errcode = '23514';
    end if;
  end loop;

  select sum((e->>'qty')::int) into new.qty from jsonb_array_elements(new.items) e;
  if jsonb_array_length(new.items) = 1 then
    new.lot := new.items->0->>'lot'; new.variety_id := (new.items->0->>'variety_id')::uuid;
  else
    new.lot := null; new.variety_id := null;
  end if;

  if new.status = 'cancelled' then return new; end if;
  -- status changes and edits that keep the same lines skip the check
  if tg_op = 'UPDATE' and old.status <> 'cancelled' and new.items = old.items then return new; end if;

  for v in select distinct e->>'variety_id' from jsonb_array_elements(new.items) e order by 1 loop
    perform pg_advisory_xact_lock(hashtext('palm-booking:' || v));
  end loop;

  for ln in select e->>'lot' as lot, (e->>'variety_id')::uuid as variety_id, sum((e->>'qty')::int)::int as qty
              from jsonb_array_elements(new.items) e group by 1, 2 loop
    select greatest(0, coalesce(sum(qty - culled), 0)) into v_net
      from public.plantings where lot = ln.lot and variety_id = ln.variety_id;
    select coalesce(sum((e->>'qty')::int), 0) into v_booked
      from public.bookings b, jsonb_array_elements(b.items) e
     where b.status <> 'cancelled' and b.id <> new.id and e->>'lot' = ln.lot and e->>'variety_id' = ln.variety_id::text;
    v_avail := v_net - v_booked;
    if ln.qty > v_avail then
      select name into v_name from public.varieties where id = ln.variety_id;
      raise exception 'Lot% / % ยอดไม่พอ จองได้สูงสุด % ต้น', right(ln.lot, 1), v_name, greatest(v_avail, 0) using errcode = 'P0001';
    end if;
  end loop;

  for ln in select (e->>'variety_id')::uuid as variety_id, sum((e->>'qty')::int)::int as qty
              from jsonb_array_elements(new.items) e group by 1 loop
    select greatest(0,
             coalesce((select sum(qty - culled) from public.plantings where variety_id = ln.variety_id), 0)
           + coalesce((select adjust from public.varieties where id = ln.variety_id), 0)) into v_net;
    select coalesce(sum((e->>'qty')::int), 0) into v_booked
      from public.bookings b, jsonb_array_elements(b.items) e
     where b.status <> 'cancelled' and b.id <> new.id and e->>'variety_id' = ln.variety_id::text;
    v_avail := v_net - v_booked;
    if ln.qty > v_avail then
      select name into v_name from public.varieties where id = ln.variety_id;
      raise exception 'สายพันธุ์ % ยอดไม่พอ จองได้สูงสุด % ต้น', v_name, greatest(v_avail, 0) using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;

revoke execute on function public.check_booking_capacity() from public, anon, authenticated;

-- ---------- a variety used inside items cannot be deleted (variety_id FK only covers single-line rows) ----------
create or replace function public.guard_variety_in_bookings() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if exists (select 1 from public.bookings b, jsonb_array_elements(b.items) e where e->>'variety_id' = old.id::text) then
    raise exception 'สายพันธุ์นี้มีใบจองอยู่ จึงลบไม่ได้' using errcode = '23503';
  end if;
  return old;
end $$;

revoke execute on function public.guard_variety_in_bookings() from public, anon, authenticated;

drop trigger if exists trg_varieties_in_bookings on public.varieties;
create trigger trg_varieties_in_bookings before delete on public.varieties
  for each row execute function public.guard_variety_in_bookings();

-- ---------- returned bookings (migration 004) ----------
-- A delivered booking can be marked "returned" (รับคืนแล้ว): the seedlings came back, so its quantity
-- no longer counts as booked and goes back into what can be booked — same as 'cancelled' for stock.
-- Moving a returned booking back to delivered re-runs the capacity check.

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('reserved','confirmed','delivered','returned','cancelled'));

-- ---------- overbooking guard: 'returned' is released stock, like 'cancelled' ----------
create or replace function public.check_booking_capacity() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  ln record; v text; v_name text; v_net int; v_booked int; v_avail int;
begin
  if new.items is null or jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 then
    if new.lot is null or new.variety_id is null then
      raise exception 'ใบจองต้องมีอย่างน้อย 1 รายการ' using errcode = '23514';
    end if;
    new.items := jsonb_build_array(jsonb_build_object('lot', new.lot, 'variety_id', new.variety_id, 'qty', new.qty));
  end if;

  for ln in select e->>'lot' as lot, (e->>'variety_id')::uuid as variety_id, (e->>'qty')::int as qty
              from jsonb_array_elements(new.items) e loop
    if ln.lot is null or ln.lot !~ '^\d{4}-L[12]$' or ln.qty is null or ln.qty <= 0
       or not exists (select 1 from public.varieties where id = ln.variety_id) then
      raise exception 'รายการจองไม่ถูกต้อง' using errcode = '23514';
    end if;
  end loop;

  select sum((e->>'qty')::int) into new.qty from jsonb_array_elements(new.items) e;
  if jsonb_array_length(new.items) = 1 then
    new.lot := new.items->0->>'lot'; new.variety_id := (new.items->0->>'variety_id')::uuid;
  else
    new.lot := null; new.variety_id := null;
  end if;

  if new.status in ('cancelled','returned') then return new; end if;
  -- status changes and edits that keep the same lines skip the check
  if tg_op = 'UPDATE' and old.status not in ('cancelled','returned') and new.items = old.items then return new; end if;

  for v in select distinct e->>'variety_id' from jsonb_array_elements(new.items) e order by 1 loop
    perform pg_advisory_xact_lock(hashtext('palm-booking:' || v));
  end loop;

  for ln in select e->>'lot' as lot, (e->>'variety_id')::uuid as variety_id, sum((e->>'qty')::int)::int as qty
              from jsonb_array_elements(new.items) e group by 1, 2 loop
    select greatest(0, coalesce(sum(qty - culled), 0)) into v_net
      from public.plantings where lot = ln.lot and variety_id = ln.variety_id;
    select coalesce(sum((e->>'qty')::int), 0) into v_booked
      from public.bookings b, jsonb_array_elements(b.items) e
     where b.status not in ('cancelled','returned') and b.id <> new.id and e->>'lot' = ln.lot and e->>'variety_id' = ln.variety_id::text;
    v_avail := v_net - v_booked;
    if ln.qty > v_avail then
      select name into v_name from public.varieties where id = ln.variety_id;
      raise exception 'Lot% / % ยอดไม่พอ จองได้สูงสุด % ต้น', right(ln.lot, 1), v_name, greatest(v_avail, 0) using errcode = 'P0001';
    end if;
  end loop;

  for ln in select (e->>'variety_id')::uuid as variety_id, sum((e->>'qty')::int)::int as qty
              from jsonb_array_elements(new.items) e group by 1 loop
    select greatest(0,
             coalesce((select sum(qty - culled) from public.plantings where variety_id = ln.variety_id), 0)
           + coalesce((select adjust from public.varieties where id = ln.variety_id), 0)) into v_net;
    select coalesce(sum((e->>'qty')::int), 0) into v_booked
      from public.bookings b, jsonb_array_elements(b.items) e
     where b.status not in ('cancelled','returned') and b.id <> new.id and e->>'variety_id' = ln.variety_id::text;
    v_avail := v_net - v_booked;
    if ln.qty > v_avail then
      select name into v_name from public.varieties where id = ln.variety_id;
      raise exception 'สายพันธุ์ % ยอดไม่พอ จองได้สูงสุด % ต้น', v_name, greatest(v_avail, 0) using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;

revoke execute on function public.check_booking_capacity() from public, anon, authenticated;
