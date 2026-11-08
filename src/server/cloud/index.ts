/**
 * 云端账号模块的入口。
 *
 * `openCloud` 是 app.ts 唯一需要调的函数：它把库、鉴权、管理员服务、
 * 路由拼成一个 CloudServices，并在拿不到数据库（比如 DATA_DIR 不可写）时
 * 老老实实抛出来 —— 云端模式下账号库起不来，整个进程都不该假装健康。
 */
import type { ApiRequest, ApiSink } from "../api-router.ts";
import type { AppConfig } from "../../config/env.ts";
import { AdminService } from "./admin.ts";
import { AuthService } from "./auth.ts";
import { CloudDb } from "./db.ts";
import { CloudRouter } from "./routes.ts";
import type { AuthContext, CloudDeps, CloudRequestContext, CloudServices } from "./types.ts";

// 类型从这里统一再导出一次，app.ts 只 import 这个入口就够。
export type {
	AdminUser,
	AuthContext,
	CloudDeps,
	CloudRequestContext,
	CloudServices,
	PublicUser,
	Usage,
	UsageBreakdown,
	UsageProvider,
	UserRole,
	UserStatus,
} from "./types.ts";

/** 启动时清一次过期会话；之后每小时清一次。 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

class CloudRuntime implements CloudServices {
	readonly mode = "users" as const;
	private readonly db: CloudDb;
	private readonly auth: AuthService;
	private readonly router: CloudRouter;
	private readonly sweep: ReturnType<typeof setInterval>;
	private closed = false;

	constructor(db: CloudDb, auth: AuthService, router: CloudRouter) {
		this.db = db;
		this.auth = auth;
		this.router = router;
		this.sweep = setInterval(() => this.sweepOnce(), SWEEP_INTERVAL_MS);
		// 定时器不能把进程吊住：测试脚本跑完要能自己退出。
		this.sweep.unref();
	}

	handle(req: ApiRequest, sink: ApiSink, ctx: CloudRequestContext): Promise<boolean> {
		return this.router.handle(req, sink, ctx);
	}

	authenticate(req: ApiRequest, ctx: CloudRequestContext): Promise<AuthContext | null> {
		return this.auth.authenticate(req, ctx);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.sweep);
		this.auth.dispose();
		this.db.close();
	}

	private sweepOnce(): void {
		try {
			this.auth.pruneRateLimits();
			this.auth.purgeSessions();
		} catch (error) {
			// 清理失败不影响在线请求，下一轮再来。
			console.error("[cloud] 定时清理失败", error);
		}
	}
}

/** 打开云端账号服务。storage=users 时由 app.ts 调用一次。 */
export async function openCloud(config: AppConfig, deps: CloudDeps): Promise<CloudServices> {
	const db = CloudDb.open(config.dataDir);
	try {
		const auth = new AuthService({ db, config: config.auth, usage: deps.usage });
		// 播种放在建路由之前：即便播种失败，服务本身还能起来（只是没有管理员）。
		const seeded = await auth.seedAdmin();
		if (seeded) console.log("[cloud] 已按 ADMIN_EMAIL 创建管理员：" + seeded.email);
		try {
			auth.purgeSessions();
		} catch (error) {
			console.error("[cloud] 启动清理过期会话失败", error);
		}
		const admin = new AdminService({
			auth,
			db,
			config: config.auth,
			usage: deps.usage,
			dataDir: config.dataDir,
			onDeleteUser: deps.onDeleteUser,
		});
		const router = new CloudRouter({ auth, admin, config: config.auth, corsOrigins: config.corsOrigins });
		return new CloudRuntime(db, auth, router);
	} catch (error) {
		db.close();
		throw error;
	}
}
