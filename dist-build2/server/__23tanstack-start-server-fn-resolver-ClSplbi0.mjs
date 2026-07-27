//#region node_modules/.nitro/vite/services/ssr/assets/__23tanstack-start-server-fn-resolver-ClSplbi0.js
var manifest = {
	"07e077ac8b4a008c14da044a9e626ad59ce8b84691dca326efc520011a484a2c": {
		functionName: "indexMoveMessage_createServerFn_handler",
		importer: () => import("./_ssr/mail-move.functions-DjHx5qqt.mjs")
	},
	"10dfd7142f5adadcb59aa793ba2100c77efe52d0f07feaf12561f06a6e85d912": {
		functionName: "indexListFolderCounts_createServerFn_handler",
		importer: () => import("./_ssr/mail-index-counts.functions-DszTCs7g.mjs")
	},
	"301bf68a4f567a9e734abfdcac1afaf0bafd91f3350b015b3c702ab471260262": {
		functionName: "indexDeleteMessage_createServerFn_handler",
		importer: () => import("./_ssr/mail-delete.functions-4uDHd3UL.mjs")
	},
	"327ac5ac0e1714e9f50eb91753d07bf9895efb632982a12c238ef299c3ef508d": {
		functionName: "bridgeVerify_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"32db5cdba53eee787a6f7fe1dae32fc98931be298323bd1ceb5529de7a377064": {
		functionName: "bridgeDelete_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"3b6f2b9b4961ae54be116abbeaac1d639b00c2e0fbec888022f7870e0c699858": {
		functionName: "indexUpdateFlag_createServerFn_handler",
		importer: () => import("./_ssr/mail-flags.functions-B6O4tZJf.mjs")
	},
	"470e587b8f39a2eae6f2921521b05513dc06c1a1e18d9ec774287e953d1d3632": {
		functionName: "bridgeGetMessage_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"59077837af02770e500b75c1ba19c2ee3d51a9684072f6e64732a3110224a1bb": {
		functionName: "bridgeMove_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"69fe536d78d2baf335f7a8330d644ced154f7e59759b5bfbebb760f0c4244bf0": {
		functionName: "registerCompanyAdmin_createServerFn_handler",
		importer: () => import("./_ssr/admin-signup.functions-CHrsca3Q.mjs")
	},
	"6c499f2027a99a2541fe81c79775983aa1121e19daac7bb30efeb60724a68ce2": {
		functionName: "bridgeGetMessages_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"9d96f6f53a1b6dd76d3ec63208231f848583d83be1adc6cc36cd4ee3dd6fd762": {
		functionName: "bridgeSearch_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"a1985f859cc5bc1e0b9e353f558f7d9a34fc2937e905f76e70f92c7b3e928f83": {
		functionName: "indexListMessages_createServerFn_handler",
		importer: () => import("./_ssr/mail-index.functions-C1F29l-3.mjs")
	},
	"acdd37ebda76688b0815318aa8dd7bd40f42721d320b2ef20860693ffdf22fa4": {
		functionName: "runMailSync_createServerFn_handler",
		importer: () => import("./_ssr/mail-sync.functions-C7X76BIo.mjs")
	},
	"b7af3d175c6f1270c274f8b9d0e1b299aeb8350b1583ffbc335e7d134529d077": {
		functionName: "tombstoneGhostMessage_createServerFn_handler",
		importer: () => import("./_ssr/mail-ghost-cleanup.functions-83zNm8by.mjs")
	},
	"c2210e0ba513c48e31fc17077913076ad44a2f9a1f80e27805c5301fbc1f8a10": {
		functionName: "clientLogin_createServerFn_handler",
		importer: () => import("./_ssr/client-mail.functions-BhsJQc1p.mjs")
	},
	"e0c9f33b894f16849029ea602f0d79a6497ebca59de1257211c34d655aa8c966": {
		functionName: "bridgeStar_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"e5583fdf5640d377ae78898feeb5b3b128d34e3c1b64a2e726a8a530edb73efc": {
		functionName: "bridgeGetFolderCounts_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"e5f6a899687d0f7becc1aa5a6509ec7f3ed92bf56edb2a1b42dcb421fa7aea89": {
		functionName: "bridgeMarkRead_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	},
	"ea4b5b84770708bac663897582735c6885a66527eea00e5bae50e8be35b4806d": {
		functionName: "bridgeSend_createServerFn_handler",
		importer: () => import("./_ssr/mail-bridge.functions-C9GbVylE.mjs")
	}
};
async function getServerFnById(id, access) {
	const serverFnInfo = manifest[id];
	if (!serverFnInfo) throw new Error("Server function info not found for " + id);
	const fnModule = serverFnInfo.module ?? await serverFnInfo.importer();
	if (!fnModule) throw new Error("Server function module not resolved for " + id);
	const action = fnModule[serverFnInfo.functionName];
	if (!action) throw new Error("Server function module export not resolved for serverFn ID: " + id);
	return action;
}
//#endregion
export { getServerFnById as t };
