import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/admin-signup.functions-CHrsca3Q.js
/**
* Public endpoint: register a new company + its first company_admin.
* Used from the hidden /admin-portal route.
*/
var registerCompanyAdmin_createServerFn_handler = createServerRpc({
	id: "69fe536d78d2baf335f7a8330d644ced154f7e59759b5bfbebb760f0c4244bf0",
	name: "registerCompanyAdmin",
	filename: "src/lib/admin-signup.functions.ts"
}, (opts) => registerCompanyAdmin.__executeServer(opts));
var registerCompanyAdmin = createServerFn({ method: "POST" }).inputValidator((input) => {
	if (!input.company_name?.trim()) throw new Error("اسم الشركة مطلوب");
	if (!/^[a-z0-9-]{3,40}$/.test(input.company_slug)) throw new Error("المعرّف يجب أن يكون أحرفاً إنجليزية صغيرة/أرقاماً/شرطات (3-40)");
	if (!input.email?.includes("@")) throw new Error("بريد غير صالح");
	if (!input.password || input.password.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
	if (!input.full_name?.trim()) throw new Error("الاسم الكامل مطلوب");
	return input;
}).handler(registerCompanyAdmin_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { data: existing } = await supabaseAdmin.from("companies").select("id").eq("slug", data.company_slug).maybeSingle();
	if (existing) throw new Error("هذا المعرّف مستخدم بالفعل، اختر معرّفاً آخر");
	const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
		email: data.email,
		password: data.password,
		email_confirm: true,
		user_metadata: { full_name: data.full_name }
	});
	if (createErr) throw new Error(createErr.message);
	const newUserId = created.user?.id;
	if (!newUserId) throw new Error("فشل إنشاء المستخدم");
	const { data: company, error: companyErr } = await supabaseAdmin.from("companies").insert({
		name: data.company_name,
		slug: data.company_slug,
		app_name: data.company_name
	}).select().single();
	if (companyErr) {
		await supabaseAdmin.auth.admin.deleteUser(newUserId);
		throw new Error(companyErr.message);
	}
	await supabaseAdmin.from("profiles").upsert({
		id: newUserId,
		email: data.email,
		full_name: data.full_name,
		company_id: company.id
	}, { onConflict: "id" });
	await supabaseAdmin.from("user_roles").insert({
		user_id: newUserId,
		role: "company_admin",
		company_id: company.id
	});
	return {
		ok: true,
		company_id: company.id
	};
});
//#endregion
export { registerCompanyAdmin_createServerFn_handler };
