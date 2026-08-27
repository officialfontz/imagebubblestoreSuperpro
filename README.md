# Bubble Vault

คลังรูปส่วนตัว — โยนรูปเข้าไป กดคัดลอกลิงก์ แล้วเอาไปแปะที่เว็บไหนก็ได้

รูปทั้งหมดเสิร์ฟจาก **Cloudflare R2 + CDN** ไม่ใช่จากเซิร์ฟเวอร์ตัวนี้ แปลว่าถ้า
เว็บนี้ล่ม redeploy หรือโดน rate limit รูปที่แปะไว้ที่เว็บอื่นก็ยัง**ขึ้นปกติ**
และไม่กิน bandwidth ของ Railway เลย

---

## ความสามารถ

| | |
|---|---|
| อัปโหลด | ลากวางตรงไหนก็ได้ · วางจากคลิปบอร์ด (Ctrl+V) · เลือกไฟล์ · อัปโหลดทีละหลายสิบไฟล์ |
| บีบอัด | แปลงเป็น WebP อัตโนมัติ ย่อไม่เกิน 2400px คุณภาพ 85 (เล็กลง ~50–65% แต่ยังชัด) |
| จัดหมวด | คอลเลกชันพร้อมอีโมจิ · ลากรูปไปวางที่คอลเลกชันได้เลย |
| คัดลอก | คลิกที่รูป = คัดลอกลิงก์ทันที · หรือเลือกฟอร์แมต URL / Markdown / HTML / BBCode |
| เลือกหลายรูป | Ctrl+A เลือกทั้งหมด · คัดลอกลิงก์รวด · ย้าย · ลบ |
| ค้นหา / เรียง | ค้นชื่อ · เรียงตามใหม่-เก่า-ชื่อ-ขนาด · สลับความถี่ของตาราง |
| รูปเยอะ | ตารางเรนเดอร์เฉพาะแถวที่อยู่ใกล้จอ รองรับหลักพันรูปโดยไม่หน่วง |
| ความปลอดภัย | หน้า login + cookie เซ็นชื่อ · ล็อกเอาต์อัตโนมัติเมื่อเปลี่ยนรหัส · จำกัดจำนวนครั้งที่กรอกผิด |

**ลิงก์รูปเป็นสาธารณะเสมอ** (ถึงจะเอาไปแปะเว็บอื่นได้) ส่วนตัวเว็บจัดการต้องล็อกอิน

---

## ติดตั้งบน Railway

### 1. สร้าง bucket บน Cloudflare R2

1. เข้า Cloudflare dashboard → **R2** → **Create bucket** (เช่นชื่อ `bubble-vault`)
2. เข้า bucket → **Settings** → **Public access** → ต่อ **custom domain** เช่น `img.yourdomain.com`
   (ใช้ URL `pub-xxxx.r2.dev` ที่ Cloudflare แถมมาก็ได้ แต่มี rate limit และเปลี่ยนยาก
   — โดเมนตัวเองดีกว่ามาก)
3. **R2** → **Manage API Tokens** → **Create API token** → สิทธิ์ **Object Read & Write**
   จดค่า Access Key ID กับ Secret Access Key ไว้

### 2. Deploy

Deploy repo นี้เป็น service ใหม่บน Railway แล้ว **Attach a Volume** ไว้ที่ `/data`

> Volume จำเป็น — `vault.json` (ชื่อรูป คอลเลกชัน ขนาด) เก็บอยู่ตรงนั้น
> ถ้าไม่มี Volume ข้อมูลจะหายทุกครั้งที่ redeploy ทั้งที่ไฟล์รูปยังอยู่ใน R2

### 3. ตั้ง environment variables

```
VAULT_PASSWORD=<รหัสผ่านที่จะใช้เข้าเว็บ>
HMAC_KEY=<openssl rand -hex 32>
DATA_DIR=/data

R2_ACCOUNT_ID=<Account ID จากหน้า R2>
R2_ACCESS_KEY_ID=<จาก API token>
R2_SECRET_ACCESS_KEY=<จาก API token>
R2_BUCKET=bubble-vault
R2_PUBLIC_BASE=https://img.yourdomain.com

PUBLIC_HOST=vault.yourdomain.com
```

ยังไม่ได้ตั้งค่า R2 ก็ใช้งานได้ทันที — จะเก็บลงดิสก์ของ Railway ไปก่อน (ต้องตั้ง
`UPLOAD_DIR=/data/uploads` ด้วย ไม่งั้นรูปหายตอน redeploy) พอเติมค่า R2 ทีหลัง
รูปใหม่จะขึ้น R2 อัตโนมัติ **และลิงก์ของรูปเก่ายังใช้ได้เหมือนเดิม**

---

## ย้ายรูปเดิมเข้ามา

มีโฟลเดอร์รูปเดิมอยู่แล้ว (เช่น `public/uploads` ของเว็บหลัก) ใช้สคริปต์นี้ย้ายเข้ามาทีเดียว
— บีบอัดด้วยการตั้งค่าเดียวกับตอนอัปโหลดผ่านหน้าเว็บ แล้วเขียนลง `vault.json` ให้เลย

```bash
# ลองดูก่อนว่าจะเกิดอะไรขึ้น (ไม่เขียนอะไรทั้งสิ้น)
npm run import -- --from ../bubble-shop/public/uploads --dry

# ย้ายจริง พร้อมจัดใส่คอลเลกชัน
npm run import -- --from ../bubble-shop/public/uploads --collection "รูปเดิมจากร้าน"

# ย้าย แล้วแก้ลิงก์ในไฟล์ข้อมูลของเว็บหลักให้ชี้มาที่ CDN ด้วย
npm run import -- --from ../bubble-shop/public/uploads \
  --collection "รูปเดิมจากร้าน" \
  --rewrite ../bubble-shop/data/store.json \
  --rewrite ../bubble-shop/data/draft.json
```

> **ทำหลังตั้งค่า R2 เสร็จแล้วเท่านั้น** ถ้ายังไม่ได้ต่อ R2 รูปจะลงดิสก์ของเครื่องนี้
> แล้วลิงก์ที่เขียนกลับไปในเว็บหลักจะเป็น path ที่เว็บหลักเปิดไม่ได้

`--rewrite` สำรองไฟล์เดิมเป็น `.bak-<เวลา>` ก่อนเขียนทับเสมอ และรันซ้ำได้ไม่ซ้ำซ้อน —
รูปที่นำเข้าไปแล้วจะถูกข้าม ส่วนตารางลิงก์เก่า→ใหม่เก็บไว้ที่ `data/import-map.json`

---

## รูปเบา + ชัด ในที่เดียว

เก็บไฟล์ต้นฉบับความละเอียดสูงไว้ แล้วให้ Cloudflare ย่อตอนเสิร์ฟ — ลิงก์เดียว ได้ทุกขนาด
เปิด **Image Resizing** ในโดเมนของคุณก่อน แล้วเติม path นำหน้า:

```
https://img.yourdomain.com/cdn-cgi/image/width=800,quality=85,format=auto/<key>
```

`format=auto` จะส่ง AVIF ให้เบราว์เซอร์ที่รองรับ ซึ่งเล็กกว่า WebP อีกราว 20–30%

พอต่อ R2 ผ่านโดเมนตัวเองแล้ว **เมนูคัดลอกในเว็บจะมีปุ่ม "ลิงก์ย่อขนาด" ให้เลย**
(400px / 800px / 1600px) ไม่ต้องพิมพ์ path เอง — ส่วนโดเมนฟรี `*.r2.dev` ใช้ไม่ได้
เมนูก็จะไม่ขึ้นให้

---

## รันบนเครื่องตัวเอง

```bash
npm install
cp .env.example .env.local     # ใส่ VAULT_PASSWORD ของตัวเอง
npm run dev                    # http://localhost:3100
```

ไม่ต้องมีบัญชี Cloudflare — ถ้าไม่ได้ตั้งค่า R2 รูปจะลงที่ `public/uploads/`
และเสิร์ฟผ่าน `/uploads/*` ให้เอง

```bash
npm run validate   # tsc --noEmit + eslint
```

---

## โครงสร้าง

```
app/
  page.tsx              เช็ค auth แล้วโหลดแคตตาล็อก
  login/                หน้าเข้าสู่ระบบ
  uploads/[...path]/    เสิร์ฟรูปตอนยังไม่ได้ต่อ R2 (public เสมอ)
  components/           UI ทั้งหมด
  globals.css           design tokens
  vault.css             คอมโพเนนต์
scripts/
  import-images.mjs     ย้ายรูปจากโฟลเดอร์เดิมเข้าคลัง
lib/
  storage.ts            ไดรเวอร์ R2 / ดิสก์
  store.ts              vault.json + write mutex
  actions.ts            server actions (อัปโหลด ลบ ย้าย เปลี่ยนชื่อ)
  session.ts            cookie เซ็นด้วย HMAC
  auth.ts               requireAuth() ที่เรียกในทุก action
proxy.ts                edge gate: auth + rate limit + bot filter
```

ไฟล์รูปอยู่ใน R2 ส่วน**แคตตาล็อก**อยู่ใน `vault.json` ไฟล์เดียว — สำรองง่าย
แก้ด้วยมือได้ และไม่ต้องมีฐานข้อมูลให้ดูแล
