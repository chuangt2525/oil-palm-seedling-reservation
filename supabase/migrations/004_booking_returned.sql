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
