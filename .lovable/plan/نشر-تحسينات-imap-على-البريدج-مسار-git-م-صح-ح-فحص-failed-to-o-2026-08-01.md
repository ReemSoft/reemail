# نشر تحسينات IMAP على البريدج — مسار Git مُصحَّح + فحص "Failed to open message"

## الجواب المختصر

نعم، النشر مطلوب. التحسينات (اتصال IMAP واحد لكل حساب، كاش LIST، تنزيل جزء النص فقط) كلها داخل `bridge/`، وهذا الكود لا يعمل على Lovable — يعمل كعملية Node على الـ VPS تحت PM2 باسم `mailmaestro-bridge`. وملاحظة الخبير صحيحة: `deploy-bridge.sh` يستخدم `git pull --ff-only origin main`، والتغييرات لم تُدفع إلى `main` بعد، فلن يجلب شيئاً.

## الترتيب المعتمد

### 0) قبل أي إعادة تشغيل — حفظ الأدلة

- حفظ سجلات PM2 الحالية إلى ملف: `pm2 logs mailmaestro-bridge --lines 2000 --nostream > ~/mm-baseline-$(date +%F-%H%M).log`
- تسجيل زمن فتح رسالة Gmail حالياً كـ baseline (من تبويب Network في المتصفح، مدة طلب فتح الرسالة).
- ممنوع مسح أي سجل قديم قبل تشخيص خطأ `Failed to open message`.

### 1) Commit ودفع إلى فرع مؤقت

- اسم الفرع: `imap-speed-live-test`
- رسالة commit واضحة تصف: single IMAP connection per account + LIST cache + partial body fetch.
- ملاحظة تنفيذية: لا أستطيع تنفيذ عمليات git من هنا؛ يتم إنشاء الفرع والدفع عبر مزامنة GitHub الخاصة بالمشروع أو محلياً، ثم تزويدي بالـ SHA.

### 2) النشر على السيرفر من الفرع (لا من main)

`deploy-bridge.sh` مربوط بـ `origin main`. التنفيذ الآمن دون تعديل بنية السكربت:

```bash
cd /home/reemsoft/mailmaestro
OLD_SHA=$(git rev-parse HEAD); echo "$OLD_SHA" > ~/mm-rollback-sha.txt
git fetch origin imap-speed-live-test
git checkout -B imap-speed-live-test origin/imap-speed-live-test
git rev-parse HEAD            # يُسجَّل كـ DEPLOYED_SHA
cd bridge && npm ci && npm run build
pm2 restart mailmaestro-bridge --update-env
```

Rollback يبقى مرتبطاً بـ `OLD_SHA` المحفوظ:

```bash
cd /home/reemsoft/mailmaestro && git reset --hard $(cat ~/mm-rollback-sha.txt) \
  && cd bridge && npm ci && npm run build && pm2 restart mailmaestro-bridge --update-env
```

### 3) تفعيل القياس مؤقتاً

قبل الـ restart: إضافة `MAIL_BRIDGE_TIMING=1` إلى `bridge/.env` (ملف `.env` لا يُلمس من السكربت، يُعدَّل يدوياً).
اختيارياً: `IMAP_CONN_IDLE_MS`، `IMAP_LIST_CACHE_MS`، `INLINE_CID_MAX_BYTES` (افتراضياتها 5د/5د/256KB).

### 4) فحص الصحة

- `curl -fsS http://127.0.0.1:8787/health`
- `curl -fsS https://mailmaestro.reemsoft.com/health`
- التأكد من عدم وجود restart loop: `pm2 describe mailmaestro-bridge | grep -i restart`

### 5) الاختبار الحي (البريدج قبل الواجهة)

البريدج الجديد متوافق مع الواجهة القديمة (`inlineParts` حقل اختياري)، لذا يُختبر وحده:

1. فتح أول رسالة (اتصال بارد) — تسجيل الزمن.
2. فتح 5 رسائل متتالية (اتصال دافئ) — تسجيل الأزمنة.
3. رسالة بمرفق كبير — التأكد أن النص يفتح فوراً وأن المرفق يُحمَّل عند الطلب فقط.
4. رسالة بصور CID (صغيرة وكبيرة) — التأكد من ظهور الصغيرة inline وعدم كسر الكبيرة.
5. تكرار 1–4 على حساب Gmail وحساب cPanel.
6. مراقبة أسطر `[imap-timing] connect/list/select` في سجلات PM2.

### 6) تشخيص "Failed to open message"

مع فتح رسالة فاشلة، قراءة السجل الحي `pm2 logs mailmaestro-bridge` وتحديد السبب الجذري من الخطأ الفعلي — بدون ترقيع. إن ظهر أنه سبب منفصل عن الأداء، يُعالج كبند مستقل.

### 7) نشر واجهة Lovable

بعد نجاح البريدج فقط: Publish من Lovable (تعديلات `src/routes/mail.tsx` و`src/lib/mail-types.ts`).

### 8) الإغلاق

- دمج `imap-speed-live-test` في `main`.
- إزالة `MAIL_BRIDGE_TIMING` من `bridge/.env` وإعادة التشغيل.
- الاحتفاظ بملف الـ baseline والقياسات بعد التحسين للمقارنة الموثقة.

## ملاحظات تقنية

- لا تغيير في أي عقد API؛ `MailMessage.inlineParts` إضافة اختيارية فقط.
- `.env` على السيرفر لا يُلمس أثناء النشر إلا يدوياً لتفعيل/إيقاف القياس.
- عدم استخدام `git pull --ff-only origin main` في هذه الجولة إطلاقاً.

&nbsp;

الخطة سليمة، وأعتمدها مع **تعديلين مهمين فقط**:

1. انشر الـSHA نفسه بوضع **detached HEAD** بدل تحريك فرع السيرفر بـ`reset --hard`؛ هذا أكثر أماناً ويجعل الرجوع واضحاً.
2. البريدج وحده متوافق مع الواجهة القديمة لفتح النص، لكن **صور CID الكبيرة لن تعمل بالكامل إلا بعد نشر الواجهة الجديدة** لأنها هي التي تقرأ `inlineParts`.

استخدم للنشر:

```bash
cd /home/reemsoft/mailmaestro

test -z "$(git status --porcelain)" || {
  echo "ABORT: Repository has local changes."
  exit 1
}

OLD_SHA="$(git rev-parse HEAD)"
echo "$OLD_SHA" > ~/mm-rollback-sha.txt

git fetch origin imap-speed-live-test
DEPLOYED_SHA="$(git rev-parse origin/imap-speed-live-test)"
echo "$DEPLOYED_SHA" > ~/mm-deployed-sha.txt

git switch --detach "$DEPLOYED_SHA"

cd bridge
npm ci
npm run build

pm2 restart mailmaestro-bridge --update-env
curl -fsS http://127.0.0.1:8787/health

```

والرجوع:

```bash
cd /home/reemsoft/mailmaestro
git switch --detach "$(cat ~/mm-rollback-sha.txt)"

cd bridge
npm ci
npm run build

pm2 restart mailmaestro-bridge --update-env
curl -fsS http://127.0.0.1:8787/health

```

الترتيب النهائي: **احفظ السجلات → انشر البريدج → اختبر السرعة والنص والمرفقات → انشر واجهة Lovable → اختبر CID بالكامل → ادمج في `main**`.

**القرار: GO.**

&nbsp;