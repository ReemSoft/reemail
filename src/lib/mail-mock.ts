// Mock inbox — replaced later by the Node IMAP backend.
// The API surface (getMessages, getMessage, sendMessage, ...) is stable.

import type { MailMessage, MailFolder, FolderCount } from "./mail-types";

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString();

const senders = [
  { name: "أحمد الغامدي", email: "ahmed@aramco.com" },
  { name: "Sarah Chen", email: "sarah.chen@stripe.com" },
  { name: "Google Cloud", email: "no-reply@cloud.google.com" },
  { name: "GitHub", email: "noreply@github.com" },
  { name: "فاطمة القحطاني", email: "fatima@stc.com.sa" },
  { name: "Linear", email: "team@linear.app" },
  { name: "Notion", email: "team@notion.so" },
  { name: "خالد السلطان", email: "khaled@moi.gov.sa" },
  { name: "Vercel", email: "invoice+statements@vercel.com" },
  { name: "AWS Billing", email: "no-reply@aws.amazon.com" },
];

const subjects = [
  "اجتماع الغد — مراجعة استراتيجية الربع الثاني",
  "Your Stripe payment has been received",
  "Google Cloud: New security recommendation for your project",
  "[mailmaestro/mail] Pull request #142 needs your review",
  "عرض شراكة جديد — يرجى المراجعة",
  "Weekly digest: 12 issues updated in your projects",
  "New page shared: Q1 2026 Product Roadmap",
  "دعوة رسمية لحضور المؤتمر السنوي",
  "Your December 2025 invoice is ready",
  "AWS billing alert: forecasted charges exceeded threshold",
  "تحديث المشروع — المرحلة الأولى مكتملة ✅",
  "Design review — new dashboard mockups attached",
];

const bodies = [
  "<p>مرحباً،</p><p>أود التذكير باجتماع الغد الساعة 10:00 صباحاً لمراجعة استراتيجية الربع الثاني. سيتم مناقشة النقاط التالية:</p><ul><li>أهداف المبيعات</li><li>خطة التوسع الإقليمي</li><li>الميزانية التقديرية</li></ul><p>مع خالص التقدير،<br/>أحمد</p>",
  "<p>Hi,</p><p>Your payment of <strong>$1,250.00</strong> has been successfully processed. Thank you for your business.</p><p>View invoice → </p><p>— The Stripe Team</p>",
  "<p>We detected a new security recommendation for your project. Please review at your earliest convenience.</p>",
  "<p>A new pull request is ready for your review. Please take a look when you have a moment.</p>",
  "<p>السلام عليكم،</p><p>يسرّنا التواصل معكم بخصوص فرصة شراكة استراتيجية. نرفق طيّاً المستند الأولي للمراجعة.</p>",
];

const words = [
  "مرحباً بكم في تحديث هذا الأسبوع",
  "Please review the attached document at your earliest convenience",
  "تم إرسال طلبكم بنجاح وسيتم المعالجة قريباً",
  "Meeting scheduled for tomorrow at 10 AM sharp",
  "نتشرّف بدعوتكم لحضور الحدث السنوي",
];

const folders: MailFolder[] = ["inbox", "inbox", "inbox", "inbox", "inbox", "inbox", "sent", "drafts"];

export const MOCK_MESSAGES: MailMessage[] = Array.from({ length: 24 }, (_, i) => {
  const sender = senders[i % senders.length];
  const folder = folders[i % folders.length];
  const hasAttach = i % 4 === 0;
  return {
    id: `msg_${i + 1}`,
    threadId: `thread_${i + 1}`,
    folder,
    from: sender,
    to: [{ name: "أنت", email: "me@company.com" }],
    subject: subjects[i % subjects.length],
    preview: words[i % words.length],
    body: bodies[i % bodies.length],
    date: i < 3 ? hoursAgo(i + 1) : i < 8 ? hoursAgo(i * 3) : daysAgo(Math.floor(i / 3)),
    read: i > 5,
    starred: i % 5 === 0,
    hasAttachments: hasAttach,
    attachments: hasAttach
      ? [
          {
            id: `att_${i}`,
            filename: i % 2 === 0 ? "تقرير_الربع_الأول.pdf" : "Q1_Report.pdf",
            size: 245_000 + i * 12000,
            mimeType: "application/pdf",
          },
        ]
      : undefined,
    labels: i % 3 === 0 ? ["مهم"] : undefined,
  };
});

export function getFolderCounts(): FolderCount[] {
  const all: MailFolder[] = ["inbox", "starred", "sent", "drafts", "spam", "trash", "archive"];
  return all.map((folder) => {
    const items = MOCK_MESSAGES.filter((m) =>
      folder === "starred" ? m.starred : m.folder === folder,
    );
    return {
      folder,
      total: items.length,
      unread: items.filter((m) => !m.read).length,
    };
  });
}

export function getMessages(folder: MailFolder = "inbox"): MailMessage[] {
  const list =
    folder === "starred"
      ? MOCK_MESSAGES.filter((m) => m.starred)
      : folder === "all"
        ? MOCK_MESSAGES
        : MOCK_MESSAGES.filter((m) => m.folder === folder);
  return [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getMessage(id: string): MailMessage | undefined {
  return MOCK_MESSAGES.find((m) => m.id === id);
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
