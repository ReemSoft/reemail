# MailMaestro Bridge

خادم Node.js متوسط (bridge) للاتصال الحقيقي بخوادم IMAP/SMTP. يُستخدم مع تطبيق MailMaestro المُشيّد في Lovable.

## ما يفعله

- يتحقق من بيانات دخول البريد (IMAP).
- يجلب المجلدات والرسائل ومحتواها الكامل.
- يرسل رسائل عبر SMTP.
- يدير الرسائل: مقروء/غير مقروء، مميّز، نقل، حذف.
- يدعم Gmail و Outlook و Yahoo وكل حسابات cPanel/WHM.

## النشر على Railway

اضغط الزر أدناه:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template?referralCode=mailmaestro)

### بعد النشر:

1. اذهب إلى **Variables** في مشروع Railway.
2. أضف متغير: `BRIDGE_API_KEY` واجعل قيمته نفس `MAIL_BRIDGE_SECRET` الموجود في Lovable.
3. انسخ رابط الخادم (مثل `https://mail-bridge.up.railway.app`).
4. أخبر فريق MailMaestro بالرابط ليضيفه في إعدادات Lovable كـ `MAIL_BRIDGE_URL`.

## تشغيل محلي

```bash
cd bridge
npm install
BRIDGE_API_KEY=your-secret-key npm run dev
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
