# توثيق MailMaestro التقني

> هذا الملف يشرح كيف بُني التطبيق من الصفر: البنية المعمارية، التقنيات، طريقة الربط بين Lovable و GitHub و السيرفر (VPS/WHM)، ومحرك البريد الحقيقي (Node.js Bridge). كل ما جاء هنا هو **الأساس الثابت** — أي تطوير لاحق يُبنى فوقه.

---

## 1) نظرة عامة على المعمارية

التطبيق SaaS متعدد المستأجرين (Multi-Tenant) لفتح أي حساب بريد عبر IMAP/SMTP بواجهة حديثة شبيهة بـ Gmail. يتكون من **جزأين منفصلين** يعملان معاً:

```
┌──────────────────────────────┐          ┌─────────────────────────────────┐
│  Lovable (Cloudflare Worker) │          │  VPS + WHM (Node.js Bridge)     │
│  ──────────────────────────  │  HTTPS   │  ─────────────────────────────  │
│  • واجهة React + TanStack    │◄────────►│  • ImapFlow (IMAP)              │
│  • Supabase (DB + Auth)      │  + Key   │  • Nodemailer (SMTP)            │
│  • Server Functions          │          │  • mailparser                    │
│  • كل المنطق عدا TCP الخام    │          │  • Express API محمي بمفتاح       │
└──────────────────────────────┘          └─────────────────────────────────┘
     reemail.lovable.app                     mailmaestro.reemsoft.com
```

### لماذا جزءان؟
Cloudflare Workers **لا يدعم اتصالات TCP الخام** المطلوبة لـ IMAP/SMTP. لذلك يستحيل تشغيل محرك البريد داخل Lovable وحدها. الحل الوحيد الصحيح: خادم Node.js صغير مستقل يعمل كـ "جسر" (Bridge) بين Lovable وخوادم البريد.

---

## 2) التقنيات المستخدمة

### الواجهة (Frontend في Lovable)
| التقنية | الاستخدام |
|--------|-----------|
| **TanStack Start v1** | إطار Full-Stack React مع SSR والتوجيه المبني على الملفات |
| **Vite 7** | أداة البناء |
| **React 19 + TypeScript** | مكونات الواجهة |
| **Tailwind CSS v4** | التصميم (عبر `src/styles.css` بدون `tailwind.config.js`) |
| **shadcn/ui + Radix** | مكونات UI جاهزة |
| **TanStack Query** | جلب البيانات وإدارة الكاش |
| **IBM Plex Sans Arabic** | الخط الأساسي (عربي + إنجليزي) |

### الخلفية (Lovable Cloud = Supabase)
| المكوّن | الاستخدام |
|---------|-----------|
| **Supabase Postgres** | قاعدة البيانات (شركات، مستخدمون، أدوار، إعدادات بريد) |
| **Supabase Auth** | تسجيل الدخول |
| **RLS (Row Level Security)** | حماية الصفوف حسب الدور والشركة |
| **Server Functions** (`createServerFn`) | كل منطق الخلفية الآمن |

### محرك البريد (Bridge على VPS)
| المكتبة | الترخيص | الوظيفة |
|---------|---------|---------|
| **ImapFlow** | MIT | عميل IMAP حديث وسريع |
| **Nodemailer** | MIT-0 | إرسال SMTP |
| **mailparser** | MIT | تحليل MIME والمرفقات |
| **Express + Zod** | MIT | REST API محمي |
| **PM2** | AGPL | إدارة العملية (auto-restart, logs) |

---

## 3) بنية الملفات الأساسية

```
├── src/                              ← تطبيق Lovable (Frontend + Server Functions)
│   ├── routes/
│   │   ├── __root.tsx                ← Layout الرئيسي + خطوط + Meta
│   │   ├── index.tsx                 ← الصفحة الرئيسية التسويقية
│   │   ├── login.tsx                 ← تسجيل الدخول
│   │   ├── mail.tsx                  ← واجهة البريد (Gmail-like)
│   │   ├── company.tsx               ← لوحة تحكم Company Admin
│   │   └── _authenticated/           ← مسارات محمية (تتطلب جلسة)
│   │
│   ├── lib/
│   │   ├── mail-types.ts             ← الأنواع المشتركة (Message, Folder…)
│   │   ├── mail-session.ts           ← تخزين كلمة مرور البريد في الذاكرة فقط
│   │   ├── mail-bridge.functions.ts  ← Server Functions تنادي Bridge
│   │   ├── client-mail.functions.ts  ← Server Functions للواجهة (يستدعيها React)
│   │   ├── company-admin.functions.ts← إدارة الشركات والعملاء
│   │   ├── admin-signup.functions.ts ← إنشاء Super Admin
│   │   └── mail-mock.ts              ← بيانات وهمية للتجربة قبل ربط Bridge
│   │
│   ├── integrations/supabase/        ← عميل Supabase (auto-generated)
│   ├── styles.css                    ← Tailwind v4 + متغيرات الألوان
│   └── server.ts                     ← Entry point لـ Cloudflare Worker
│
├── bridge/                           ← خادم Node.js المنفصل (يُنشر على VPS)
│   ├── src/
│   │   ├── index.ts                  ← Express API (يستمع على 127.0.0.1:3001)
│   │   ├── imap.ts                   ← كل عمليات IMAP (list, fetch, flag…)
│   │   ├── smtp.ts                   ← إرسال البريد
│   │   └── types.ts                  ← أنواع مشتركة
│   ├── .env                          ← BRIDGE_API_KEY + HOST + PORT
│   └── package.json
│
└── supabase/                         ← Migrations لقاعدة البيانات
```

---

## 4) نموذج البيانات (Multi-Tenant)

| الجدول | الوصف |
|--------|-------|
| `companies` | كل شركة مستأجرة (اسم، شعار، ألوان، subdomain) |
| `profiles` | مرتبط بـ `auth.users`، يحمل `company_id` |
| `user_roles` | **جدول منفصل** للأدوار (`super_admin`/`company_admin`/`end_user`) — لا يوضع الدور في `profiles` أبداً لتفادي هجمات رفع الصلاحيات |
| `mail_accounts` | إعدادات IMAP/SMTP لكل عميل (بدون كلمة المرور) |

**RLS مفعّل على كل الجداول.** الوصول للأدوار عبر دالة `SECURITY DEFINER` باسم `has_role()` لتفادي الحلقات المتكررة.

### قرار أمني حرج
كلمات مرور البريد **لا تُحفظ في قاعدة البيانات أبداً**. تُخزَّن فقط في ذاكرة الجلسة (`src/lib/mail-session.ts`) طوال مدة تسجيل الدخول، ثم تُمحى. هذا يعني أن أي اختراق للـ DB لن يكشف أي حساب بريد.

---

## 5) الأدوار الثلاثة

| الدور | من هو | ماذا يفعل |
|-------|-------|-----------|
| **Super Admin** | مالك المنصة | إدارة كل الشركات والاشتراكات |
| **Company Admin** | العميل المشترك | يرفع شعار شركته، ألوانها، يضيف موظفيه |
| **End User** | موظف الشركة | يفتح بريده ويستخدم الواجهة بشعار شركته |

---

## 6) محرك البريد Bridge — كيف يعمل

### الفكرة
Bridge خادم Express صغير (~200 سطر) يعرض REST API محمي بمفتاح واحد (`X-Bridge-Key`). كل طلب:
1. يستقبل بيانات الحساب + كلمة المرور من Lovable.
2. يفتح جلسة IMAP/SMTP مؤقتة عبر ImapFlow/Nodemailer.
3. ينفذ العملية (list, fetch, send…).
4. يُغلق الاتصال ويعيد النتيجة كـ JSON.

### النقاط النهائية (Endpoints)
| Endpoint | الوظيفة |
|----------|---------|
| `GET /health` | فحص الحياة (بدون مصادقة) |
| `POST /api/verify` | التحقق من صحة بيانات IMAP |
| `POST /api/folders` | جلب أعداد الرسائل في كل مجلد |
| `POST /api/messages` | قائمة الرسائل (مع limit/offset) |
| `POST /api/message` | محتوى رسالة كامل + مرفقات |
| `POST /api/mark-read` | تعليم مقروء/غير مقروء |
| `POST /api/star` | نجمة/إزالة |
| `POST /api/move` | نقل بين المجلدات |
| `POST /api/delete` | حذف/نقل للمهملات |
| `POST /api/send` | إرسال عبر SMTP |

### التحسين الرئيسي
`getMessages` في `bridge/src/imap.ts` تجلب **UID + envelope + flags + bodyStructure في تمريرة واحدة** بدل تمريرتين — هذا سرّ سرعة الواجهة.

---

## 7) طريقة الربط بين Lovable و Bridge

```
React Component
      │
      ▼
useServerFn(getInbox)                          ← في Lovable (client)
      │
      ▼
createServerFn (client-mail.functions.ts)      ← يعمل داخل Cloudflare Worker
      │
      ▼
mail-bridge.functions.ts (fetch)               ← يبني الطلب + المفتاح
      │
      ▼ HTTPS
https://mailmaestro.reemsoft.com/api/messages
      │
      ▼
Apache Reverse Proxy → 127.0.0.1:3001          ← على VPS
      │
      ▼
Node.js Bridge (Express + ImapFlow)
      │
      ▼ IMAPS/TLS
خادم البريد الحقيقي (Gmail/cPanel/Outlook…)
```

### الأسرار (Secrets) في Lovable
| الاسم | القيمة |
|-------|--------|
| `MAIL_BRIDGE_URL` | `https://mailmaestro.reemsoft.com` |
| `MAIL_BRIDGE_SECRET` | مفتاح 64 حرف hex (نفسه في `.env` على السيرفر) |

كلاهما يُقرأ فقط داخل Server Functions عبر `process.env` — لا يظهران أبداً في الـ browser.

---

## 8) نشر Bridge على VPS + WHM

### المتطلبات
- VPS فيه WHM/cPanel
- Node.js 20+ عبر `nvm`
- Subdomain (مثال: `mailmaestro.reemsoft.com`)
- شهادة SSL عبر **AutoSSL** من WHM

### خطوات النشر (تلخيص لما فعلناه فعلاً)

**1. تثبيت Node عبر nvm:**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
```

**2. سحب الكود من GitHub:**
```bash
cd /home/reemsoft/
git clone https://github.com/USER/REPO.git mailmaestro
cd mailmaestro/bridge
npm install
npm run build
```

**3. ملف `.env` مع صلاحيات صارمة:**
```bash
cat > .env <<EOF
BRIDGE_API_KEY=<64-hex-key>
HOST=127.0.0.1
PORT=3001
EOF
chmod 600 .env
```

**4. تشغيل دائم عبر PM2:**
```bash
npm install -g pm2
pm2 start dist/index.js --name mailmaestro-bridge --update-env
pm2 save
pm2 startup   # نفّذ الأمر الذي يظهر
```

**5. Apache Reverse Proxy عبر Per-VirtualHost Userdata Includes** (الطريقة الرسمية من cPanel):
```bash
mkdir -p /etc/apache2/conf.d/userdata/std/2_4/reemsoft/mailmaestro.reemsoft.com/
mkdir -p /etc/apache2/conf.d/userdata/ssl/2_4/reemsoft/mailmaestro.reemsoft.com/

cat > /etc/apache2/conf.d/userdata/std/2_4/reemsoft/mailmaestro.reemsoft.com/proxy.conf <<'EOF'
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:3001/
ProxyPassReverse / http://127.0.0.1:3001/
EOF

# نفس الملف في مسار ssl/

/scripts/ensure_vhost_includes --user=reemsoft
/scripts/restartsrv_httpd
```

**6. إصدار شهادة SSL:**
من WHM → SSL/TLS → Manage AutoSSL → Run AutoSSL على المستخدم `reemsoft`.

### التحقق النهائي
```bash
curl https://mailmaestro.reemsoft.com/health
# → {"status":"ok","timestamp":"..."}

ss -tlnp | grep 3001
# → 127.0.0.1:3001  ← لا يجب أن يظهر 0.0.0.0

curl -sw "%{http_code}\n" http://<PUBLIC_IP>:3001/health
# → 000  ← أي أن المنفذ محجوب من الخارج
```

---

## 9) الأمان (مراجعة نهائية لما طبّقناه)

| الطبقة | الحماية |
|--------|---------|
| Bridge | يستمع على `127.0.0.1` فقط — لا يمكن الوصول له من الإنترنت مباشرة |
| Apache | يستقبل HTTPS فقط ويمرره داخلياً |
| المصادقة | كل طلب يحتاج `X-Bridge-Key` (64 حرف hex) — بدونه 401 |
| `.env` | صلاحيات `chmod 600` (المالك فقط) |
| كلمات المرور | لا تُحفظ أبداً — في الذاكرة فقط طوال الجلسة |
| Supabase | RLS مفعّل على كل جدول + `has_role()` آمن |
| Lovable Secrets | `MAIL_BRIDGE_SECRET` مخزن في Server env — لا يصل للـ browser |
| الاستهلاك | Bridge ~16MB RAM في الاستخدام العادي |

---

## 10) الربط مع GitHub

Lovable مربوطة بمستودع GitHub مع **مزامنة ثنائية الاتجاه**:

- كل تعديل في Lovable → commit تلقائي إلى GitHub.
- كل push إلى GitHub → مزامنة تلقائية إلى Lovable.
- على VPS: نستخدم `git pull` لسحب أي تحديث ثم `npm run build && pm2 restart mailmaestro-bridge --update-env`.

### دورة تحديث Bridge كاملة
```bash
cd /home/reemsoft/mailmaestro
git pull
cd bridge
npm install     # فقط إذا تغيّرت التبعيات
npm run build
pm2 restart mailmaestro-bridge --update-env
pm2 logs mailmaestro-bridge --lines 30
```

---

## 11) الأداء

- **Bridge**: تمريرة IMAP واحدة لجلب كل بيانات القائمة → الرسائل تظهر خلال أقل من ثانية.
- **Lovable**: SSR + TanStack Query → أول رسم فوري، والتحديثات لاحقاً عبر الكاش.
- **الخط**: IBM Plex Sans Arabic (ملف واحد للعربي والإنجليزي) بدلاً من ملفين.
- **Cloudflare Worker**: زمن استجابة عالمي ممتاز؛ كل الطلبات تصل Bridge خلال ~50ms من أي مكان.

---

## 12) خطوات التطوير المستقبلي (فوق هذا الأساس)

كل ما يُضاف لاحقاً هو **تحسين**، لا إعادة بناء:
- كاش Redis على Bridge لتقليل زيارات IMAP.
- WebSocket / Server-Sent Events للتحديث الفوري.
- بحث full-text في الرسائل.
- توقيعات، فلاتر، قواعد تلقائية.
- تطبيقات موبايل (React Native) تستخدم نفس Bridge.
- خطط اشتراك عبر Stripe.

**البنية جاهزة لكل ذلك بدون تغيير في المعمارية.**

---

## 13) مرجع سريع للأوامر

```bash
# حالة Bridge
pm2 status
pm2 logs mailmaestro-bridge --lines 50
pm2 restart mailmaestro-bridge --update-env

# فحص المنفذ
ss -tlnp | grep 3001

# اختبار صحة
curl https://mailmaestro.reemsoft.com/health

# اختبار مصادقة (يجب 401 بدون مفتاح)
curl -X POST https://mailmaestro.reemsoft.com/api/folders
```

---

_آخر تحديث: يوليو 2026 — هذا الملف يوثّق الأساس الكامل الذي بُني وأصبح إنتاجياً._
