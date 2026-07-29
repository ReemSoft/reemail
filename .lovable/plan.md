## الهدف
دعم لغتين (AR/EN) في كامل واجهة MailMaestro مع اتجاه ديناميكي وكشف تلقائي، بدون لمس Bridge أو VPS أو منطق العمل.

## القرارات المعتمدة
- **المكتبة:** `i18next` + `react-i18next` + `i18next-browser-languagedetector`
- **الكشف:** المتصفح أولاً (`navigator.language`) ثم `localStorage` (يتذكر الاختيار اليدوي)
- **الاتجاه:** EN → LTR / AR → RTL (تبديل تلقائي على `<html lang dir>`)
- **النطاق:** كل نصوص الواجهة + إشعارات toast + رسائل الأخطاء المُنشأة من الفرونت. محتوى الإيميلات وأخطاء Bridge تبقى كما هي.

## البنية
```
src/i18n/
  ├── index.ts           ← تهيئة i18next + كاشف اللغة
  ├── locales/ar.json    ← المصدر الحالي (استخراج من الكود)
  └── locales/en.json    ← الترجمة الإنجليزية
src/hooks/use-language.ts ← hook للتبديل + تحديث dir/lang
src/components/language-switcher.tsx ← زر AR/EN في الهيدر
```

## الخطوات

### 1. البنية التحتية (ملف واحد)
- تثبيت الحزم: `i18next react-i18next i18next-browser-languagedetector`
- إنشاء `src/i18n/index.ts` مع lazy loading للـ namespaces (`common`, `mail`, `auth`, `dashboard`, `company`)
- تحميل i18n في `__root.tsx` وربط `<html lang dir>` بحالة اللغة عبر `useEffect`
- إبقاء AR كلغة افتراضية (fallback) للحفاظ على السلوك الحالي

### 2. استخراج النصوص وتنظيمها بـ namespaces
- `common.json` — أزرار عامة، تأكيدات، رسائل شائعة (~40 مفتاح)
- `auth.json` — login.tsx + رسائل المصادقة (~25)
- `mail.json` — mail.tsx (الأكبر، ~180 مفتاح: مجلدات، composer، actions، toasts)
- `dashboard.json` — لوحة تحكم الشركة (~50)
- `company.json` — صفحة الشركة العامة (~20)
- `index.json` — الصفحة الرئيسية (~30)

### 3. تحويل المكونات
استخدام `useTranslation(ns)` واستبدال النصوص الحرفية بـ `t('key')`. الأولوية:
1. `__root.tsx`, `login.tsx`, `index.tsx` — واجهات الدخول
2. `mail.tsx` (الأكبر) — يُقسم داخلياً: Sidebar → Toolbar → MessageView → Composer → Toasts
3. `dashboard.tsx`, `company.tsx`
4. `components/ui/confirm-provider.tsx` وأي مكونات ui فيها نص عربي

### 4. مبدّل اللغة
- زر مدمج `AR | EN` في الهيدر (mail + dashboard)
- عند التبديل: حفظ في localStorage، تحديث `document.documentElement.lang/dir` فوراً، بدون إعادة تحميل

### 5. التحقق
- تشغيل جميع الاختبارات (376+)
- فحص بصري: تبديل AR↔EN في mail/dashboard/login والتأكد من انعكاس التخطيط
- التأكد من عدم كسر IBM Plex Sans Arabic — إضافة `Inter` fallback للإنجليزية

## ملاحظات الأداء
- Namespaces مقسّمة → لا نُحمّل mail.json في صفحة login
- ملفات JSON مُدمجة في bundle (ليست HTTP) → صفر latency
- تبديل اللغة فوري بدون إعادة تحميل الصفحة
- حجم إضافي إجمالي متوقع: ~18KB gzipped (i18next + resources)

## ما لن يُلمَس
- Bridge (`bridge/**`) — رسائل الخطأ منه تبقى كما ترد
- منطق IMAP/SMTP/Sync
- Schema قاعدة البيانات
- محتوى الرسائل نفسها (HTML من المرسل)

## معيار النجاح
`I18N_AR_EN_READY_AND_PUBLISHED` — كامل الواجهة تعمل بلغتين، الاتجاه ديناميكي، الاختبارات خضراء، النشر على Lovable ناجح.
