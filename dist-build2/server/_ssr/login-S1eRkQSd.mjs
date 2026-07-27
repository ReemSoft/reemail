import { n as __toESM } from "../_runtime.mjs";
import { g as useNavigate, h as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { T as require_jsx_runtime } from "../_libs/@radix-ui/react-alert-dialog+[...].mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
import { n as useServerFn, t as createSsrRpc } from "./createSsrRpc-FHPyW8kf.mjs";
import { n as toast } from "../_libs/sonner.mjs";
import { D as Mail, M as LoaderCircle, it as ArrowLeft, j as Lock } from "../_libs/lucide-react.mjs";
import { n as getMailSession, r as saveMailSession } from "./mail-session-j1dYUlkq.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/login-S1eRkQSd.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
/**
* Client (email-owner) login.
* The client is NOT a platform user — they are simply the owner of an email
* address the company admin has configured. We look up the mail_account by
* email, then verify the password directly against the real IMAP server via
* the bridge. The password stays only in the browser session, never in the database.
*/
var clientLogin = createServerFn({ method: "POST" }).inputValidator((input) => {
	if (!input.email || !input.email.includes("@")) return {
		email: "",
		password: input.password ?? "",
		validationError: "بريد غير صالح"
	};
	if (!input.password || input.password.length < 3) return {
		email: input.email.trim().toLowerCase(),
		password: input.password ?? "",
		validationError: "كلمة المرور مطلوبة"
	};
	return {
		email: input.email.trim().toLowerCase(),
		password: input.password
	};
}).handler(createSsrRpc("c2210e0ba513c48e31fc17077913076ad44a2f9a1f80e27805c5301fbc1f8a10"));
function LoginPage() {
	const navigate = useNavigate();
	const login = useServerFn(clientLogin);
	const [email, setEmail] = (0, import_react.useState)("");
	const [password, setPassword] = (0, import_react.useState)("");
	const [loading, setLoading] = (0, import_react.useState)(false);
	(0, import_react.useEffect)(() => {
		if (getMailSession()) navigate({ to: "/mail" });
	}, [navigate]);
	async function handleSubmit(e) {
		e.preventDefault();
		setLoading(true);
		try {
			const result = await login({ data: {
				email,
				password
			} });
			if (!result.ok) {
				toast.error(result.message);
				return;
			}
			saveMailSession({
				account: result.account,
				company: result.company,
				password,
				mailSessionToken: result.mailSessionToken,
				mailSessionTokenExpiresAt: result.mailSessionTokenExpiresAt
			});
			toast.success("تم فتح البريد ✨");
			navigate({ to: "/mail" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "بيانات الدخول غير صحيحة";
			toast.error(msg);
		} finally {
			setLoading(false);
		}
	}
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
							"افتح بريدك",
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
							"بسرعة البرق ⚡"
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-4 text-lg text-white/85",
						children: "أدخل بريدك وكلمة مروره فقط — لا حاجة لأي حساب إضافي."
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
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-gradient/10 text-brand-accent",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Lock, { className: "h-6 w-6" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
						className: "text-3xl font-bold tracking-tight",
						children: "افتح بريدك"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-2 text-muted-foreground",
						children: "استخدم عنوان بريدك وكلمة مروره الحقيقية. كلمة المرور تُستخدم فقط في هذه الجلسة ولا تُخزَّن."
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
						onSubmit: handleSubmit,
						className: "mt-8 space-y-4",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
								className: "mb-1.5 block text-sm font-medium text-foreground",
								children: "البريد الإلكتروني"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "email",
								required: true,
								value: email,
								onChange: (e) => setEmail(e.target.value),
								placeholder: "you@company.com",
								dir: "ltr",
								autoComplete: "email",
								className: "w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
							})] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
								className: "mb-1.5 block text-sm font-medium text-foreground",
								children: "كلمة مرور البريد"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "password",
								required: true,
								minLength: 3,
								value: password,
								onChange: (e) => setPassword(e.target.value),
								placeholder: "••••••••",
								dir: "ltr",
								autoComplete: "current-password",
								className: "w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
							})] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "submit",
								disabled: loading,
								className: "mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated disabled:opacity-60",
								children: [loading && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }), "فتح البريد"]
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-8 rounded-xl border border-border bg-card p-4 text-center text-sm",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "text-muted-foreground",
							children: "هل أنت صاحب شركة؟"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
							to: "/company",
							className: "mt-1 inline-block font-semibold text-primary hover:underline",
							children: "سجّل شركتك أو ادخل إلى لوحة التحكم ←"
						})]
					})
				]
			})
		})]
	});
}
//#endregion
export { LoginPage as component };
