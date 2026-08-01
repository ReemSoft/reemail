# نشر تحسينات IMAP على البريدج + فحص خطأ "Failed to open message"

## الجواب المختصر
نعم. التحسينات (اتصال IMAP واحد لكل حساب، كاش LIST، تنزيل جزء النص فقط) كلها داخل مجلد `bridge/`، وهذا الكود **لا يعمل على Lovable** — يعمل كعملية Node مستقلة على الـ VPS تحت PM2 باسم `mailmaestro-bridge`. طالما لم يُنشر الكود هناك، سيبقى النظام يعمل بالنسخة القديمة تماماً كما في الصورة.

## خطوات التنفيذ

### 1) نشر الواجهة (Lovable)
تعديلات `src/routes/mail.tsx` و`src/lib/mail-types.ts` تحتاج Publish من داخل Lovable.

### 2) نشر البريدج على الـ VPS
عبر السكربت الموجود `deploy-bridge.sh` (يتضمن rollback تلقائي وفحص صحة):
- `git pull --ff-only origin main` داخل `/home/reemsoft/mailmaestro`
- `npm ci && npm run build` داخل `bridge/`
- `pm2 restart mailmaestro-bridge --update-env`
- فحص `/health` محلياً وعلناً

ملاحظة ترتيب: البريدج الجديد متوافق مع الواجهة القديمة (حقل `inlineParts` اختياري)، لذا يُنشر البريدج أولاً ثم الواجهة، بدون انقطاع.

### 3) متغيرات بيئة اختيارية في `bridge/.env`
- `MAIL_BRIDGE_TIMING=1` مؤقتاً لقياس الأزمنة الفعلية (connect / list / select / fetch) في سجلات PM2
- `IMAP_CONN_IDLE_MS` (افتراضي 5 دقائق)، `IMAP_LIST_CACHE_MS` (5 دقائق)، `INLINE_CID_MAX_BYTES` (256KB)

### 4) خطأ "Failed to open message" الظاهر في الصورة
هذا الخطأ من النسخة القديمة الحالية ولم يُشخَّص بعد. بعد النشر مباشرة:
- قراءة سجلات PM2 (`pm2 logs mailmaestro-bridge`) عند فتح رسالة فاشلة
- إن استمر الخطأ، أُشخّصه من السجل الفعلي وأصلح السبب الجذري — بدون ترقيع

### 5) القياس قبل/بعد
مع `MAIL_BRIDGE_TIMING=1`، نسجل زمن فتح نفس الرسالة (Gmail وcPanel) ونقارنه بالوضع الحالي، ونطفئ التتبع بعد القياس.

## ملاحظات تقنية
- لا تغيير في أي عقد API؛ `MailMessage.inlineParts` إضافة اختيارية فقط.
- لا يُلمس ملف `.env` على السيرفر أثناء النشر.
- في حال فشل أي خطوة، السكربت يرجع إلى `OLD_SHA` ويعيد البناء والتشغيل تلقائياً.
