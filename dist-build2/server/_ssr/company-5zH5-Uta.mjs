import { n as __toESM } from "../_runtime.mjs";
import { g as useNavigate, h as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { T as require_jsx_runtime } from "../_libs/@radix-ui/react-alert-dialog+[...].mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
import { n as useServerFn, t as createSsrRpc } from "./createSsrRpc-FHPyW8kf.mjs";
import { t as supabase } from "./client-C8x6RfeV.mjs";
import { n as toast } from "../_libs/sonner.mjs";
import { A as LogIn, D as Mail, M as LoaderCircle, it as ArrowLeft, nt as Building2 } from "../_libs/lucide-react.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/company-5zH5-Uta.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
/**
* Public endpoint: register a new company + its first company_admin.
* Used from the hidden /admin-portal route.
*/
var registerCompanyAdmin = createServerFn({ method: "POST" }).inputValidator((input) => {
	if (!input.company_name?.trim()) throw new Error("اسم الشركة مطلوب");
	if (!/^[a-z0-9-]{3,40}$/.test(input.company_slug)) throw new Error("المعرّف يجب أن يكون أحرفاً إنجليزية صغيرة/أرقاماً/شرطات (3-40)");
	if (!input.email?.includes("@")) throw new Error("بريد غير صالح");
	if (!input.password || input.password.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
	if (!input.full_name?.trim()) throw new Error("الاسم الكامل مطلوب");
	return input;
}).handler(createSsrRpc("69fe536d78d2baf335f7a8330d644ced154f7e59759b5bfbebb760f0c4244bf0"));
async function destinationForUser(userId) {
	const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
	const list = (roles ?? []).map((r) => r.role);
	if (list.includes("company_admin") || list.includes("super_admin")) return "/dashboard";
	return "/mail";
}
function CompanyPortalPage() {
	const navigate = useNavigate();
	const [mode, setMode] = (0, import_react.useState)("register");
	const [checkingSession, setCheckingSession] = (0, import_react.useState)(true);
	(0, import_react.useEffect)(() => {
		supabase.auth.getSession().then(async ({ data }) => {
			if (data.session) navigate({ to: await destinationForUser(data.session.user.id) });
			else setCheckingSession(false);
		});
	}, [navigate]);
	if (checkingSession) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex min-h-screen items-center justify-center bg-background",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-6 w-6 animate-spin text-primary" })
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex min-h-screen bg-background",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "relative hidden w-1/2 overflow-hidden bg-brand-gradient lg:block",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "absolute inset-0 opacity-20",
				style: {
					backgroundImage: "radial-gradient(circle at 20% 30%, white 1px, transparent 1px), radial-gradient(circle at 80% 70%, white 1px, transparent 1px)",
					backgroundSize: "60px 60px"
				}
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "relative flex h-full flex-col justify-between p-12 text-white",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
						to: "/",
						className: "flex items-center gap-2.5",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "h-5 w-5" })
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "text-xl font-bold",
							children: "MailMaestro"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", {
						className: "text-4xl font-bold leading-tight",
						children: [
							"أدِر إيميلات",
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
							"عملائك من مكان واحد"
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-4 text-lg text-white/85",
						children: "منصة بيضاء العلامة (White-label) لشركتك."
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "text-sm text-white/70",
						children: [
							"© ",
							(/* @__PURE__ */ new Date()).getFullYear(),
							" MailMaestro"
						]
					})
				]
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "flex w-full items-center justify-center p-6 lg:w-1/2",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "w-full max-w-md",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
						to: "/",
						className: "mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowLeft, { className: "h-4 w-4" }), " العودة"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mb-8 grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-1.5",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => setMode("register"),
							className: `flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${mode === "register" ? "bg-brand-gradient text-white shadow-soft" : "text-muted-foreground hover:text-foreground"}`,
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Building2, { className: "h-4 w-4" }), " تسجيل شركة جديدة"]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => setMode("signin"),
							className: `flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${mode === "signin" ? "bg-brand-gradient text-white shadow-soft" : "text-muted-foreground hover:text-foreground"}`,
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogIn, { className: "h-4 w-4" }), " دخول المدير"]
						})]
					}),
					mode === "signin" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SignInForm, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RegisterCompanyForm, { onDone: () => setMode("signin") }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-8 rounded-xl border border-border bg-card p-4 text-center text-sm",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "text-muted-foreground",
							children: "هل أنت عميل تريد فتح بريدك؟"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
							to: "/login",
							className: "mt-1 inline-block font-semibold text-primary hover:underline",
							children: "دخول العملاء ←"
						})]
					})
				]
			})
		})]
	});
}
function SignInForm() {
	const navigate = useNavigate();
	const [email, setEmail] = (0, import_react.useState)("");
	const [password, setPassword] = (0, import_react.useState)("");
	const [loading, setLoading] = (0, import_react.useState)(false);
	async function handleSubmit(e) {
		e.preventDefault();
		setLoading(true);
		try {
			const { data: signIn, error } = await supabase.auth.signInWithPassword({
				email,
				password
			});
			if (error) throw error;
			const dest = await destinationForUser(signIn.user.id);
			toast.success("مرحباً بعودتك 👋");
			navigate({ to: dest });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "حدث خطأ غير متوقع";
			toast.error(msg);
		} finally {
			setLoading(false);
		}
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
			className: "text-3xl font-bold tracking-tight",
			children: "دخول مدير الشركة"
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "mt-2 text-muted-foreground",
			children: "سجّل دخولك للوصول إلى لوحة تحكم شركتك."
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
			onSubmit: handleSubmit,
			className: "mt-8 space-y-4",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
					label: "البريد الإلكتروني",
					type: "email",
					value: email,
					onChange: setEmail,
					placeholder: "you@company.com",
					required: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
					label: "كلمة المرور",
					type: "password",
					value: password,
					onChange: setPassword,
					placeholder: "••••••••",
					minLength: 6,
					required: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SubmitButton, {
					loading,
					children: "تسجيل الدخول"
				})
			]
		})
	] });
}
function RegisterCompanyForm({ onDone }) {
	const navigate = useNavigate();
	const register = useServerFn(registerCompanyAdmin);
	const [companyName, setCompanyName] = (0, import_react.useState)("");
	const [companySlug, setCompanySlug] = (0, import_react.useState)("");
	const [fullName, setFullName] = (0, import_react.useState)("");
	const [email, setEmail] = (0, import_react.useState)("");
	const [password, setPassword] = (0, import_react.useState)("");
	const [loading, setLoading] = (0, import_react.useState)(false);
	function handleNameChange(v) {
		setCompanyName(v);
		const auto = v.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 40);
		if (auto && (companySlug === "" || companySlug === v.slice(0, companySlug.length))) setCompanySlug(auto);
	}
	async function handleSubmit(e) {
		e.preventDefault();
		setLoading(true);
		try {
			await register({ data: {
				company_name: companyName,
				company_slug: companySlug,
				full_name: fullName,
				email,
				password
			} });
			const { error: signErr } = await supabase.auth.signInWithPassword({
				email,
				password
			});
			if (signErr) {
				toast.success("تم إنشاء الشركة. سجّل الدخول الآن.");
				onDone();
				return;
			}
			toast.success("مرحباً بك! جاري تجهيز لوحة التحكم…");
			navigate({ to: "/dashboard" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "حدث خطأ غير متوقع";
			toast.error(msg);
		} finally {
			setLoading(false);
		}
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
			className: "text-3xl font-bold tracking-tight",
			children: "سجّل شركتك"
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "mt-2 text-muted-foreground",
			children: "أنشئ حساب شركتك في دقيقة، ثم أضف إيميلات عملائك."
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
			onSubmit: handleSubmit,
			className: "mt-8 space-y-4",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
					label: "اسم الشركة",
					type: "text",
					value: companyName,
					onChange: handleNameChange,
					placeholder: "مثال: MailMaestro",
					required: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
					label: "معرّف الشركة (بالإنجليزية)",
					type: "text",
					value: companySlug,
					onChange: (v) => setCompanySlug(v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					placeholder: "mailmaestro",
					minLength: 3,
					maxLength: 40,
					required: true,
					ltr: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
					label: "اسمك الكامل",
					type: "text",
					value: fullName,
					onChange: setFullName,
					placeholder: "محمد أحمد",
					required: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
					label: "بريدك الإلكتروني",
					type: "email",
					value: email,
					onChange: setEmail,
					placeholder: "you@company.com",
					required: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
					label: "كلمة المرور",
					type: "password",
					value: password,
					onChange: setPassword,
					placeholder: "6 أحرف على الأقل",
					minLength: 6,
					required: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SubmitButton, {
					loading,
					children: "إنشاء الشركة"
				})
			]
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "mt-6 text-center text-xs text-muted-foreground",
			children: "بالتسجيل أنت توافق على شروط الاستخدام."
		})
	] });
}
function Field({ label, type, value, onChange, placeholder, required, minLength, maxLength, ltr }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
		className: "mb-1.5 block text-sm font-medium text-foreground",
		children: label
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
		type,
		required,
		minLength,
		maxLength,
		value,
		onChange: (e) => onChange(e.target.value),
		placeholder,
		dir: ltr || type === "email" || type === "password" ? "ltr" : void 0,
		className: "w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
	})] });
}
function SubmitButton({ loading, children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
		type: "submit",
		disabled: loading,
		className: "mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated disabled:opacity-60",
		children: [loading && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }), children]
	});
}
//#endregion
export { CompanyPortalPage as component };
