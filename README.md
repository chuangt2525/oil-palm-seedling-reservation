# Oil Palm Seedling Reservation System

ระบบจองต้นกล้าปาล์ม — คำนวณยอดเพาะ · ตรวจสอบยอดคงเหลือ · บันทึกการจองรายวัน · พิมพ์ใบจอง PDF

เว็บแบบ static (HTML/CSS/JS ล้วน ไม่ต้อง build) โฮสต์บน **GitHub Pages** และเก็บข้อมูลใน **Supabase** (Postgres + Auth + Realtime)

---

## 1. สถาปัตยกรรม

```
 เบราว์เซอร์ / มือถือ
 ┌───────────────────────────────┐
 │ GitHub Pages (static)         │
 │  index.html                   │
 │  assets/app.js  ── supabase-js ───────────────┐
 │  assets/config.js (URL + publishable key)     │
 └───────────────────────────────┘               │ HTTPS
                                                 ▼
                         ┌───────────────────────────────────────┐
                         │ Supabase project                      │
                         │  Auth   : อีเมล + รหัสผ่าน (เจ้าหน้าที่)   │
                         │  REST   : ตาราง 4 ตาราง + RPC 2 ตัว     │
                         │  RLS    : อ่าน/เขียนได้เฉพาะคนในตาราง staff │
                         │  Realtime: แจ้งเปลี่ยนแปลงทุกเครื่องทันที   │
                         └───────────────────────────────────────┘
```

- **ไม่มีเซิร์ฟเวอร์ของเราเอง** — กฎสำคัญทั้งหมดบังคับที่ฐานข้อมูล (RLS, trigger, constraint) จึงปลอดภัยแม้โค้ดหน้าเว็บจะเปิดให้ทุกคนเห็น
- **publishable key ใน `config.js` เปิดเผยได้** — key นี้ทำได้แค่สิ่งที่ RLS อนุญาต (ห้ามใส่ `service_role` / secret key ในไฟล์ใดๆ ของ repo)
- **Realtime** — เมื่อเครื่องหนึ่งบันทึก เครื่องอื่นที่เปิดอยู่จะอัปเดตเองภายใน ~1 วินาที
- **โหมดตัวอย่าง** — ถ้า `config.js` ว่าง หน้าเว็บจะใช้ข้อมูลตัวอย่างในเครื่อง (ไม่บันทึก) ใช้สำหรับสาธิต

## 2. โครงสร้างไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` | โครงหน้าเว็บ: หน้าเข้าสู่ระบบ + 5 แท็บ (ภาพรวม / จอง / รายการ / เพาะ / ตั้งค่า) |
| `assets/app.css` | สไตล์ รองรับมือถือ (แถบเมนูล่าง, ตารางเป็นการ์ด) และ dark mode |
| `assets/app.js` | ตรรกะทั้งหมด: คำนวณยอด, ฟอร์ม, เชื่อม Supabase, สร้าง PDF |
| `assets/config.js` | URL ของ Supabase project และ publishable key |
| `supabase/migrations/*.sql` | schema ฐานข้อมูล (ใช้กับ project แล้ว — เก็บไว้สร้างใหม่/อ้างอิง) |
| `.nojekyll` | บอก GitHub Pages ให้เสิร์ฟไฟล์ตรงๆ ไม่ผ่าน Jekyll |

## 3. ฐานข้อมูล

Supabase project: `oil-palm-seedling-reservation` (ref `naiyampjitchsygixcyq`, region Singapore)

| ตาราง | เก็บอะไร | คอลัมน์หลัก |
|---|---|---|
| `varieties` | สายพันธุ์ | `name` (ไม่ซ้ำ), `adjust` = ยอดปรับ |
| `ponds` | แปลงเพาะปลูก | `name` (ไม่ซ้ำ), `lot` L1/L2, `capacity`, `variety_id` |
| `plantings` | บันทึกการเพาะรายวัน | `lot` (เช่น `2026-L2`), `date`, `pond_id`, `variety_id`, `qty`, `culled` |
| `bookings` | การจอง | `doc_no`, `date`, `lot`, `variety_id`, `qty`, `customer`, `phone`, `pickup_date`, `status`, `print_count` |
| `staff` | รายชื่อผู้มีสิทธิ์ใช้ระบบ | `user_id`, `email`, `role` = `editor` / `viewer` |

กฎที่ฐานข้อมูลบังคับเอง (กันข้อมูลผิดแม้หลายคนกดพร้อมกัน):

- **กันจองเกิน** — trigger `check_booking_capacity` คำนวณยอดคงเหลือแบบเดียวกับหน้าเว็บ (min ของยอดใน Lot และยอดรวมสายพันธุ์) และล็อกต่อสายพันธุ์ ถ้าไม่พอจะปฏิเสธพร้อมข้อความ “ยอดไม่พอ จองได้สูงสุด X ต้น”
- **เลขที่ใบจองไม่ซ้ำ** — RPC `assign_doc_no` ออกเลข `BK{ปี พ.ศ. 2 หลัก}{เดือน}{วัน}-{0001}` ตอนพิมพ์ครั้งแรก พิมพ์ซ้ำได้เลขเดิม; `mark_printed` นับจำนวนครั้งที่พิมพ์
- **ลบข้อมูลที่ถูกใช้งานไม่ได้** — foreign key `on delete restrict` (เช่น ลบสายพันธุ์ที่มีการจองอยู่)
- **ตรวจค่า** — จำนวน > 0, คัดทิ้ง ≤ จำนวนเพาะ, สถานะต้องเป็น 4 ค่าที่กำหนด

## 4. สิทธิ์การใช้งาน

| ผู้ใช้ | ดูข้อมูล | บันทึก/แก้ไข/ลบ | ออกเลขใบจอง |
|---|---|---|---|
| ไม่ได้เข้าสู่ระบบ | ✗ | ✗ | ✗ |
| เข้าสู่ระบบ แต่ไม่อยู่ในตาราง `staff` | ✗ (ระบบแจ้ง “ยังไม่ได้รับสิทธิ์”) | ✗ | ✗ |
| `staff.role = 'viewer'` | ✓ | ✗ | ✗ (พิมพ์ซ้ำใบที่มีเลขแล้วได้) |
| `staff.role = 'editor'` | ✓ | ✓ | ✓ |

### เพิ่มเจ้าหน้าที่

1. Supabase Dashboard → **Authentication → Users → Add user → Create new user** ใส่อีเมล + รหัสผ่าน และติ๊ก **Auto Confirm User**
2. **SQL Editor** → รัน (เปลี่ยนอีเมลและสิทธิ์ตามต้องการ):

```sql
insert into public.staff (user_id, email, role)
select id, email, 'editor' from auth.users where email = 'staff@example.com';
```

เปลี่ยนสิทธิ์: `update public.staff set role = 'viewer' where email = 'staff@example.com';`
ถอนสิทธิ์: `delete from public.staff where email = 'staff@example.com';`

### ตั้งค่า Auth ที่แนะนำ (ทำครั้งเดียว)

- **Authentication → Sign In / Providers → Email**: ปิด **Allow new users to sign up** (ให้แอดมินสร้างบัญชีเท่านั้น — ถึงเปิดไว้ คนที่สมัครเองก็ดูข้อมูลไม่ได้เพราะไม่อยู่ใน `staff`)
- **Authentication → URL Configuration → Site URL**: ใส่ URL ของ GitHub Pages (ข้อ 5)

## 5. Deploy บน GitHub Pages

```bash
# 1) สร้าง repo ว่างที่ https://github.com/new  ชื่อ oil-palm-seedling-reservation (Public)
# 2) ในโฟลเดอร์นี้
git remote add origin https://github.com/<ชื่อบัญชี>/oil-palm-seedling-reservation.git
git push -u origin main
```

3. ใน repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**
4. รอ 1–2 นาที เว็บจะอยู่ที่ `https://<ชื่อบัญชี>.github.io/oil-palm-seedling-reservation/`

> GitHub Pages ฟรีต้องเป็น repo **Public** — ไม่เป็นปัญหาเพราะข้อมูลอยู่ใน Supabase และป้องกันด้วย RLS ไม่ได้อยู่ในโค้ด

อัปเดตเว็บครั้งต่อไป: แก้ไฟล์ → `git commit -am "..."` → `git push` (Pages อัปเดตเองใน 1–2 นาที)

## 6. ทดสอบในเครื่อง

```bash
python -m http.server 8000
# เปิด http://localhost:8000
```

ถ้าต้องการทดสอบโดยไม่แตะฐานข้อมูลจริง ให้แก้ `assets/config.js` เป็นค่าว่างชั่วคราว (จะเข้าโหมดตัวอย่าง) — อย่า commit ไฟล์นั้น

## 7. ข้อควรรู้

- Supabase แพ็กเกจฟรีจะ **pause project ที่ไม่มีการใช้งาน 7 วัน** — ถ้าหน้าเว็บขึ้น “เชื่อมต่อฐานข้อมูลไม่ได้” ให้เข้า Dashboard แล้วกด Restore
- สำรองข้อมูล: Dashboard → Table Editor → เลือกตาราง → Export to CSV (แพ็กเกจฟรีไม่มี backup อัตโนมัติแบบ point-in-time)
