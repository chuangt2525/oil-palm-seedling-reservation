-- Move RLS helper functions out of the exposed API schema; run RPCs as the caller.
create schema if not exists private;
grant usage on schema private to authenticated;
alter function public.is_staff()  set schema private;
alter function public.is_editor() set schema private;
revoke execute on function private.is_staff(), private.is_editor() from public, anon;
grant  execute on function private.is_staff(), private.is_editor() to authenticated;

alter function public.check_booking_capacity() security invoker;
revoke execute on function public.check_booking_capacity() from public, anon, authenticated;

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
