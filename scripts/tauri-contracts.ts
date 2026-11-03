/**
 * Tauri 桌面/移动适配的静态契约。
 *
 * 这里不编译 Rust，也不启动窗口 —— 那些由 `cargo check` / `tauri build`
 * 负责。这个脚本只盯住"接线有没有断"：配置、命令注册、前端桥、SQLite
 * 适配、构建脚本和忽略规则。真实窗口验收仍以 `pnpm dev:tauri` 为准。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;

function read(rel: string): string {
	const file = path.join(ROOT, rel);
	assert.ok(fs.existsSync(file), `缺少文件：${rel}`);
	return fs.readFileSync(file, "utf8");
}

function has(rel: string, needle: string, label = needle): void {
	const text = read(rel);
	assert.ok(text.includes(needle), `${rel} 缺少 ${label}`);
	checks += 1;
}

function notHas(rel: string, needle: string): void {
	const text = read(rel);
	assert.ok(!text.includes(needle), `${rel} 不应包含 ${needle}`);
	checks += 1;
}

// 1) Tauri 配置
const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
	productName: string;
	identifier: string;
	build: { frontendDist: string; beforeBuildCommand: string };
	app: { security: { csp: string } };
	bundle: { active: boolean };
};
assert.equal(conf.productName, "墨耕");
assert.equal(conf.identifier, "com.mogeng.novelstudio");
assert.equal(conf.build.frontendDist, "../dist/web");
assert.equal(conf.build.beforeBuildCommand, "pnpm build:web");
assert.equal(conf.bundle.active, true);
const csp = conf.app.security.csp;
assert.ok(csp.includes("connect-src 'self'"), "CSP connect-src 需放行应用自身资源");
assert.ok(csp.includes("http://tauri.localhost"), "CSP connect-src 需放行 Android WebView 源");
assert.ok(csp.includes("script-src 'self'"), "CSP script-src 需放行本地脚本");
checks += 8;

// 2) Rust 命令与安全边界
has("src-tauri/src/lib.rs", "llm::proxy_stream", "命令 proxy_stream");
has("src-tauri/src/lib.rs", "sqlite::sqlite_apply", "命令 sqlite_apply");
has("src-tauri/src/lib.rs", "secure::secure_get", "命令 secure_get");
has("src-tauri/src/lib.rs", "files::save_text_file", "命令 save_text_file");
has("src-tauri/src/lib.rs", "files::save_binary_file", "命令 save_binary_file");
has("src-tauri/src/llm.rs", "validate_target", "SSRF 目标校验");
has("src-tauri/src/llm.rs", "ProxyEvent", "代理事件");
has("src-tauri/src/sqlite.rs", "CREATE TABLE IF NOT EXISTS indexes", "索引持久化表");
has("src-tauri/src/sqlite.rs", "sqlite_create_index", "命令 sqlite_create_index");
has("src-tauri/src/secure.rs", "keyring::Entry", "系统密钥串");
has("src-tauri/src/files.rs", "save_binary_file", "二进制保存");

// 3) 浏览器适配层
has("src/browser/tauri.ts", "proxy_stream", "代理调用");
has("src/browser/tauri.ts", "ReadableStream", "流式响应");
has("src/browser/tauri.ts", "proxy_abort", "中止支持");
notHas("src/browser/tauri.ts", 'from "node:');
has("src/browser/tauri-idb.ts", "sqlite_stores", "读取 store 元数据");
has("src/browser/tauri-idb.ts", "sqlite_load", "读取数据");
has("src/browser/tauri-idb.ts", "sqlite_indexes", "读取索引");
has("src/browser/tauri-idb.ts", "sqlite_apply", "事务写入");
has("src/browser/tauri-idb.ts", "sqlite_create_index", "写索引");
has("src/browser/tauri-credentials.ts", "secure_get", "读取系统密钥");
has("src/browser/tauri-credentials.ts", "secure_set", "写入系统密钥");
has("src/browser/tauri-credentials.ts", "secure_delete", "删除系统密钥");
has("src/browser/local-api.ts", "tauriIdbFactory", "注入 SQLite IDB");
has("src/browser/local-api.ts", "TauriCredentialStore", "注入密钥串");
has("public/boot.js", "__mogengSaveFile", "原生保存桥");
has("public/app.js", "saveFileNatively", "导出优先原生保存");
has("public/theme-init.js", "novel-studio-theme", "外置主题初始化");
has("public/index.html", 'src="/theme-init.js"', "外置主题脚本");
has("public/index.html", 'type="importmap"', "本地模块映射");
has("src-tauri/tauri.conf.json", "sha256-RoCo17mg2L28PKX0s91jqg5RPqGw4sJIGfWCw8anmVs=", "importmap CSP 哈希");

// 4) 构建与忽略
has("scripts/build-web.ts", "dist/web", "前端产物目录");
has("scripts/build-web.ts", "buildBrowser", "复用浏览器构建");
has("package.json", '"build:web"', "build:web 脚本");
has("package.json", '"dev:tauri"', "dev:tauri 脚本");
has("package.json", '"build:tauri"', "build:tauri 脚本");
has("src-tauri/package.json", "pnpm --dir .. exec tauri", "Gradle 的 tauri CLI 转发");
has(".gitignore", "src-tauri/target/", "忽略 Rust target");
has(".gitignore", "src-tauri/gen/", "忽略 Android gen");

console.log(`Tauri 契约检查通过：${checks} 项`);
