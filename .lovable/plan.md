# خطة: استعادة بيئة المعاينة + إصلاح خطأين جديدين ظاهرين الآن في المعاينة

## الوضع الحالي (مؤكد من الفحص الفعلي)
1. خطأ البيئة: `Missing SUPABASE_SERVICE_ROLE_KEY` — نفس مشكلة الحقن العابر المشخّصة سابقاً.
2. خطأ runtime جديد: `Maximum update depth exceeded` — حلقة render لا نهائية، مصدرها `src/routes/mail.tsx` داخل `useInlineImageMappings` (السطور 544–638).
3. أخطاء TypeScript في البناء: `src/routes/mail.tsx` السطور 9163–9241 (`'res' is possibly 'null'`).

## الجزء A — استعادة البيئة (كما طلبت بالضبط، بدون أي تعديل كود)
1. إعادة ربط الأسرار المُدارة الحالية (عملية آمنة: لا تدوير، لا استبدال، لا إبطال لأي مفتاح).
2. إعادة تشغيل خادم المعاينة لالتقاط البيئة المحدّثة.
3. التحقق من وجود `SUPABASE_SERVICE_ROLE_KEY` في عملية الخادم الحية (وجود فقط، دون طباعة قيم).
4. التحقق من اختفاء الخطأ من السجلات.

## الجزء B — إصلاح حلقة الـ render اللانهائية (سبب جذري مؤكد)
**السبب الجذري**: الـ effect في `useInlineImageMappings` يعتمد على `inlinePartition.smallBatchParts`، وهو مصفوفة جديدة المرجع كلما تغيّر `resolved`. وفي نفس الوقت الـ effect نفسه يستدعي `setResolved` عبر مسار `decodeInlineMappings(...).then(...)` الذي يُنشئ كائن state جديداً دائماً حتى لو لم يتغير شيء → `resolvedCids` جديد → `inlinePartition` جديد → الـ effect يعيد التشغيل → حلقة لا تنتهي.

**الإصلاح (محدود وموضعي، دون لمس أي منطق آخر)**:
- في مساري `setResolved` داخل الـ effect: مقارنة الصور المدموجة بالحالية (cid + dataUri + الأبعاد) وإرجاع `current` دون تغيير عند التطابق — فينكسرCycle فوراً.
- لا تغيير في سلوك جلب الصور أو الكاش أو الأداء.

## الجزء C — إصلاح أخطاء TypeScript (تصحيح أنواع فقط، صفر تغيير سلوك)
- في كتلة حفظ المسودة (9147–9241): `res` معرّف بـ `let` فيفقد TypeScript تضييق `null` داخل الكتل. الحل: نسخه إلى `const` بعد منطق إعادة المحاولة واستخدام الثابت في باقي الكتلة، مع تضييق نوع `sourceAttachmentHandles`/`inlineSourceHandles` عبر `Array.isArray` على متغير محلي.
- لا تغيير في منطق الحفظ أو المسودات.

## ما لن يتم فعله
- لا Fix Error تلقائي، لا أسرار يدوية، لا تدوير مفاتيح، لا migrations، لا تعديل قاعدة بيانات، لا إعدادات مشروع، لا GitHub، لا نشر إنتاج.

## التحقق بعد التنفيذ
- تشغيل typecheck: صفر أخطاء.
- سجل أخطاء المعاينة: لا `SUPABASE_SERVICE_ROLE_KEY` ولا `Maximum update depth`.
- تقرير: MANAGED_SECRETS_REBOUND / PREVIEW_RESTARTED / SUPABASE_SERVICE_ROLE_KEY_AVAILABLE / ERROR_GONE / CODE_CHANGED (فقط mail.tsx للجزئين B وC) / SECRET_VALUE_CHANGED: لا / DATABASE_CHANGED: لا.
