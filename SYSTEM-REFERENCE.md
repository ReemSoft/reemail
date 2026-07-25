# مرجع النظام الشامل — MailMaestro

> ملف مرجعي كامل لكل مكونات نظام MailMaestro: من الواجهة إلى قاعدة البيانات إلى البريدج على VPS.
> **الغرض**: عند أي عطل أو حذف أو استعادة، هذا الملف هو المرجع الأول لإعادة بناء النظام دون تخمين.
> آخر تحديث: 2026-07-25 — تم تجميع كل القيم من فحص فعلي حي للسيرفر والكود.

---

## 1. نظرة عامة على المعمارية

نظام MailMaestro هو تطبيق SaaS لعميل بريد إلكتروني عالي الأداء، متعدد المستأجرين (multi-tenant)، يُمكّن المستخدم من الاتصال بأي حساب بريد عبر IMAP/SMTP دون تخزين كلمة المرور في قاعدة البيانات.

```text
┌───────────────────────┐        HTTPS         ┌──────────────────────────┐
│  المتصفح (React SPA)   │ ───────────────────► │  Lovable Cloud Worker    │
│  reemail.lovable.app   │  ◄─────────────────  │  (TanStack Start SSR)    │
└───────────────────────┘   Server Functions   └────────────┬─────────────┘
                                                             │
                                                             │  HTTPS + X-API-Key
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │ mailmaestro.reemsoft.com     │
                                              │ Apache Reverse Proxy (WHM)   │
                                              └────────────┬─────────────────┘
                                                             │ 127.0.0.1:3001
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │ Node.js Bridge (PM2 process) │
                                              │ IMAPFlow + Nodemailer        │
                                              └────────────┬─────────────────┘
                                                             │
                                                     IMAP/SMTP TLS
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │ سيرفرات البريد للعميل         │
                                              │ (Gmail / cPanel / Outlook…)  │
                                              └──────────────────────────────┘

              ┌──────────────────┐             ┌──────────────────────────┐
              │ Supabase (Cloud) │◄───────────►│ Auth + Database (RLS)    │
              └──────────────────┘             └──────────────────────────┘
```

**نموذج الأمان الأساسي (لا يجب المساس به):**
- إعدادات الخوادم (IMAP/SMTP host, port, security) تُخزَّن في قاعدة البيانات.
- **كلمة مرور البريد لا تُخزَّن أبداً في قاعدة البيانات** — تعيش فقط في ذاكرة الجلسة (`src/lib/mail-session.ts`) وتُرسَل مع كل طلب إلى البريدج.
- كل استدعاء بريدج يمر بمصادقة `X-API-Key` (سر مشترك 64 حرف hex).
- البريدج يستمع فقط على `127.0.0.1:3001` — لا يمكن الوصول إليه من الإنترنت مباشرة، فقط عبر Apache proxy على HTTPS.

---

## 2. المكونات الرئيسية

### 2.1 الواجهة الأمامية + Backend (Lovable)
| العنصر | القيمة |
|---|---|
| المنصة | Lovable Cloud (Cloudflare Worker) |
| Framework | TanStack Start v1 (React 19 + Vite 7) |
| Styling | Tailwind CSS v4 |
| Font | IBM Plex Sans Arabic (300–700) |
| Preview URL | `https://id-preview--da2f05fb-8851-4f2f-9914-d1405b6cdf1d.lovable.app` |
| Published URL | `https://reemail.lovable.app` |
| Project ID | `da2f05fb-8851-4f2f-9914-d1405b6cdf1d` |

### 2.2 قاعدة البيانات + المصادقة (Supabase عبر Lovable Cloud)
جداول Public schema:
- `companies` — الشركات (المستأجرون)
- `profiles` — بيانات المستخدمين المرتبطة بـ `auth.users`
- `user_roles` — الأدوار (admin/user) مع `has_role()` security definer
- `mail_accounts` — إعدادات IMAP/SMTP لكل مستخدم (بدون كلمة سر)

Functions:
- `handle_new_user()` — trigger عند إنشاء مستخدم لملء `profiles`
- `set_updated_at()` — trigger عام لتحديث `updated_at`

### 2.3 السيرفر (VPS/WHM) — البريدج
| العنصر | القيمة |
|---|---|
| النظام | AlmaLinux 8.10 (`server1.reemsoft.com`) |
| Node.js | v20.20.2 (عبر nvm) |
| npm | 10.8.2 |
| PM2 | 7.0.3 |
| Subdomain | `mailmaestro.reemsoft.com` (cPanel account: `reemsoft`) |
| مسار البريدج | `/home/reemsoft/mailmaestro/bridge` |
| مسار PM2 dump | `/root/.pm2/dump.pm2` |
| PM2 process name | `mailmaestro-bridge` (id=0, user=root, fork mode) |
| Script path | `/home/reemsoft/mailmaestro/bridge/dist/index.js` |
| Binding | `127.0.0.1:3001` (لا يُقبل ترافيك خارجي مباشر) |
| GitHub Repo | `https://github.com/ReemSoft/reemail.git` (branch: `main`) |

---

## 3. الأسرار (Secrets)

**في Lovable (Runtime secrets — متاحة داخل server functions):**
| اسم السر | الاستخدام |
|---|---|
| `MAIL_BRIDGE_URL` | `https://mailmaestro.reemsoft.com` — عنوان البريدج |
| `MAIL_BRIDGE_SECRET` | 64 حرف hex — يجب أن يطابق `BRIDGE_API_KEY` في `.env` على السيرفر |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` | إدارة Lovable |
| `LOVABLE_API_KEY` | Lovable AI Gateway |
| `BRIDGE_API_KEY` | نسخة قديمة (يمكن تجاهلها؛ الفعلي هو `MAIL_BRIDGE_SECRET`) |

**على VPS في `/home/reemsoft/mailmaestro/bridge/.env` (chmod 600):**
```
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
BRIDGE_API_KEY=<64-char-hex — يطابق MAIL_BRIDGE_SECRET في Lovable>
```

⚠️ **قاعدة ذهبية**: `BRIDGE_API_KEY` في `.env` = `MAIL_BRIDGE_SECRET` في Lovable. أي عدم تطابق ⇒ خطأ 401 عند تسجيل الدخول.
⚠️ **عند تغيير المفتاح**: يجب `pm2 delete mailmaestro-bridge` ثم `pm2 start dist/index.js --name mailmaestro-bridge --update-env` (لا يكفي restart لأنه يحتفظ بالـ env القديمة). وبعد تغيير `MAIL_BRIDGE_SECRET` في Lovable يجب **إعادة نشر** التطبيق ليأخذ Cloudflare Worker القيمة الجديدة.

---

## 4. هيكل المسارات (Routes)

### 4.1 مسارات الواجهة (`src/routes/`)
| المسار | الملف | الوصف |
|---|---|---|
| `/` | `index.tsx` | الصفحة الرئيسية التسويقية |
| `/company` | `company.tsx` | صفحة الشركة |
| `/login` | `login.tsx` | تسجيل الدخول للبريد (يدخل IMAP/SMTP) |
| `/mail` | `mail.tsx` | صندوق الوارد الرئيسي |
| `/dashboard` | `_authenticated/dashboard.tsx` | لوحة تحكم المصادقة |
| `/sitemap.xml` | `sitemap[.]xml.ts` | خريطة الموقع |
| `__root.tsx` | جذر التطبيق (font links + layout) |
| `_authenticated/route.tsx` | حارس مصادقة (يعيد التوجيه لـ `/auth` إن لم يكن مسجّلاً) |

### 4.2 Server Functions (`src/lib/`)
| الملف | المسؤولية |
|---|---|
| `mail-bridge.functions.ts` | استدعاءات بروكسي إلى بريدج VPS (verify/folders/messages/…) عبر `MAIL_BRIDGE_URL` + `MAIL_BRIDGE_SECRET` |
| `client-mail.functions.ts` | Server fns بواجهة العميل (تجميع/تنسيق قبل الإرجاع) |
| `mail-session.ts` | حفظ كلمة المرور في ذاكرة الجلسة فقط (لا DB) |
| `mail-types.ts` / `mail-mock.ts` | أنواع + بيانات تجريبية |

### 4.3 مسارات البريدج (Node.js على VPS)
كل المسارات (عدا `/health`) تتطلب `X-API-Key`:
| Method | Path | الوظيفة |
|---|---|---|
| GET | `/health` | فحص صحي (بدون مصادقة) |
| POST | `/api/verify` | التحقق من صحة إعدادات IMAP/SMTP |
| POST | `/api/folders` | جلب المجلدات (INBOX, Sent, …) |
| POST | `/api/messages` | جلب قائمة الرسائل في مجلد |
| POST | `/api/message` | جلب رسالة واحدة كاملة |
| POST | `/api/mark-read` | تعليم كمقروء/غير مقروء |
| POST | `/api/star` | نجمة |
| POST | `/api/move` | نقل بين مجلدات |
| POST | `/api/delete` | حذف |
| POST | `/api/send` | إرسال عبر SMTP |

ملاحظة: جميع مسارات `/api/*` هي POST؛ استخدام GET يعطي 404 (هذا سلوك صحيح، ليس عطلاً).

---

## 5. تدفق البيانات — من النقر إلى وصول الإيميل

**مثال: المستخدم يفتح `/mail` لأول مرة:**
1. المتصفح يحمّل `mail.tsx` من Lovable Worker.
2. المكوّن يستدعي server function `listMessages({folder: "INBOX"})` من `client-mail.functions.ts`.
3. Server function تقرأ كلمة المرور من `mail-session.ts` ثم تنادي `callBridge("/api/messages", {...})` من `mail-bridge.functions.ts`.
4. `callBridge` ترسل `POST https://mailmaestro.reemsoft.com/api/messages` مع header `X-API-Key: $MAIL_BRIDGE_SECRET`.
5. Apache على WHM يستقبل الطلب على 443، يفكّ SSL، ويعيد توجيهه إلى `http://127.0.0.1:3001/api/messages` (proxy.conf).
6. البريدج (Express) يتحقق من `X-API-Key`، ثم يفتح جلسة IMAP بـ IMAPFlow نحو سيرفر بريد المستخدم.
7. IMAPFlow يعمل FETCH لـ UID + envelope + bodyStructure في طلب واحد (تحسين السرعة).
8. النتيجة ترجع كـ JSON عبر نفس السلسلة عكسياً وتُعرض في الواجهة.

---

## 6. إعدادات البنية التحتية على VPS

### 6.1 Apache Reverse Proxy (WHM Per-VirtualHost Userdata)
مسار الملفات:
```
/etc/apache2/conf.d/userdata/std/2_4/reemsoft/mailmaestro.reemsoft.com/proxy.conf   # HTTP
/etc/apache2/conf.d/userdata/ssl/2_4/reemsoft/mailmaestro.reemsoft.com/proxy.conf   # HTTPS
```

محتوى HTTP:
```apache
ProxyRequests Off
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:3001/
ProxyPassReverse / http://127.0.0.1:3001/
```

محتوى HTTPS (يضيف forwarded proto):
```apache
ProxyRequests Off
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:3001/
ProxyPassReverse / http://127.0.0.1:3001/
RequestHeader set X-Forwarded-Proto "https"
```

**بعد أي تعديل**: `/scripts/ensure_vhost_includes --user=reemsoft && systemctl restart httpd`

### 6.2 PM2
```bash
cd /home/reemsoft/mailmaestro/bridge
pm2 start dist/index.js --name mailmaestro-bridge --update-env
pm2 save
pm2 startup systemd -u root --hp /root   # مرة واحدة فقط
```

### 6.3 SSL
AutoSSL في WHM يجدّد شهادة `mailmaestro.reemsoft.com` تلقائياً.

---

## 7. الربط مع GitHub

- المستودع: `https://github.com/ReemSoft/reemail.git`
- Lovable مرتبط بالمستودع (bidirectional sync): أي تعديل في Lovable يُدفع تلقائياً إلى `main`، وأي push إلى `main` يُسحب إلى Lovable.
- على VPS نجلب فقط عند نشر البريدج أو استرداده — لا يوجد CI/CD تلقائي على السيرفر.

---

## 8. إجراءات الاسترداد (Disaster Recovery)

### 8.1 إذا فُقد البريدج كلياً من VPS
```bash
# 1) تثبيت nvm + Node 20
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20 && nvm use 20

# 2) تثبيت PM2
npm install -g pm2

# 3) استنساخ المستودع
mkdir -p /home/reemsoft/mailmaestro && cd /home/reemsoft/mailmaestro
git clone https://github.com/ReemSoft/reemail.git .
cd bridge

# 4) تثبيت وبناء
npm install       # postinstall يشغّل npm run build تلقائياً

# 5) إنشاء .env (احضر المفتاح من Lovable → Secrets → MAIL_BRIDGE_SECRET)
cat > .env <<'EOF'
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
BRIDGE_API_KEY=<الصق-64-حرف-hex-هنا>
EOF
chmod 600 .env

# 6) تشغيل PM2
pm2 delete mailmaestro-bridge 2>/dev/null || true
pm2 start dist/index.js --name mailmaestro-bridge --update-env
pm2 save
pm2 startup systemd -u root --hp /root
```

### 8.2 إذا فُقد Apache proxy config
```bash
mkdir -p /etc/apache2/conf.d/userdata/std/2_4/reemsoft/mailmaestro.reemsoft.com
mkdir -p /etc/apache2/conf.d/userdata/ssl/2_4/reemsoft/mailmaestro.reemsoft.com

cat > /etc/apache2/conf.d/userdata/std/2_4/reemsoft/mailmaestro.reemsoft.com/proxy.conf <<'EOF'
ProxyRequests Off
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:3001/
ProxyPassReverse / http://127.0.0.1:3001/
EOF

cat > /etc/apache2/conf.d/userdata/ssl/2_4/reemsoft/mailmaestro.reemsoft.com/proxy.conf <<'EOF'
ProxyRequests Off
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:3001/
ProxyPassReverse / http://127.0.0.1:3001/
RequestHeader set X-Forwarded-Proto "https"
EOF

/scripts/ensure_vhost_includes --user=reemsoft
systemctl restart httpd
```

### 8.3 إذا تغيّر مفتاح `MAIL_BRIDGE_SECRET`
1. حدّث القيمة في Lovable من قائمة Secrets.
2. حدّث `.env` على VPS.
3. `pm2 delete mailmaestro-bridge && pm2 start dist/index.js --name mailmaestro-bridge --update-env && pm2 save`
4. **أعِد نشر** التطبيق في Lovable (اضغط Publish) ليأخذ Worker القيمة الجديدة — بدون هذه الخطوة تعمل النسخة التجريبية ولا تعمل النسخة المنشورة.

### 8.4 استرداد قاعدة البيانات
Lovable Cloud → Advanced settings → Export data (نسخة احتياطية دورية موصى بها).

---

## 9. أوامر التشخيص السريعة

**سكربت الفحص الكامل** (احفظه كمرجع، وشغّله عند أي مشكلة):
```bash
cd /home/reemsoft/mailmaestro/bridge && {
  echo "=== PM2 ==="; pm2 list
  echo "=== Binding ==="; ss -tlnp | grep 3001
  echo "=== Local health ==="; curl -s http://127.0.0.1:3001/health
  echo "=== Public health ==="; curl -sw "\n%{http_code}\n" https://mailmaestro.reemsoft.com/health
  echo "=== Auth check ==="
  KEY=$(grep BRIDGE_API_KEY .env | cut -d= -f2)
  curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
       -d '{}' http://127.0.0.1:3001/api/folders
  echo "=== Logs ==="; pm2 logs mailmaestro-bridge --lines 10 --nostream
}
```

**علامات الصحة المتوقعة:**
- PM2: `online`, restarts=0 (أو رقم صغير مستقر)
- Binding: `127.0.0.1:3001` (وليس `0.0.0.0:3001` — لأسباب أمنية)
- Local health: `{"status":"ok",...}` HTTP 200
- Public health: HTTP 200
- Auth check: 200 مع مفتاح صحيح، 401 مع مفتاح خاطئ، 404 مع GET بدل POST

---

## 10. المشاكل الشائعة وحلولها

| الأعراض | السبب | الحل |
|---|---|---|
| `401 Unauthorized` في `/login` — يعمل في preview لا يعمل في published | `MAIL_BRIDGE_SECRET` مختلف بين Worker المنشور و `.env` | حدّث السر في Lovable → **اضغط Publish** ليعاد نشر Worker |
| `401` في preview و published معاً | `BRIDGE_API_KEY` في `.env` لا يطابق `MAIL_BRIDGE_SECRET` | زامن القيمتين، ثم `pm2 delete` + `pm2 start --update-env` |
| `503 Service Unavailable` من `mailmaestro.reemsoft.com` | البريدج معطّل أو Apache proxy مفقود | راجع 8.1 و 8.2 |
| البريدج يستمع على `0.0.0.0:3001` | ثغرة أمنية — الكود يبني على `HOST=0.0.0.0` | تأكد أن `HOST=127.0.0.1` في `.env` وأن `index.ts` يقرأها |
| الايميلات لا تظهر رغم نجاح الدخول | مشكلة في FETCH داخل `bridge/src/imap.ts` | راجع اللوجات؛ يجب أن يستخدم استعلام واحد لـ `uid + envelope + bodyStructure` |
| React Email build error `entities/lib/decode.js` | Vite يحمّل نسخة `entities` حديثة | ثبّت `entities@4.5.0` في `pnpm.overrides` + alias في `vite.config.ts` |

---

## 11. ملاحظات الصيانة

- **لا تعدّل** `src/integrations/supabase/*` (auto-generated).
- **لا تعدّل** `src/routeTree.gen.ts` يدوياً — يُبنى تلقائياً.
- **لا تغيّر** الجداول `auth.*`, `storage.*`, `realtime.*` مباشرة.
- عند إضافة أي جدول `public.*` جديد: يجب إضافة `GRANT` + `RLS ENABLE` + سياسات في نفس migration.
- عند تحديث Node major على VPS: تأكد أن IMAPFlow و Nodemailer متوافقين قبل الترقية.
- سياسة إعادة تشغيل PM2: `--update-env` إلزامي بعد أي تعديل على `.env`.

---

## 12. جهات الاتصال والمراجع

- Lovable Docs: https://docs.lovable.dev
- IMAPFlow: https://imapflow.com
- Nodemailer: https://nodemailer.com
- Repo: https://github.com/ReemSoft/reemail

---

> **مبدأ الصيانة**: عند أي تعديل جوهري (تغيير مفتاح، تعديل proxy، ترقية Node، إضافة مسار API، تغيير schema)، **حدّث هذا الملف في نفس commit**. الملف يبقى مصدر الحقيقة الوحيد.
