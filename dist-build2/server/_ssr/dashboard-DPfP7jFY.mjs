import { n as __toESM } from "../_runtime.mjs";
import { g as useNavigate, h as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { T as require_jsx_runtime } from "../_libs/@radix-ui/react-alert-dialog+[...].mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
import { t as supabase } from "./client-C8x6RfeV.mjs";
import { n as toast } from "../_libs/sonner.mjs";
import { D as Mail, M as LoaderCircle, P as Globe, S as Pencil, a as Trash2, g as Save, i as Upload, it as ArrowLeft, k as LogOut, n as X, p as Server, w as Palette, x as Plus } from "../_libs/lucide-react.mjs";
import { r as useConfirm } from "./confirm-provider-DMbkJnjU.mjs";
import { t as useCompanyTheme } from "./use-company-theme-C8pdPbGn.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/dashboard-DPfP7jFY.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
function CompanyDashboard() {
	const [company, setCompany] = (0, import_react.useState)(null);
	const [originalCompany, setOriginalCompany] = (0, import_react.useState)(null);
	const [loading, setLoading] = (0, import_react.useState)(true);
	const [saving, setSaving] = (0, import_react.useState)(false);
	const [tab, setTab] = (0, import_react.useState)("branding");
	const [accounts, setAccounts] = (0, import_react.useState)([]);
	const [domains, setDomains] = (0, import_react.useState)([]);
	const [isAdmin, setIsAdmin] = (0, import_react.useState)(false);
	const navigate = useNavigate();
	useCompanyTheme(company ? {
		primary: company.brand_primary,
		accent: company.brand_accent
	} : null);
	const load = (0, import_react.useCallback)(async () => {
		setLoading(true);
		const { data: userRes } = await supabase.auth.getUser();
		if (!userRes.user) {
			setLoading(false);
			return;
		}
		const { data: roles } = await supabase.from("user_roles").select("role, company_id").eq("user_id", userRes.user.id);
		const adminRole = roles?.find((r) => r.role === "company_admin");
		setIsAdmin(!!adminRole);
		const companyId = adminRole?.company_id;
		if (!companyId) {
			setLoading(false);
			return;
		}
		const [{ data: co }, { data: ma }, { data: dm }] = await Promise.all([
			supabase.from("companies").select("*").eq("id", companyId).maybeSingle(),
			supabase.from("mail_accounts").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
			supabase.from("email_domains").select("*").eq("company_id", companyId).order("created_at", { ascending: false })
		]);
		if (co) {
			setCompany(co);
			setOriginalCompany(co);
		}
		if (ma) setAccounts(ma);
		if (dm) setDomains(dm);
		setLoading(false);
	}, []);
	(0, import_react.useEffect)(() => {
		load();
	}, [load]);
	const hasChanges = !!company && !!originalCompany && (company.name !== originalCompany.name || company.brand_primary !== originalCompany.brand_primary || company.brand_accent !== originalCompany.brand_accent || company.app_name !== originalCompany.app_name || company.logo_url !== originalCompany.logo_url);
	async function handleSave() {
		if (!company) return;
		setSaving(true);
		const { error } = await supabase.from("companies").update({
			name: company.name,
			brand_primary: company.brand_primary,
			brand_accent: company.brand_accent,
			app_name: company.app_name,
			logo_url: company.logo_url
		}).eq("id", company.id);
		setSaving(false);
		if (error) return toast.error(error.message);
		setOriginalCompany(company);
		toast.success("تم حفظ التغييرات");
	}
	async function handleLogout() {
		await supabase.auth.signOut();
		navigate({ to: "/login" });
	}
	if (loading) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex min-h-screen items-center justify-center",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-6 w-6 animate-spin text-primary" })
	});
	if (!isAdmin || !company) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex min-h-screen items-center justify-center p-8 text-center",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col items-center gap-3",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-muted-foreground",
					children: "هذه الصفحة مخصّصة لمدراء الشركات فقط."
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
					to: "/mail",
					className: "inline-flex rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white",
					children: "الذهاب للبريد"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					onClick: handleLogout,
					className: "inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogOut, { className: "h-4 w-4" }), "تسجيل الخروج"]
				})
			]
		})
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "min-h-screen bg-background",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", {
			className: "sticky top-0 z-10 border-b border-border bg-card",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mx-auto flex h-14 max-w-6xl items-center justify-between px-4",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
						to: "/mail",
						className: "rounded-lg p-2 hover:bg-muted",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowLeft, { className: "h-4 w-4" })
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
						className: "text-lg font-bold",
						children: "لوحة تحكم الشركة"
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [tab === "branding" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: `overflow-hidden transition-all duration-200 ease-out ${hasChanges ? "max-w-[120px] opacity-100" : "max-w-0 opacity-0"}`,
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							onClick: handleSave,
							disabled: saving,
							className: "inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60",
							children: [saving ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Save, { className: "h-4 w-4" }), "حفظ"]
						})
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						onClick: handleLogout,
						className: "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-destructive hover:text-destructive-foreground",
						title: "تسجيل الخروج",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogOut, { className: "h-4 w-4" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "hidden sm:inline",
							children: "خروج"
						})]
					})]
				})]
			})
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[220px_1fr] md:p-8",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
				className: "flex gap-2 overflow-x-auto md:flex-col",
				children: [
					{
						id: "branding",
						label: "العلامة التجارية",
						icon: Palette
					},
					{
						id: "accounts",
						label: "حسابات البريد",
						icon: Mail,
						count: accounts.length
					},
					{
						id: "domains",
						label: "دومينات مشتركة",
						icon: Globe,
						count: domains.length
					}
				].map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					onClick: () => setTab(t.id),
					className: `flex shrink-0 items-center justify-between gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${tab === t.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`,
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "flex items-center gap-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(t.icon, { className: "h-4 w-4" }), t.label]
					}), typeof t.count === "number" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "rounded-md bg-muted px-1.5 py-0.5 text-xs",
						children: t.count
					})]
				}, t.id))
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
				className: "min-w-0",
				children: [
					tab === "branding" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(BrandingTab, {
						company,
						setCompany
					}),
					tab === "accounts" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AccountsTab, {
						accounts,
						companyId: company.id,
						onChange: load
					}),
					tab === "domains" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DomainsTab, {
						domains,
						companyId: company.id,
						onChange: load
					})
				]
			})]
		})]
	});
}
function BrandingTab({ company, setCompany }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-2xl border border-border bg-card p-6 shadow-soft",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
				className: "text-xl font-bold",
				children: "العلامة التجارية"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-1 text-sm text-muted-foreground",
				children: "سيرى عملاؤك هذه العلامة في واجهة البريد الخاصة بهم."
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-6 space-y-5",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "اسم الشركة",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							value: company.name,
							onChange: (e) => setCompany({
								...company,
								name: e.target.value
							}),
							className: "w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "اسم التطبيق المُخصّص",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							value: company.app_name ?? "",
							onChange: (e) => setCompany({
								...company,
								app_name: e.target.value
							}),
							placeholder: "مثال: Aramco Mail",
							className: "w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "grid gap-4 sm:grid-cols-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ColorInput, {
							label: "اللون الأساسي",
							value: company.brand_primary,
							onChange: (v) => setCompany({
								...company,
								brand_primary: v
							})
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ColorInput, {
							label: "لون التمييز",
							value: company.brand_accent,
							onChange: (v) => setCompany({
								...company,
								brand_accent: v
							})
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "شعار الشركة",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-4",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted/30",
								children: company.logo_url ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
									src: company.logo_url,
									alt: "Logo",
									className: "h-full w-full rounded-2xl object-cover"
								}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Upload, { className: "h-6 w-6 text-muted-foreground" })
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								value: company.logo_url ?? "",
								onChange: (e) => setCompany({
									...company,
									logo_url: e.target.value
								}),
								placeholder: "https://... رابط الشعار",
								className: "flex-1 rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary",
								dir: "ltr"
							})]
						})
					})
				]
			})
		]
	});
}
var IMAP_PRESETS = [
	{
		name: "Gmail",
		imap: "imap.gmail.com",
		smtp: "smtp.gmail.com"
	},
	{
		name: "Outlook / Office 365",
		imap: "outlook.office365.com",
		smtp: "smtp.office365.com"
	},
	{
		name: "Yahoo",
		imap: "imap.mail.yahoo.com",
		smtp: "smtp.mail.yahoo.com"
	},
	{
		name: "iCloud",
		imap: "imap.mail.me.com",
		smtp: "smtp.mail.me.com"
	},
	{
		name: "Zoho",
		imap: "imap.zoho.com",
		smtp: "smtp.zoho.com"
	}
];
function AccountsTab({ accounts, companyId, onChange }) {
	const { confirm } = useConfirm();
	const [open, setOpen] = (0, import_react.useState)(false);
	const [busyId, setBusyId] = (0, import_react.useState)(null);
	const [editingId, setEditingId] = (0, import_react.useState)(null);
	const emptyForm = {
		display_name: "",
		email_address: "",
		imap_host: "",
		imap_port: 993,
		imap_secure: true,
		smtp_host: "",
		smtp_port: 465,
		smtp_secure: true
	};
	const [form, setForm] = (0, import_react.useState)(emptyForm);
	const [submitting, setSubmitting] = (0, import_react.useState)(false);
	function closeModal() {
		setOpen(false);
		setEditingId(null);
		setForm(emptyForm);
	}
	function startEdit(account) {
		setEditingId(account.id);
		setForm({
			display_name: account.display_name || "",
			email_address: account.email_address,
			imap_host: account.imap_host,
			imap_port: account.imap_port,
			imap_secure: account.imap_secure,
			smtp_host: account.smtp_host,
			smtp_port: account.smtp_port,
			smtp_secure: account.smtp_secure
		});
		setOpen(true);
	}
	async function handleSubmit(e) {
		e.preventDefault();
		setSubmitting(true);
		const basePayload = {
			display_name: form.display_name || null,
			email_address: form.email_address,
			imap_host: form.imap_host,
			imap_port: form.imap_port,
			imap_secure: form.imap_secure,
			smtp_host: form.smtp_host,
			smtp_port: form.smtp_port,
			smtp_secure: form.smtp_secure
		};
		if (editingId) {
			const { error } = await supabase.from("mail_accounts").update(basePayload).eq("id", editingId);
			setSubmitting(false);
			if (error) return toast.error(error.message);
			toast.success("تم تحديث الحساب");
		} else {
			const { error } = await supabase.from("mail_accounts").insert({
				company_id: companyId,
				...basePayload,
				credentials_ciphertext: null
			});
			setSubmitting(false);
			if (error) return toast.error(error.message);
			toast.success("تمت إضافة الحساب");
		}
		closeModal();
		await onChange();
	}
	async function handleDelete(id) {
		if (!await confirm({
			title: "حذف الحساب",
			description: "هل أنت متأكد من حذف هذا الحساب؟ لا يمكن التراجع عن هذا الإجراء.",
			confirmLabel: "حذف",
			cancelLabel: "إلغاء",
			variant: "destructive"
		})) return;
		setBusyId(id);
		const { error } = await supabase.from("mail_accounts").delete().eq("id", id);
		setBusyId(null);
		if (error) return toast.error(error.message);
		toast.success("تم الحذف");
		await onChange();
	}
	function applyPreset(p) {
		setForm({
			...form,
			imap_host: p.imap,
			imap_port: 993,
			imap_secure: true,
			smtp_host: p.smtp,
			smtp_port: 465,
			smtp_secure: true
		});
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-xl font-bold",
					children: "حسابات البريد (IMAP/SMTP)"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: "أضف عنوان البريد وإعدادات السيرفر فقط. كلمة مرور البريد يُدخلها العميل بنفسه عند فتح صندوقه."
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					onClick: () => setOpen(true),
					className: "inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Plus, { className: "h-4 w-4" }), "حساب جديد"]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "overflow-hidden rounded-2xl border border-border bg-card shadow-soft",
				children: accounts.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "p-10 text-center text-sm text-muted-foreground",
					children: "لا توجد حسابات بريد بعد."
				}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
					className: "divide-y divide-border",
					children: accounts.map((a) => {
						return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
							className: "flex items-center gap-4 p-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "flex h-10 w-10 items-center justify-center rounded-xl bg-brand-gradient/10 text-brand-accent",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Server, { className: "h-5 w-5" })
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "min-w-0 flex-1",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										className: "flex items-center gap-2",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "truncate font-semibold",
											dir: "ltr",
											children: a.email_address
										}), a.is_default && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600",
											children: "افتراضي"
										})]
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
										className: "mt-0.5 truncate text-xs text-muted-foreground",
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
												dir: "ltr",
												className: "mx-1",
												children: [
													"IMAP ",
													a.imap_host,
													":",
													a.imap_port
												]
											}),
											"·",
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
												dir: "ltr",
												className: "mx-1",
												children: [
													"SMTP ",
													a.smtp_host,
													":",
													a.smtp_port
												]
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									onClick: () => startEdit(a),
									className: "rounded-md p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary",
									title: "تعديل",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pencil, { className: "h-4 w-4" })
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									onClick: () => handleDelete(a.id),
									disabled: busyId === a.id,
									className: "rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
									title: "حذف",
									children: busyId === a.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Trash2, { className: "h-4 w-4" })
								})
							]
						}, a.id);
					})
				})
			}),
			open && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Modal, {
				title: editingId ? "تعديل إعدادات البريد" : "إعدادات بريد جديدة",
				onClose: closeModal,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
					onSubmit: handleSubmit,
					className: "space-y-4",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mb-1.5 text-xs font-medium text-muted-foreground",
							children: "اختصارات:"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "flex flex-wrap gap-1.5",
							children: IMAP_PRESETS.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => applyPreset(p),
								className: "rounded-md border border-input bg-background px-2 py-1 text-xs hover:border-primary hover:bg-muted",
								children: p.name
							}, p.name))
						})] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "grid gap-4 sm:grid-cols-2",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "البريد الإلكتروني",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									required: true,
									type: "email",
									dir: "ltr",
									value: form.email_address,
									onChange: (e) => setForm({
										...form,
										email_address: e.target.value
									}),
									className: "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
								})
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "اسم العرض (اختياري)",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									value: form.display_name,
									onChange: (e) => setForm({
										...form,
										display_name: e.target.value
									}),
									className: "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
								})
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", {
							className: "rounded-xl border border-border p-3",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", {
								className: "px-1 text-xs font-semibold text-muted-foreground",
								children: "خادم الوارد (IMAP)"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-3 sm:grid-cols-[1fr_100px_auto]",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										placeholder: "imap.example.com",
										dir: "ltr",
										value: form.imap_host,
										onChange: (e) => setForm({
											...form,
											imap_host: e.target.value
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										type: "number",
										value: form.imap_port,
										onChange: (e) => setForm({
											...form,
											imap_port: Number(e.target.value)
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
										className: "flex items-center gap-2 text-xs",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: form.imap_secure,
											onChange: (e) => setForm({
												...form,
												imap_secure: e.target.checked
											})
										}), "SSL"]
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", {
							className: "rounded-xl border border-border p-3",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", {
								className: "px-1 text-xs font-semibold text-muted-foreground",
								children: "خادم الصادر (SMTP)"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-3 sm:grid-cols-[1fr_100px_auto]",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										placeholder: "smtp.example.com",
										dir: "ltr",
										value: form.smtp_host,
										onChange: (e) => setForm({
											...form,
											smtp_host: e.target.value
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										type: "number",
										value: form.smtp_port,
										onChange: (e) => setForm({
											...form,
											smtp_port: Number(e.target.value)
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
										className: "flex items-center gap-2 text-xs",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: form.smtp_secure,
											onChange: (e) => setForm({
												...form,
												smtp_secure: e.target.checked
											})
										}), "SSL"]
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex justify-end gap-2 pt-2",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setOpen(false),
								className: "rounded-lg px-4 py-2 text-sm hover:bg-muted",
								children: "إلغاء"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "submit",
								disabled: submitting,
								className: "inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60",
								children: [submitting && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }), "حفظ الإعدادات"]
							})]
						})
					]
				})
			})
		]
	});
}
function DomainsTab({ domains, companyId, onChange }) {
	const { confirm } = useConfirm();
	const [open, setOpen] = (0, import_react.useState)(false);
	const [busyId, setBusyId] = (0, import_react.useState)(null);
	const [editingId, setEditingId] = (0, import_react.useState)(null);
	const emptyForm = {
		domain: "",
		imap_host: "",
		imap_port: 993,
		imap_secure: true,
		smtp_host: "",
		smtp_port: 465,
		smtp_secure: true
	};
	const [form, setForm] = (0, import_react.useState)(emptyForm);
	const [submitting, setSubmitting] = (0, import_react.useState)(false);
	function closeModal() {
		setOpen(false);
		setEditingId(null);
		setForm(emptyForm);
	}
	function startEdit(d) {
		setEditingId(d.id);
		setForm({
			domain: d.domain,
			imap_host: d.imap_host,
			imap_port: d.imap_port,
			imap_secure: d.imap_secure,
			smtp_host: d.smtp_host,
			smtp_port: d.smtp_port,
			smtp_secure: d.smtp_secure
		});
		setOpen(true);
	}
	async function handleSubmit(e) {
		e.preventDefault();
		setSubmitting(true);
		const payload = {
			domain: form.domain.trim().toLowerCase().replace(/^@/, ""),
			imap_host: form.imap_host.trim(),
			imap_port: form.imap_port,
			imap_secure: form.imap_secure,
			smtp_host: form.smtp_host.trim(),
			smtp_port: form.smtp_port,
			smtp_secure: form.smtp_secure
		};
		if (!payload.domain.includes(".")) {
			setSubmitting(false);
			return toast.error("أدخل دومين صحيح مثل example.com");
		}
		if (editingId) {
			const { error } = await supabase.from("email_domains").update(payload).eq("id", editingId);
			setSubmitting(false);
			if (error) return toast.error(error.message);
			toast.success("تم تحديث الدومين");
		} else {
			const { error } = await supabase.from("email_domains").insert({
				company_id: companyId,
				...payload
			});
			setSubmitting(false);
			if (error) return toast.error(error.message);
			toast.success("تمت إضافة الدومين");
		}
		closeModal();
		await onChange();
	}
	async function handleDelete(id) {
		if (!await confirm({
			title: "حذف إعدادات الدومين",
			description: "هل أنت متأكد من حذف إعدادات هذا الدومين؟ لا يمكن التراجع عن هذا الإجراء.",
			confirmLabel: "حذف",
			cancelLabel: "إلغاء",
			variant: "destructive"
		})) return;
		setBusyId(id);
		const { error } = await supabase.from("email_domains").delete().eq("id", id);
		setBusyId(null);
		if (error) return toast.error(error.message);
		toast.success("تم الحذف");
		await onChange();
	}
	function applyPreset(p) {
		setForm({
			...form,
			imap_host: p.imap,
			imap_port: 993,
			imap_secure: true,
			smtp_host: p.smtp,
			smtp_port: 465,
			smtp_secure: true
		});
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-xl font-bold",
					children: "دومينات مشتركة"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: "أضف إعدادات IMAP/SMTP للدومين مرة واحدة، وأي بريد على نفس الدومين يعمل تلقائياً بدون إضافة كل حساب على حدة."
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					onClick: () => setOpen(true),
					className: "inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Plus, { className: "h-4 w-4" }), "دومين جديد"]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "overflow-hidden rounded-2xl border border-border bg-card shadow-soft",
				children: domains.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "p-10 text-center text-sm text-muted-foreground",
					children: "لم تُضف أي دومين بعد."
				}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
					className: "divide-y divide-border",
					children: domains.map((d) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "flex items-center gap-4 p-4",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "flex h-10 w-10 items-center justify-center rounded-xl bg-brand-gradient/10 text-brand-accent",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Globe, { className: "h-5 w-5" })
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 flex-1",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
									className: "truncate font-semibold",
									dir: "ltr",
									children: ["@", d.domain]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
									className: "mt-0.5 truncate text-xs text-muted-foreground",
									dir: "ltr",
									children: [
										"IMAP ",
										d.imap_host,
										":",
										d.imap_port,
										" · SMTP ",
										d.smtp_host,
										":",
										d.smtp_port
									]
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: () => startEdit(d),
								className: "rounded-md p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary",
								title: "تعديل",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pencil, { className: "h-4 w-4" })
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: () => handleDelete(d.id),
								disabled: busyId === d.id,
								className: "rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
								title: "حذف",
								children: busyId === d.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Trash2, { className: "h-4 w-4" })
							})
						]
					}, d.id))
				})
			}),
			open && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Modal, {
				title: editingId ? "تعديل إعدادات الدومين" : "إعدادات دومين جديدة",
				onClose: closeModal,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
					onSubmit: handleSubmit,
					className: "space-y-4",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mb-1.5 text-xs font-medium text-muted-foreground",
							children: "اختصارات:"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "flex flex-wrap gap-1.5",
							children: IMAP_PRESETS.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => applyPreset(p),
								className: "rounded-md border border-input bg-background px-2 py-1 text-xs hover:border-primary hover:bg-muted",
								children: p.name
							}, p.name))
						})] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
							label: "الدومين",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								required: true,
								dir: "ltr",
								placeholder: "example.com",
								value: form.domain,
								onChange: (e) => setForm({
									...form,
									domain: e.target.value
								}),
								className: "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", {
							className: "rounded-xl border border-border p-3",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", {
								className: "px-1 text-xs font-semibold text-muted-foreground",
								children: "خادم الوارد (IMAP)"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-3 sm:grid-cols-[1fr_100px_auto]",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										placeholder: "imap.example.com",
										dir: "ltr",
										value: form.imap_host,
										onChange: (e) => setForm({
											...form,
											imap_host: e.target.value
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										type: "number",
										value: form.imap_port,
										onChange: (e) => setForm({
											...form,
											imap_port: Number(e.target.value)
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
										className: "flex items-center gap-2 text-xs",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: form.imap_secure,
											onChange: (e) => setForm({
												...form,
												imap_secure: e.target.checked
											})
										}), "SSL"]
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", {
							className: "rounded-xl border border-border p-3",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", {
								className: "px-1 text-xs font-semibold text-muted-foreground",
								children: "خادم الصادر (SMTP)"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-3 sm:grid-cols-[1fr_100px_auto]",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										placeholder: "smtp.example.com",
										dir: "ltr",
										value: form.smtp_host,
										onChange: (e) => setForm({
											...form,
											smtp_host: e.target.value
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										required: true,
										type: "number",
										value: form.smtp_port,
										onChange: (e) => setForm({
											...form,
											smtp_port: Number(e.target.value)
										}),
										className: "rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
										className: "flex items-center gap-2 text-xs",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: form.smtp_secure,
											onChange: (e) => setForm({
												...form,
												smtp_secure: e.target.checked
											})
										}), "SSL"]
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex justify-end gap-2 pt-2",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: closeModal,
								className: "rounded-lg px-4 py-2 text-sm hover:bg-muted",
								children: "إلغاء"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "submit",
								disabled: submitting,
								className: "inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60",
								children: [submitting && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }), "حفظ"]
							})]
						})
					]
				})
			})
		]
	});
}
function Field({ label, children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
		className: "mb-1.5 block text-sm font-medium",
		children: label
	}), children] });
}
function ColorInput({ label, value, onChange }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
		label,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-2 rounded-lg border border-input bg-background px-2 py-1.5",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
				type: "color",
				value,
				onChange: (e) => onChange(e.target.value),
				className: "h-8 w-10 cursor-pointer rounded border border-border bg-transparent"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
				value,
				onChange: (e) => onChange(e.target.value),
				className: "flex-1 bg-transparent px-2 text-sm outline-none",
				dir: "ltr"
			})]
		})
	});
}
function Modal({ title, onClose, children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
		onClick: onClose,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-float",
			onClick: (e) => e.stopPropagation(),
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mb-4 flex items-center justify-between",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
					className: "text-lg font-bold",
					children: title
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					onClick: onClose,
					className: "rounded-md p-1.5 text-muted-foreground hover:bg-muted",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "h-4 w-4" })
				})]
			}), children]
		})
	});
}
//#endregion
export { CompanyDashboard as component };
