# معمارية وآلية عمل المشروع (Lovable + GitHub + External Server)

## 1. المقدمة

هذا المستند يشرح للمطور المحترف كيفية عمل النظام بالكامل، من التعديل في Lovable إلى التخزين والنشر على السيرفر الخارجي.

النظام يتكون من ثلاثة أجزاء رئيسية:
1. **Lovable** — بيئة التطوير المرئية (Frontend + Backend Serverless).
2. **GitHub** — مستودع التعليمات البرمجية المركزي (Single Source of Truth).
3. **External Server (VPS)** — سيرفر Node.js خارجي يدير البروتوكولات غير المدعومة في بيئة Lovable (مثل IMAP/SMTP).

---

## 2. المكونات الرئيسية

### 2.1 Lovable (Frontend)

- **التقنية:** TanStack Start + React + Vite + Tailwind CSS.
- **الموقع:** يُنشر تلقائيًا على `https://reemail.lovable.app` (أو عنوان مشروعك).
- **المهام:**
  - عرض واجهة المستخدم.
  - استدعاء Server Functions (APIs) داخل Lovable أو سيرفر خارجي.
  - التنقل، الأزرار، القوائم، الجداول، إلخ.

### 2.2 GitHub (Code Repository)

- **الدور:** مستودع مركزي لكل التعليمات البرمجية.
- **الآلية:** يتم ربط المشروع بمستودع GitHub، وكل تعديل في Lovable يُدفع تلقائيًا إلى GitHub.
- **الفائدة:** يمكن للمطورين العمل على الكود محليًا، ثم دفع التعديلات إلى GitHub، فتظهر في Lovable.

### 2.3 External Server (VPS)

- **التقنية:** Node.js + TypeScript + Express/Fastify (أو أي إطار تفضله).
- **الموقع:** يعمل على `https://mailmaestro.reemsoft.com` (السيرفر الخاص بك).
- **المهام:**
  - التواصل المباشر مع خوادم البريد عبر IMAP/SMTP.
  - تنفيذ العمليات التي تحتاج اتصال TCP خام.
  - استقبال طلبات Lovable عبر HTTPS API.

---

## 3. آلية التعديل والمزامنة

### 3.1 التعديل في Lovable

عندما تقوم بالتعديل في Lovable (إما عبر الشات أو المحرر):

1. Lovable يُعدّل الملفات في `src/`.
2. يُنشئ Lovable commit جديد.
3. يدفع التعديلات تلقائيًا إلى GitHub.
4. يُعيد بناء ونشر Frontend على `reemail.lovable.app`.

### 3.2 التعديل في GitHub (أو محليًا)

إذا عدّلت الكود في GitHub مباشرة أو محليًا ثم دفعت `git push`:

1. GitHub يستقبل التعديلات.
2. Lovable يراقب المستودع ويستورد التغييرات.
3. يُعيد بناء ونشر Frontend.

### 3.3 التعديل في السيرفر الخارجي (Bridge)

عندما يكون التعديل في `bridge/` (الكود الذي يعمل على VPS):

1. Lovable يدفع التعديل إلى GitHub (نفس المستودع).
2. أنت تذهب إلى السيرفر الخارجي وتشغل:
   ```bash
   cd /home/reemsoft/mailmaestro
   git pull
   cd bridge
   npm run build
   pm2 restart mailmaestro-bridge --update-env
   ```
3. السيرفر يستقبل التعديلات ويُعيد تشغيل الخدمة.

> **ملاحظة:** Lovable **لا ينشر** الـ Bridge تلقائيًا. أنت تتحكم بالسيرفر الخارجي يدويًا أو عبر CI/CD.

---

## 4. أين تُخزّن البيانات؟

### 4.1 بيانات المستخدمين والتطبيق

- **Lovable Cloud / Supabase:** قاعدة البيانات PostgreSQL.
- الجداول الحالية:
  - `profiles` — معلومات المستخدمين.
  - `mail_accounts` — حسابات البريد الفردية.
  - `email_domains` — إعدادات الدومينات المشتركة.
- **مكان الاستضافة:** على Supabase (Lovable Cloud).
- **الأمان:** يتم التحكم بالوصول عبر RLS (Row Level Security).

### 4.2 كلمات مرور البريد الإلكتروني

- **لا تُخزّن في قاعدة البيانات.**
- تُحفظ فقط في **ذاكرة الجلسة** (Session Memory) في المتصفح أو في السيرفر الخارجي أثناء الاتصال فقط.
- هذا يسمى **Zero-Storage Security** ويقلل من مخاطر تسريب كلمات المرور.

### 4.3 الملفات والمستندات

- إذا كان التطبيق يرفع ملفات، يمكن استخدام:
  - Supabase Storage (Lovable Cloud).
  - S3 أو أي خدمة تخزين خارجية.
- لا تُخزّن الملفات على قرص السيرفر الخارجي إلا بشكل مؤقت.

### 4.4 إعدادات السيرفر الخارجي

- تُخزّن في ملف `.env` على السيرفر:
  ```bash
  MAIL_BRIDGE_SECRET=<server-managed-secret>
  HOST=127.0.0.1
  PORT=3001
  ```
- **لا تُضمّن أي قيمة سرية في GitHub أو التوثيق.**
- تُدار القيم السرية يدويًا في بيئة Lovable Secrets وعلى السيرفر.
- لتدوير مفتاح الـ Bridge بدون قطع الطلبات الحالية: أضف المفتاح الجديد مؤقتًا على السيرفر كـ `BRIDGE_API_KEY_NEXT`، انقل `MAIL_BRIDGE_SECRET` في Lovable إلى المفتاح الجديد، ثم بعد التأكد من الانتقال اجعل الجديد هو `BRIDGE_API_KEY` واحذف قيمة rollover.

---

## 5. كيفية التواصل بين الأجزاء

### 5.1 من المتصفح إلى Lovable

```
Browser → https://reemail.lovable.app → Lovable Frontend
```

### 5.2 من Lovable إلى السيرفر الخارجي

```
Lovable Server Function → https://mailmaestro.reemsoft.com/api/... → Bridge Server
```

- Lovable يرسل طلب HTTPS مع Header `Authorization: Bearer <MAIL_BRIDGE_SECRET>`.
- Bridge يتحقق من السر، ثم يفتح اتصال IMAP/SMTP مع Gmail/Outlook/سيرفر البريد.
- يرجع النتيجة إلى Lovable، ثم إلى المتصفح.

### 5.3 لماذا لا يتواصل Lovable مباشرة مع IMAP؟

- بيئة Lovable / Cloudflare Workers لا تدعم فتح اتصالات TCP خام.
- IMAP وSMTP يحتاجان اتصال TCP مباشر وطويل الأمد.
- لذلك نستخدم سيرفر خارجي كوسيط (Proxy/Bridge).

---

## 6. خطوة بخطوة: تعديل واقعي

### السيناريو: إضافة زر "تحويل إلى مزعج" في واجهة البريد

#### الخطوة 1: التعديل في الواجهة (Lovable)

- نضيف زر "Spam" في قائمة الإجراءات في `src/routes/mail.tsx`.
- Lovable يدفع التعديل إلى GitHub.
- Lovable ينشر الواجهة تلقائيًا.

#### الخطوة 2: التعديل في الـ Bridge (إذا لزم الأمر)

- إذا كان الزر يحتاج أمر IMAP حقيقي (نقل الرسالة إلى مجلد Spam)، نعدّل `bridge/src/imap.ts`.
- Lovable يدفع التعديل إلى GitHub.
- نذهب إلى السيرفر ونشغل:
  ```bash
  cd /home/reemsoft/mailmaestro && git pull && cd bridge && npm run build && pm2 restart mailmaestro-bridge --update-env
  ```

#### الخطوة 3: الاختبار

- نفتح `https://reemail.lovable.app/mail`.
- نختبر الزر على رسالة حقيقية.
- نتحقق من الـ Network logs في المتصفح.

---

## 7. هيكل الملفات

```
reemail/
├── src/                        # كود Lovable (Frontend + Server Functions)
│   ├── routes/                 # صفحات التطبيق
│   │   ├── mail.tsx            # صفحة البريد
│   │   ├── _authenticated/     # صفحات تحتاج تسجيل دخول
│   │   └── api/                # Server Routes (APIs داخل Lovable)
│   ├── lib/                    # دوال مشتركة
│   │   ├── client-mail.functions.ts  # Server Functions للتواصل مع Bridge
│   │   └── ...
│   ├── integrations/           # Supabase client وغيره
│   └── styles.css              # التنسيقات
├── bridge/                     # كود السيرفر الخارجي (Node.js)
│   ├── src/
│   │   ├── index.ts            # نقطة دخول السيرفر
│   │   ├── imap.ts             # التواصل مع IMAP
│   │   └── smtp.ts             # التواصل مع SMTP
│   ├── package.json
│   ├── tsconfig.json
│   └── .env                    # أسرار السيرفر (غير مضمنة في GitHub)
├── supabase/
│   └── migrations/             # ملفات تغيير قاعدة البيانات
├── SYSTEM-REFERENCE.md         # توثيق النظام التقني
├── DOCUMENTATION.md            # توثيق المستخدم العام
└── ARCHITECTURE-WORKFLOW.md    # هذا الملف
```

---

## 8. الأمان

### 8.1 بين Lovable والBridge

- يستخدم `MAIL_BRIDGE_SECRET` للتحقق من الطلبات.
- يجب أن يكون السيرفر الخارجي يستمع فقط على `127.0.0.1` ( behind Apache/Nginx Reverse Proxy).
- لا يُسمح للطلبات الخارجية بالوصول إلى Bridge مباشرة.

### 8.2 في قاعدة البيانات

- RLS مُفعّل على جميع الجداول الحساسة.
- لا يمكن للمستخدم قراءة/تعديل بيانات مستخدم آخر.

### 8.3 في كلمات المرور

- كلمات مرور البريد لا تُخزّن أبدًا.
- تُستخدم فقط أثناء الجلسة ثم تُتجاهل.

---

## 9. أفضل الممارسات

### 9.1 للواجهة (Lovable)

- دع التصميم والتجربة المستخدم لـ Lovable.
- استخدم Server Functions للتواصل مع APIs.
- لا تضع أسرار في كود الواجهة.
- استخدم `useEffect` للقراءات من المتصفح فقط.

### 9.2 للسيرفر الخارجي (Bridge)

- اكتب الـ API بوضوح وثَبّت العقود (API Contract).
- استخدم Zod أو Joi للتحقق من المدخلات.
- اكتب اختبارات وحدة (Unit Tests) للمنطق المعقد.
- استخدم `pm2` أو `systemd` لإدارة العملية.
- افصل ملف `.env` عن GitHub.

### 9.3 للقاعدة البيانات

- أي تعديل في المخطط يتم عبر Migration.
- لا تُعدّل الجداول يدويًا.
- اختبر RLS دائمًا بعد تغيير السياسات.

### 9.4 للنشر

- Frontend: انشر من Lovable.
- Bridge: استخدم `git pull && npm run build && pm2 restart`.
- أفضل: استخدم GitHub Actions أو CI/CD لتنفيذ الأمر تلقائيًا عند `git push`.

---

## 10. CI/CD مقترح (اختياري متقدم)

يمكنك أتمتة نشر الـ Bridge عندما تدفع إلى GitHub:

```yaml
# .github/workflows/deploy-bridge.yml (مثال)
name: Deploy Bridge
on:
  push:
    branches: [main]
    paths: ['bridge/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /home/reemsoft/mailmaestro
            git pull
            cd bridge
            npm ci
            npm run build
            pm2 restart mailmaestro-bridge --update-env
```

> **ملاحظة:** يتطلب هذا إضافة `VPS_HOST` و`VPS_USER` و`VPS_SSH_KEY` إلى Secrets في GitHub.

---

## 11. ملخص سريع

| الجزء | التقنية | المكان | كيف يُحدَّث | دوره |
|-------|---------|--------|-------------|------|
| الواجهة | React + TanStack | Lovable | تلقائيًا من Lovable أو GitHub | عرض UI |
| Server Functions | TanStack Start | Lovable | تلقائيًا | APIs داخلية |
| قاعدة البيانات | PostgreSQL | Lovable Cloud | عبر Migrations | تخزين البيانات |
| Bridge | Node.js | VPS | يدويًا أو CI/CD | IMAP/SMTP + Heavy Logic |
| الكود | TypeScript | GitHub | Two-way sync | المصدر المركزي |

---

## 12. الخلاصة

هذه المعمارية تسمح لك ببناء تطبيقات حقيقية ومعقدة (مثل ERP أو CRM أو Email Client) باستخدام Lovable كمسرع للواجهة، مع الاحتفاظ بالتحكم الكامل في البيانات والمنطق والبروتوكولات على السيرفر الخارجي.

القاعدة الذهبية:
> **Lovable للواجهة، GitHub للكود، والسيرفر الخارجي للدماغ والقلب.**
