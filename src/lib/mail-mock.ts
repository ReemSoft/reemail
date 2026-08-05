// Demo / fallback mailbox data.
// Fully bilingual: the Arabic dataset is used in AR mode (RTL bodies) and the
// English dataset in EN mode (LTR bodies). Message ids are identical across
// both languages so selection state survives a language switch.

import type { MailMessage, MailFolder, FolderCount } from "./mail-types";
import { getCurrentLang, type SupportedLang } from "@/i18n";

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString();

type Seed = {
  id: number;
  folder: MailFolder;
  read: boolean;
  starred: boolean;
  date: string;
  attach?: { name: { ar: string; en: string }; size: number; mime: string };
  labels?: { ar: string; en: string };
  cc?: boolean;
};

const SEEDS: Seed[] = [
  {
    id: 1,
    folder: "inbox",
    read: false,
    starred: true,
    date: hoursAgo(1),
    labels: { ar: "مهم", en: "Important" },
  },
  { id: 2, folder: "inbox", read: false, starred: false, date: hoursAgo(3) },
  {
    id: 3,
    folder: "inbox",
    read: false,
    starred: false,
    date: hoursAgo(5),
    attach: {
      name: { ar: "تقرير_الربع_الأول.pdf", en: "Q1_Report.pdf" },
      size: 284_120,
      mime: "application/pdf",
    },
    cc: true,
  },
  { id: 4, folder: "inbox", read: true, starred: false, date: hoursAgo(9) },
  {
    id: 5,
    folder: "inbox",
    read: true,
    starred: true,
    date: hoursAgo(20),
    labels: { ar: "متابعة", en: "Follow-up" },
  },
  {
    id: 6,
    folder: "inbox",
    read: true,
    starred: false,
    date: daysAgo(1),
    attach: {
      name: { ar: "الفاتورة_ديسمبر.pdf", en: "Invoice_December.pdf" },
      size: 96_400,
      mime: "application/pdf",
    },
  },
  { id: 7, folder: "inbox", read: true, starred: false, date: daysAgo(2) },
  { id: 8, folder: "inbox", read: true, starred: false, date: daysAgo(3), cc: true },
  {
    id: 9,
    folder: "inbox",
    read: true,
    starred: true,
    date: daysAgo(4),
    attach: {
      name: { ar: "العرض_التقديمي.pptx", en: "Deck_2026.pptx" },
      size: 1_482_000,
      mime: "application/vnd.ms-powerpoint",
    },
  },
  { id: 10, folder: "inbox", read: true, starred: false, date: daysAgo(6) },
  { id: 11, folder: "inbox", read: true, starred: false, date: daysAgo(9) },
  { id: 12, folder: "inbox", read: true, starred: false, date: daysAgo(14) },
  { id: 13, folder: "sent", read: true, starred: false, date: hoursAgo(6) },
  { id: 14, folder: "sent", read: true, starred: false, date: daysAgo(2), cc: true },
  {
    id: 15,
    folder: "sent",
    read: true,
    starred: false,
    date: daysAgo(5),
    attach: {
      name: { ar: "العقد_الموقع.pdf", en: "Signed_Contract.pdf" },
      size: 512_300,
      mime: "application/pdf",
    },
  },
  { id: 16, folder: "drafts", read: true, starred: false, date: hoursAgo(2) },
  { id: 17, folder: "drafts", read: true, starred: false, date: daysAgo(3) },
  { id: 18, folder: "archive", read: true, starred: false, date: daysAgo(11) },
  { id: 19, folder: "archive", read: true, starred: true, date: daysAgo(18) },
  { id: 20, folder: "spam", read: false, starred: false, date: daysAgo(1) },
  { id: 21, folder: "spam", read: true, starred: false, date: daysAgo(7) },
  { id: 22, folder: "trash", read: true, starred: false, date: daysAgo(2) },
  { id: 23, folder: "trash", read: true, starred: false, date: daysAgo(8) },
  { id: 24, folder: "inbox", read: true, starred: false, date: daysAgo(21) },
];

type Content = {
  from: { name: string; email: string };
  subject: string;
  preview: string;
  body: string;
};

const AR: Content[] = [
  {
    from: { name: "أحمد الغامدي", email: "ahmed@aramco.com" },
    subject: "اجتماع الغد — مراجعة استراتيجية الربع الثاني",
    preview: "أود التذكير باجتماع الغد الساعة 10:00 صباحاً لمراجعة الخطة",
    body: "<p>مرحباً،</p><p>أود التذكير باجتماع الغد الساعة <strong>10:00 صباحاً</strong> لمراجعة استراتيجية الربع الثاني. سنناقش:</p><ul><li>أهداف المبيعات</li><li>خطة التوسّع الإقليمي</li><li>الميزانية التقديرية</li></ul><p>مع خالص التقدير،<br/>أحمد الغامدي</p>",
  },
  {
    from: { name: "فاطمة القحطاني", email: "fatima@stc.com.sa" },
    subject: "عرض شراكة جديد — يرجى المراجعة",
    preview: "يسرّنا التواصل معكم بخصوص فرصة شراكة استراتيجية",
    body: "<p>السلام عليكم ورحمة الله،</p><p>يسرّنا التواصل معكم بخصوص فرصة شراكة استراتيجية بين الشركتين. نرفق طيّاً المستند الأولي للاطلاع والمراجعة.</p><p>في انتظار ملاحظاتكم.</p><p>فاطمة القحطاني<br/>إدارة تطوير الأعمال</p>",
  },
  {
    from: { name: "قسم المالية", email: "finance@reemsoft.com" },
    subject: "تقرير الأداء المالي للربع الأول",
    preview: "مرفق تقرير الأداء المالي مع مقارنة بالربع السابق",
    body: "<p>زملائي الكرام،</p><p>مرفق تقرير الأداء المالي للربع الأول مع مقارنة تفصيلية بالربع السابق. النتائج تجاوزت المستهدف بنسبة <strong>12%</strong>.</p><p>شكراً لجهودكم.</p>",
  },
  {
    from: { name: "خالد السلطان", email: "khaled@moi.gov.sa" },
    subject: "دعوة رسمية لحضور المؤتمر السنوي",
    preview: "يشرّفنا دعوتكم لحضور المؤتمر السنوي للتحول الرقمي",
    body: "<p>سعادة المدير المحترم،</p><p>يشرّفنا دعوتكم لحضور المؤتمر السنوي للتحول الرقمي المقام يوم الأربعاء القادم في مركز الملك عبدالله للمؤتمرات.</p><p>وتفضلوا بقبول فائق الاحترام.</p>",
  },
  {
    from: { name: "نورة العتيبي", email: "noura@design.studio" },
    subject: "تحديث المشروع — المرحلة الأولى مكتملة ✅",
    preview: "تم إنجاز المرحلة الأولى وجاهزة للمراجعة النهائية",
    body: "<p>مرحباً،</p><p>تم إنجاز <strong>المرحلة الأولى</strong> من المشروع بالكامل وهي جاهزة الآن للمراجعة النهائية من فريقكم.</p><p>سنبدأ المرحلة الثانية فور اعتمادكم.</p>",
  },
  {
    from: { name: "الفوترة", email: "billing@reemsoft.com" },
    subject: "فاتورة ديسمبر 2025 جاهزة",
    preview: "فاتورة الاشتراك الشهري جاهزة للاطلاع والسداد",
    body: "<p>عميلنا العزيز،</p><p>فاتورة الاشتراك الشهري لشهر ديسمبر جاهزة للاطلاع. المبلغ المستحق: <strong>1,250.00 ر.س</strong>.</p><p>شكراً لثقتكم.</p>",
  },
  {
    from: { name: "سعد الحربي", email: "saad@logistics.sa" },
    subject: "تأكيد موعد الشحنة رقم 88214",
    preview: "تم تأكيد موعد وصول الشحنة يوم الأحد القادم",
    body: "<p>تحية طيبة،</p><p>نفيدكم بأنه تم تأكيد موعد وصول الشحنة رقم <strong>88214</strong> يوم الأحد القادم بإذن الله.</p>",
  },
  {
    from: { name: "الموارد البشرية", email: "hr@reemsoft.com" },
    subject: "تذكير: تحديث بيانات الموظفين",
    preview: "نرجو تحديث بياناتكم على البوابة قبل نهاية الأسبوع",
    body: "<p>الزملاء الأعزاء،</p><p>نرجو تحديث بياناتكم الشخصية على بوابة الموظفين قبل نهاية الأسبوع الحالي.</p>",
  },
  {
    from: { name: "ريم الشمري", email: "reem@marketing.sa" },
    subject: "خطة الحملة التسويقية القادمة",
    preview: "مرفق العرض التقديمي لخطة الحملة القادمة",
    body: "<p>مرحباً،</p><p>مرفق العرض التقديمي الكامل لخطة الحملة التسويقية القادمة، مع الجدول الزمني والميزانية المقترحة.</p>",
  },
  {
    from: { name: "الدعم الفني", email: "support@reemsoft.com" },
    subject: "تم إغلاق تذكرة الدعم رقم #4821",
    preview: "تم حل المشكلة المبلّغ عنها وإغلاق التذكرة",
    body: "<p>مرحباً،</p><p>تم حل المشكلة المبلّغ عنها وإغلاق التذكرة رقم <strong>#4821</strong>. يسعدنا خدمتكم دائماً.</p>",
  },
  {
    from: { name: "لجنة المشتريات", email: "procurement@reemsoft.com" },
    subject: "طلب عروض أسعار — أجهزة مكتبية",
    preview: "نرجو تزويدنا بعروض الأسعار قبل الخميس",
    body: "<p>تحية طيبة،</p><p>نرجو تزويدنا بعروض الأسعار الخاصة بالأجهزة المكتبية قبل يوم الخميس القادم.</p>",
  },
  {
    from: { name: "مركز التدريب", email: "training@reemsoft.com" },
    subject: "دورة تدريبية: أمن المعلومات",
    preview: "التسجيل مفتوح الآن لدورة أمن المعلومات",
    body: "<p>الزملاء الأعزاء،</p><p>التسجيل مفتوح الآن للدورة التدريبية في <strong>أمن المعلومات</strong>. المقاعد محدودة.</p>",
  },
];

const EN: Content[] = [
  {
    from: { name: "Sarah Chen", email: "sarah.chen@stripe.com" },
    subject: "Tomorrow's meeting — Q2 strategy review",
    preview: "A quick reminder about tomorrow's 10:00 AM strategy review",
    body: "<p>Hi,</p><p>A quick reminder about tomorrow's <strong>10:00 AM</strong> Q2 strategy review. We'll cover:</p><ul><li>Sales targets</li><li>Regional expansion plan</li><li>Budget forecast</li></ul><p>Best regards,<br/>Sarah Chen</p>",
  },
  {
    from: { name: "Michael Ross", email: "michael@partners.io" },
    subject: "New partnership proposal — please review",
    preview: "We'd love to explore a strategic partnership with your team",
    body: "<p>Hello,</p><p>We'd love to explore a strategic partnership between our companies. The initial document is attached for your review.</p><p>Looking forward to your feedback.</p><p>Michael Ross<br/>Business Development</p>",
  },
  {
    from: { name: "Finance Team", email: "finance@reemsoft.com" },
    subject: "Q1 financial performance report",
    preview: "Attached is the Q1 report with a quarter-over-quarter comparison",
    body: "<p>Team,</p><p>Attached is the Q1 financial performance report with a detailed quarter-over-quarter comparison. Results exceeded target by <strong>12%</strong>.</p><p>Thanks for the great work.</p>",
  },
  {
    from: { name: "Google Cloud", email: "no-reply@cloud.google.com" },
    subject: "New security recommendation for your project",
    preview: "We detected a new security recommendation for your project",
    body: "<p>We detected a new security recommendation for your project. Please review it at your earliest convenience from the security dashboard.</p>",
  },
  {
    from: { name: "Emma Wright", email: "emma@design.studio" },
    subject: "Project update — phase one complete ✅",
    preview: "Phase one is complete and ready for final review",
    body: "<p>Hi,</p><p><strong>Phase one</strong> of the project is now fully complete and ready for your final review.</p><p>We'll start phase two as soon as you approve.</p>",
  },
  {
    from: { name: "Billing", email: "billing@reemsoft.com" },
    subject: "Your December 2025 invoice is ready",
    preview: "Your monthly subscription invoice is ready to view",
    body: "<p>Dear customer,</p><p>Your monthly subscription invoice for December is ready. Amount due: <strong>$1,250.00</strong>.</p><p>Thank you for your business.</p>",
  },
  {
    from: { name: "Logistics", email: "ops@logistics.com" },
    subject: "Shipment #88214 delivery confirmed",
    preview: "Delivery for shipment #88214 is confirmed for Sunday",
    body: "<p>Hello,</p><p>Delivery for shipment <strong>#88214</strong> has been confirmed for this coming Sunday.</p>",
  },
  {
    from: { name: "People Ops", email: "hr@reemsoft.com" },
    subject: "Reminder: update your employee profile",
    preview: "Please update your details on the portal before Friday",
    body: "<p>Hi everyone,</p><p>Please update your personal details on the employee portal before the end of this week.</p>",
  },
  {
    from: { name: "Laura Kim", email: "laura@marketing.co" },
    subject: "Next marketing campaign plan",
    preview: "Attached is the full deck for the upcoming campaign",
    body: "<p>Hi,</p><p>Attached is the full deck for the upcoming marketing campaign, including the timeline and proposed budget.</p>",
  },
  {
    from: { name: "Support", email: "support@reemsoft.com" },
    subject: "Support ticket #4821 has been closed",
    preview: "The reported issue was resolved and the ticket closed",
    body: "<p>Hello,</p><p>The reported issue has been resolved and ticket <strong>#4821</strong> is now closed. Happy to help anytime.</p>",
  },
  {
    from: { name: "Procurement", email: "procurement@reemsoft.com" },
    subject: "Request for quotation — office equipment",
    preview: "Please send your quotations before Thursday",
    body: "<p>Hello,</p><p>Please send your quotations for the office equipment before next Thursday.</p>",
  },
  {
    from: { name: "Learning Center", email: "training@reemsoft.com" },
    subject: "Training course: information security",
    preview: "Registration is now open for the security course",
    body: "<p>Team,</p><p>Registration is now open for the <strong>information security</strong> training course. Seats are limited.</p>",
  },
];

const ME = {
  ar: { name: "أنت", email: "you@mailmaestro.app" },
  en: { name: "You", email: "you@mailmaestro.app" },
};

function build(lang: SupportedLang): MailMessage[] {
  const pool = lang === "ar" ? AR : EN;
  const me = ME[lang];
  return SEEDS.map((s, i) => {
    const c = pool[i % pool.length];
    const outgoing = s.folder === "sent" || s.folder === "drafts";
    return {
      id: `msg_${s.id}`,
      threadId: `thread_${s.id}`,
      folder: s.folder,
      from: outgoing ? me : c.from,
      to: outgoing ? [c.from] : [me],
      cc: s.cc
        ? [
            {
              name: lang === "ar" ? "الإدارة" : "Management",
              email: "management@reemsoft.com",
            },
          ]
        : undefined,
      subject: c.subject,
      preview: c.preview,
      body: c.body,
      date: s.date,
      read: s.read,
      starred: s.starred,
      hasAttachments: Boolean(s.attach),
      attachments: s.attach
        ? [
            {
              id: `att_${s.id}`,
              filename: s.attach.name[lang],
              size: s.attach.size,
              mimeType: s.attach.mime,
            },
          ]
        : undefined,
      labels: s.labels ? [s.labels[lang]] : undefined,
      mailedBy: "mail.reemsoft.com",
      signedBy: "reemsoft.com",
      security: lang === "ar" ? "تشفير قياسي (TLS)" : "Standard encryption (TLS)",
    } satisfies MailMessage;
  });
}

const CACHE: Partial<Record<SupportedLang, MailMessage[]>> = {};

function dataset(lang: SupportedLang = getCurrentLang()): MailMessage[] {
  if (!CACHE[lang]) CACHE[lang] = build(lang);
  return CACHE[lang]!;
}

/** Backwards-compatible export (Arabic dataset). */
export const MOCK_MESSAGES: MailMessage[] = dataset("ar");

export function getFolderCounts(lang: SupportedLang = getCurrentLang()): FolderCount[] {
  const all: MailFolder[] = ["inbox", "starred", "sent", "drafts", "spam", "trash", "archive"];
  const list = dataset(lang);
  return all.map((folder) => {
    const items = list.filter((m) => (folder === "starred" ? m.starred : m.folder === folder));
    return {
      folder,
      total: items.length,
      unread: items.filter((m) => !m.read).length,
      supported: true,
    };
  });
}

export function getMessages(
  folder: MailFolder = "inbox",
  lang: SupportedLang = getCurrentLang(),
): MailMessage[] {
  const all = dataset(lang);
  const list =
    folder === "starred"
      ? all.filter((m) => m.starred)
      : folder === "all"
        ? all
        : all.filter((m) => m.folder === folder);
  return [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getMessage(
  id: string,
  lang: SupportedLang = getCurrentLang(),
): MailMessage | undefined {
  return dataset(lang).find((m) => m.id === id);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string, lang: "ar" | "en" = "ar"): string {
  const d = new Date(iso);
  const now = new Date();
  const locale = lang === "ar" ? "ar-SA" : "en-GB";
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400_000);
  if (diffDays < 7 && d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(locale, { weekday: "short" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
  }
  // Different year — always include the year (Roundcube nice_date behavior)
  return d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
}
