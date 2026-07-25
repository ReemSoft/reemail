# MailMaestro Bridge

خادم Node.js متوسط للاتصال الحقيقي بخوادم IMAP/SMTP. يُستخدم مع تطبيق MailMaestro المُشيّد على Lovable.

## ما يفعله

- يتحقق من بيانات دخول البريد (IMAP).
- يجلب المجلدات والرسائل ومحتواها الكامل.
- يرسل رسائل عبر SMTP.
- يدير الرسائل: مقروء/غير مقروء، مميّز، نقل، حذف.
- يدعم Gmail و Outlook و Yahoo وكل حسابات cPanel/WHM.

---

## النشر على VPS مع WHM (الطريقة الموصى بها)

### المتطلبات
- VPS فيه WHM + cPanel و Node.js 20+ مثبّت.
- Subdomain (مثال: `bridge.yourdomain.com`) تم إنشاؤه من WHM.

### 1) إنشاء subdomain وSSL
1. في **WHM → DNS Functions → Add DNS Zone** (أو من cPanel → Subdomains) أنشئ `bridge.yourdomain.com`.
2. من **WHM → SSL/TLS → Manage AutoSSL** أو **cPanel → SSL/TLS Status** أصدر شهادة SSL للـ subdomain.

### 2) رفع الكود
اتصل بالسيرفر عبر SSH:
```bash
ssh root@yourdomain.com
cd /home/USERNAME/
git clone https://github.com/YOUR_GITHUB/YOUR_REPO.git mailmaestro
cd mailmaestro/bridge
npm install
npm run build
```

### 3) إعداد المتغيرات
```bash
cp .env.example .env 2>/dev/null || true
cat > .env <<EOF
BRIDGE_API_KEY=نفس-قيمة-MAIL_BRIDGE_SECRET-من-Lovable
PORT=3001
EOF
```

### 4) تشغيل دائم عبر PM2
```bash
npm install -g pm2
pm2 start dist/index.js --name mailmaestro-bridge
pm2 save
pm2 startup   # نفّذ الأمر الذي يظهر لك
```

### 5) ربط Nginx/Apache بالـ subdomain
في WHM إذا كنت تستخدم Apache: افتح **WHM → Apache Configuration → Include Editor → Pre VirtualHost Include** وأضف Reverse Proxy:

```
<VirtualHost *:443>
    ServerName bridge.yourdomain.com
    SSLEngine on
    SSLCertificateFile /var/cpanel/ssl/apache_tls/bridge.yourdomain.com/certificates
    SSLCertificateKeyFile /var/cpanel/ssl/apache_tls/bridge.yourdomain.com/key

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/
</VirtualHost>
```

أو أسهل: استخدم **cPanel → Application Manager** ليدير تشغيل تطبيق Node و ربطه بالـ subdomain تلقائياً.

### 6) اختبار
```bash
curl https://bridge.yourdomain.com/health
# يجب أن يرجع: {"status":"ok","timestamp":"..."}
```

### 7) ربطه بـ Lovable
أرسل رابط `https://bridge.yourdomain.com` للـ Lovable ليضاف كـ `MAIL_BRIDGE_URL`.

---

## تشغيل محلي للتجربة

```bash
cd bridge
npm install
BRIDGE_API_KEY=your-secret npm run dev
```

## API Endpoints

كل الطلبات تحتاج `X-Bridge-Key` في الـ Header.

| Endpoint | الوصف |
|----------|-------|
| `GET /health` | فحص حالة الخادم |
| `POST /api/verify` | التحقق من بيانات IMAP |
| `POST /api/folders` | عدد الرسائل في كل مجلد |
| `POST /api/messages` | قائمة الرسائل |
| `POST /api/message` | جلب رسالة واحدة كاملة |
| `POST /api/mark-read` | تحديد مقروء/غير مقروء |
| `POST /api/star` | تحديد مميّز/غير مميّز |
| `POST /api/move` | نقل رسالة إلى مجلد آخر |
| `POST /api/delete` | حذف/نقل إلى المهملات |
| `POST /api/send` | إرسال رسالة عبر SMTP |
