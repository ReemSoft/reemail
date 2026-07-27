import { h as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { T as require_jsx_runtime } from "../_libs/@radix-ui/react-alert-dialog+[...].mjs";
import { D as Mail, J as Cloud, X as CircleCheck, it as ArrowLeft, r as Users, t as Zap, u as Shield, w as Palette } from "../_libs/lucide-react.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes--qfgSg7V.js
var import_jsx_runtime = require_jsx_runtime();
function Landing() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "min-h-screen bg-background",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", {
				className: "sticky top-0 z-40 border-b border-border/60 glass",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
							to: "/",
							className: "flex items-center gap-2.5",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient shadow-brand",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "h-5 w-5 text-white" })
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "text-lg font-bold tracking-tight",
								children: "MailMaestro"
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("nav", {
							className: "hidden items-center gap-8 md:flex",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
									href: "#features",
									className: "text-sm text-muted-foreground hover:text-foreground",
									children: "المزايا"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
									href: "#how",
									className: "text-sm text-muted-foreground hover:text-foreground",
									children: "كيف يعمل"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
									href: "#pricing",
									className: "text-sm text-muted-foreground hover:text-foreground",
									children: "الأسعار"
								})
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-2",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
								to: "/login",
								className: "hidden rounded-lg px-4 py-2 text-sm font-medium text-foreground hover:bg-muted sm:inline-block",
								children: "تسجيل الدخول"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
								to: "/company",
								className: "inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated",
								children: ["ابدأ مجاناً", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowLeft, { className: "h-4 w-4" })]
							})]
						})
					]
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "relative overflow-hidden px-4 pt-20 pb-24 sm:pt-28 sm:pb-32",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "absolute inset-0 -z-10 opacity-40",
						style: { background: "radial-gradient(60% 50% at 50% 0%, hsl(var(--brand-accent) / 0.25) 0%, transparent 100%)" }
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mx-auto max-w-4xl text-center animate-in-up",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-1.5 text-xs font-medium text-muted-foreground shadow-soft",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "flex h-1.5 w-1.5 rounded-full bg-emerald-500" }), "منصة SaaS جاهزة لشركتك"]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h1", {
								className: "text-balance text-4xl font-extrabold leading-tight tracking-tight text-foreground sm:text-6xl md:text-7xl",
								children: [
									"بريدك المؤسسي",
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "bg-brand-gradient bg-clip-text text-transparent",
										children: "بسرعة البرق"
									})
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mx-auto mt-6 max-w-2xl text-balance text-lg text-muted-foreground sm:text-xl",
								children: "افتح أي حساب بريد إلكتروني عبر إعداداته البسيطة. لكل شركة شعارها وألوانها، ولكل عميل تجربة استخدام سلسة كأنها من صنع علامتك التجارية."
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
									to: "/company",
									className: "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-gradient px-6 py-3.5 text-base font-semibold text-white shadow-brand transition hover:scale-[1.02] sm:w-auto",
									children: ["ابدأ تجربتك المجانية", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowLeft, { className: "h-4 w-4" })]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
									to: "/login",
									className: "inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 py-3.5 text-base font-semibold text-foreground shadow-soft transition hover:border-brand-accent sm:w-auto",
									children: "لدي حساب — دخول"
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "flex items-center gap-1.5",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleCheck, { className: "h-4 w-4 text-emerald-500" }), " بدون بطاقة ائتمانية"]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "flex items-center gap-1.5",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleCheck, { className: "h-4 w-4 text-emerald-500" }), " IMAP/SMTP قياسي"]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "flex items-center gap-1.5",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleCheck, { className: "h-4 w-4 text-emerald-500" }), " تخصيص كامل بالعلامة"]
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mx-auto mt-16 max-w-5xl",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "relative rounded-2xl border border-border bg-card p-2 shadow-float",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "rounded-xl bg-surface p-1",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "flex h-96 items-center justify-center rounded-lg bg-brand-gradient/5",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
										to: "/login",
										className: "rounded-xl bg-brand-gradient px-6 py-3 text-white shadow-brand",
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
											className: "flex items-center gap-2",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "h-5 w-5" }), " افتح تجربة الواجهة"]
										})
									})
								})
							})
						})
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", {
				id: "features",
				className: "border-t border-border bg-surface px-4 py-24",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mx-auto max-w-6xl",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mx-auto max-w-2xl text-center",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
							className: "text-3xl font-bold tracking-tight sm:text-4xl",
							children: "كل ما تحتاجه شركتك في مكان واحد"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-4 text-lg text-muted-foreground",
							children: "منصة كاملة للشركات لتقديم بريد إلكتروني احترافي لعملائها"
						})]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-3",
						children: [
							{
								icon: Zap,
								title: "أداء سرعة البرق",
								desc: "واجهة محسّنة تحمّل صندوق الوارد فوراً مع كاش ذكي وتحديثات فورية."
							},
							{
								icon: Palette,
								title: "تخصيص كامل بالعلامة",
								desc: "شعارك، ألوانك، اسم التطبيق — كل شركة تظهر كتطبيق مصمّم خصيصاً لها."
							},
							{
								icon: Shield,
								title: "أمان مؤسسي",
								desc: "تشفير AES-GCM لكل كلمات المرور، عزل تام بين بيانات الشركات."
							},
							{
								icon: Users,
								title: "متعدد المستخدمين",
								desc: "لوحة تحكم لكل شركة لإدارة عملائها وحساباتهم بسهولة."
							},
							{
								icon: Mail,
								title: "IMAP/SMTP قياسي",
								desc: "يعمل مع أي خادم بريد: Gmail، Outlook، cPanel، خوادم مخصصة."
							},
							{
								icon: Cloud,
								title: "متجاوب لكل الشاشات",
								desc: "تجربة مثالية على الموبايل والتابلت والديسكتوب."
							}
						].map((f) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "group rounded-2xl border border-border bg-card p-6 shadow-soft transition hover:border-brand-accent/40 hover:shadow-elevated",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-foreground transition group-hover:bg-brand-gradient group-hover:text-white",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(f.icon, { className: "h-5 w-5" })
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
									className: "mt-4 text-lg font-semibold",
									children: f.title
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "mt-2 text-sm text-muted-foreground leading-relaxed",
									children: f.desc
								})
							]
						}, f.title))
					})]
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", {
				id: "pricing",
				className: "px-4 py-24",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mx-auto max-w-3xl rounded-3xl bg-brand-gradient p-10 text-center shadow-brand sm:p-16",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
							className: "text-3xl font-bold tracking-tight text-white sm:text-4xl",
							children: "جاهز لتقديم بريد إلكتروني احترافي لعملائك؟"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-4 text-lg text-white/85",
							children: "سجّل الآن وابدأ خلال دقائق — بدون بطاقة ائتمانية."
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
							to: "/company",
							className: "mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 text-base font-semibold text-foreground shadow-elevated transition hover:scale-[1.02]",
							children: ["ابدأ الآن مجاناً", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowLeft, { className: "h-4 w-4" })]
						})
					]
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("footer", {
				className: "border-t border-border py-8",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 text-sm text-muted-foreground sm:flex-row",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
						"© ",
						(/* @__PURE__ */ new Date()).getFullYear(),
						" MailMaestro. جميع الحقوق محفوظة."
					] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex gap-6",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							href: "#",
							className: "hover:text-foreground",
							children: "الخصوصية"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							href: "#",
							className: "hover:text-foreground",
							children: "الشروط"
						})]
					})]
				})
			})
		]
	});
}
//#endregion
export { Landing as component };
