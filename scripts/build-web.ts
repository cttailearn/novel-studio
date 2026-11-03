#!/usr/bin/env node
/**
 * 把「浏览器端」装配成 Tauri 的 frontendDist。
 *
 *   node --experimental-strip-types scripts/build-web.ts
 *
 * 产物结构：
 *   dist/web/index.html
 *   dist/web/app.js / settings.js / style.css / settings.css / boot.js
 *   dist/web/manifest.json / icon.svg
 *   dist/web/browser/**        ← 由 scripts/browser-build.ts 生成
 *
 * 不复制 src/、scripts/、node_modules/ —— Tauri 包里只该有运行所需的前端。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowser } from "./browser-build.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");
const OUT_DIR = path.join(REPO_ROOT, "dist", "web");

function copyPublic(): void {
	fs.cpSync(PUBLIC_DIR, OUT_DIR, {
		recursive: true,
		filter(source) {
			const rel = path.relative(PUBLIC_DIR, source);
			if (!rel) return true;
			// browser 目录由 buildBrowser 重新生成；其余临时/系统文件不进包。
			if (rel === "browser" || rel.startsWith(`browser${path.sep}`)) return false;
			const base = path.basename(source);
			return base !== ".DS_Store" && base !== "Thumbs.db";
		},
	});
}

async function main(): Promise<void> {
	fs.rmSync(OUT_DIR, { recursive: true, force: true });
	fs.mkdirSync(OUT_DIR, { recursive: true });
	copyPublic();

	const report = await buildBrowser({ outDir: "dist/web/browser", quiet: true });
	console.log("Tauri 前端构建完成");
	console.log(`  输出目录：${OUT_DIR}`);
	console.log(`  浏览器模块：${report.files} 个文件 / ${(report.bytes / 1024).toFixed(1)} KB`);
	for (const warning of report.warnings) console.log(`  ! ${warning}`);
	if (!fs.existsSync(path.join(OUT_DIR, "index.html"))) {
		throw new Error("产物缺少 index.html");
	}
	if (!fs.existsSync(path.join(OUT_DIR, "browser", "local-api.js"))) {
		throw new Error("产物缺少 browser/local-api.js");
	}
}

main().catch((error: unknown) => {
	console.error(`构建失败：${(error as Error).message}`);
	process.exitCode = 1;
});
