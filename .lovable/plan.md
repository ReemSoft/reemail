# تسريع فتح الرسالة — النسخة المعيارية المبسّطة

رأيي: أوافق على البنود الثلاثة. هي بالضبط ما تفعله عملاء البريد المعيارية (اتصال IMAP واحد مُعاد الاستخدام + تخزين LIST + جلب أجزاء النص فقط)، وتغطي أكثر من 90% من التأخير الحالي. لدي تحفّظ واحد فقط لا بد من حسمه قبل التنفيذ (نقطة CID أدناه).

## ما تم التحقق منه فعلياً في الكود

`bridge/src/imap.ts:314-394` (`getMessageBody`) يفعل في كل ضغطة على رسالة:
- `makeImapClient` + `connect()` — TCP + TLS + LOGIN من الصفر (السطر 315‑317)
- `listMailboxes(client)` — أمر LIST كامل (السطر 318)
- `getMailboxLock(path)` — SELECT كامل
- `fetchOne(..., { source: true })` — تنزيل **الرسالة كاملة بمرفقاتها** (السطر 332)
- `simpleParser(msg.source)` — تحليل MIME كامل بما فيه المرفقات (السطر 338)
- `logout()` في النهاية (السطر 392)

## التحفّظ الوحيد: تعارض البند 3 مع CID

الأسطر 354‑375 تبني صور البريد المضمّنة (`cid:`) من `rawParsed.attachments`، أي من المصدر الكامل. إذا نزّلنا `text/html` فقط، ستنكسر الصور المضمّنة — وهذا ليس "عدم تغيير CID"، بل تعطيله.

الحل المعياري (وهو ما يفعله Thunderbird/Roundcube): بعد `bodyStructure`، ننزّل أجزاء النص **+ فقط أجزاء `image/*` ذات `content-id` وبحجم أقل من ~256KB**، ونترك بقية المرفقات لمسار التحميل الحالي (`downloadAttachment`). هذا يحافظ على سلوك CID كما هو تماماً ويحذف الحمل الحقيقي (PDF/ZIP/صور كبيرة).

## خطة التنفيذ

1. **اتصال واحد لكل حساب نشط** — ملف جديد `bridge/src/imap-connection.ts`:
   - خريطة `accountKey -> { client, lastUsed, connecting }` باتصال **واحد** لكل حساب (لا pool).
   - `withAccountConnection(account, password, fn)` تعيد استخدام الاتصال، وتستخدم `getMailboxLock` للتسلسل، وتعيد الاتصال مرة واحدة عند خطأ اتصال ثم تعيد المحاولة.
   - مؤقّت خمول 5 دقائق يغلق الاتصال بـ `logout()`؛ إغلاق نظيف عند `SIGTERM`.
   - يُستخدم أولاً في `getMessageBody` فقط؛ باقي المسارات تبقى كما هي في هذه الجولة.

2. **تخزين نتيجة LIST 5 دقائق لكل حساب** — داخل نفس الملف، `getMailboxesCached(client, accountKey)`؛ يُبطَل الكاش عند إعادة الاتصال أو خطأ "مجلد غير موجود".

3. **جلب الأجزاء بدل المصدر الكامل** — في `getMessageBody`:
   - `fetchOne` بـ `envelope + flags + bodyStructure + internalDate` بلا `source`.
   - اختيار جزء `text/html` وإلا `text/plain` من `bodyStructure`، وتنزيله عبر `client.download(uid, part, { uid: true })`.
   - تنزيل أجزاء `image/*` ذات `content-id` فقط (حد ~256KB) لبناء `data:` URIs كما هو الآن.
   - `parsed.attachments` تبقى مبنية من `collectAttachmentParts(msg.bodyStructure)` بلا تغيير — لا تغيير في أي عقد بيانات مع الواجهة.

4. **القياس قبل/بعد** — سجل زمني داخل الجسر (ms + bytes) لكل مرحلة: connect / list / select / fetch، خلف علم `MAIL_BRIDGE_TIMING=1`، ثم مقارنة موثّقة قبل وبعد على رسالة Gmail ورسالة cPanel.

## الحدود

- بلا prefetch، بلا pool متعدد، بلا اتصال لكل مجلد، بلا deploy أو push.
- بلا تغيير في واجهات الجسر أو في الواجهة الأمامية أو في نموذج الأمان (`imapGate` يبقى كما هو).
- اختبارات جديدة لـ: إعادة استخدام الاتصال، انتهاء الخمول، إعادة الاتصال بعد خطأ، اختيار جزء النص، والحفاظ على CID.
