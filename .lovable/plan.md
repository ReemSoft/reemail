# اختبار تحميل واقعي متدرج لـ MailMaestro

## أولاً: نتيجة فحص الإمكانات (مُتحقَّق منه من الكود، بدون تخمين)

ما تم التأكد منه فعلياً:

- الرابط المنشور: `https://reemail.lovable.app` (ودومين مخصص `https://mailmaestro.online`).
- الدخول: `clientLogin` في `src/lib/client-mail.functions.ts` — يتحقق من كلمة المرور مباشرة عبر IMAP، ويعيد جلسة تُحفظ في `sessionStorage` فقط (`src/lib/mail-session.ts`)، مع `mailSessionToken` (JWT قصير العمر مرتبط بـ account id).
- تحميل قائمة الرسائل: `indexListMessages` (`src/lib/mail-index.functions.ts`) — من الفهرس المحلي في قاعدة البيانات، ويرفض `starred` ويحوّلها للبريدج.
- المجلدات/القوائم الحيّة: `bridgeGetFolderCounts` / `bridgeGetMessages` (`src/lib/mail-bridge.functions.ts`).
- فتح الرسالة: `openMailMessage` (`src/lib/mail-message-open.functions.ts`) — يعيد بوضوح `source: "cache"` أو `source: "imap"`، وهذا هو مصدر التحقق المباشر من HIT/MISS دون الحاجة للسجلات.
- التسخين الخلفي: `warmMessageBodies` في الملف نفسه (lane = `background`).
- السجلات: `[message-open] cache-read/imap-fetch/total`، `[body-cache] hit/miss/store/evict` تُطبع في Server Function logs (أداة `stack_modern--server-function-logs`). أخطاء `IMAP_BUSY` وحالة الطوابير من البريدج على VPS: `GET /api/metrics/imap-gates` (يتطلب `X-Bridge-Key`) و `GET /health`، بالإضافة إلى `pm2 logs mail-bridge`.
- البوابات: كل مسارات البريدج خلف `imapGate("interactive")` أو `background`، وعدادات `activeGlobal / waitingInteractive / waitingBackground / rejected / timedOut / cancelled` موجودة فعلاً في `bridge/src/imap-gates.ts`.

قيود حقيقية يجب إعلانها الآن (لا ادعاء بما لا يمكن تنفيذه):

1. **k6 غير مثبّت** في بيئة التنفيذ المتاحة لي. يمكن تجربة تشغيله عبر `nix run nixpkgs#k6`؛ إن فشل، تبقى ملفات الاختبار جاهزة للتشغيل من جهازك/Runner خارجي، وأصرّح بعدم تنفيذها.
2. **لا يوجد Runner خارجي حقيقي مستقل**. بيئتي منفصلة عن خادم التطبيق وعن VPS البريدج، لذا فهي "خارجية" بالمعنى الشبكي، لكنها بيئة واحدة محدودة المعالج/النطاق ولا تصلح لتوليد 500–1000 VU بشكل موثوق. المراحل 4 و5 تحتاج k6 Cloud أو عدة أجهزة توليد حمل.
3. **لا توجد حسابات بريد اختبارية معروفة في الكود**، ولا يمكنني إنشاء صناديق IMAP حقيقية. بدون قائمة حسابات اختبار (بريد + كلمة مرور) لا يمكن تسجيل دخول VU حقيقي إطلاقاً، وممنوع استخدام حسابات العملاء.
4. **CPU/RAM لخادم Lovable غير متاحة لي كمقياس**. متاح فقط: مقاييس k6، وسجلات Server Functions، ومقاييس البريدج/PM2 إن نفّذتها أنت على VPS.
5. استدعاء Server Functions يتم عبر مسار داخلي يولّده TanStack؛ سأثبّته تجريبياً في مرحلة Smoke عبر مراقبة طلبات المتصفح الحقيقية قبل تثبيته في سكربت k6.

## ثانياً: ما سأنشئه

```
tests/load/
  mailmaestro-realistic-load.js   # سيناريو k6 كامل + مراحل + عتبات
  accounts.example.json           # قالب حسابات الاختبار (بدون أسرار)
  README.md                       # طريقة التشغيل والقيود
  .env.example                    # BASE_URL, STAGE, ACCOUNTS_FILE ... بدون أسرار
```

السيناريو: تسجيل دخول لكل VU بحساب اختباري من القائمة (توزيع round-robin على كل الحسابات المتاحة، وتسجيل العدد الحقيقي) ← فتح Inbox ← قائمة رسائل ← انتظار 1–4 ثوانٍ ← فتح رسالة حديثة (Cache) ← إعادة فتحها (HIT) ← رسالة أخرى ← بنسبة محدودة رسالة قديمة خارج نافذة الكاش (MISS/IMAP) ← Sent ثم عودة Inbox ← تكرار. قراءة فقط: لا إرسال، لا حذف، لا نقل، لا تعديل.

التوزيع بعد التسخين: 60% فتح من الكاش، 20% قوائم/مجلدات، 10% إعادة فتح، 10% Cache Miss.

المقاييس المخصصة في k6: `cache_hits`, `cache_misses`, `cache_hit_ratio`, `imap_busy`, `timeouts`, `login_duration`, `list_duration`, `open_cache_duration`, `open_imap_duration`, مع Thresholds مطابقة لمعايير القبول (5xx < 0.1%، أخطاء < 1%، cache P95 < 500ms، list P95 < 1500ms، IMAP P95 < 3000ms).

المراحل مُعرَّفة كـ `scenarios` منفصلة تُشغَّل يدوياً واحدة تلو الأخرى عبر `STAGE=smoke|s1|s2|s3|s4|s5` — لا انتقال تلقائي عند الفشل.

## ثالثاً: التنفيذ الآن — المرحلة 0 فقط

1. إنشاء ملفات `tests/load/`.
2. محاولة توفير k6 عبر nix؛ إعلان النتيجة صراحة.
3. تثبيت مسار استدعاء Server Functions فعلياً من المتصفح قبل الضغط.
4. تشغيل Smoke: 5 VU × دقيقتان — **فقط إذا وفّرت حسابات اختبار**.
5. تقرير المرحلة 0: PASS/FAIL بأرقام حقيقية + حالة طوابير البريدج قبل/بعد + خطة الانتقال.

لن أنتقل للمراحل 1–5 قبل مراجعتك لنتيجة Smoke. لا Deploy ولا Publish.

## ما أحتاجه منك قبل أي ضغط

- قائمة حسابات بريد اختبارية (بريد + كلمة مرور) وعددها، على شركة/شركات اختبارية.
- إن أردت مقاييس البريدج: قيمة `X-Bridge-Key` تُحفظ كسر (Secret) وليس في الملفات.
- تأكيد الهدف: الضغط على الإنتاج `reemail.lovable.app` أم على بيئة معاينة.
