// 给 Android 清单补上「安装未知来源应用」权限。
//
// src-tauri/gen/ 由 `tauri android init` 生成、不进版本库，直接手改会在下次
// 初始化时被覆盖，所以权限用这个幂等脚本在构建前注入。只碰一行，重复执行
// 不会重复插入；清单不存在时（例如只构建桌面端）安静退出。

import fs from "node:fs";
import path from "node:path";

const manifestPath = path.join(
  "src-tauri",
  "gen",
  "android",
  "app",
  "src",
  "main",
  "AndroidManifest.xml",
);
const permission =
  '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />';

if (!fs.existsSync(manifestPath)) {
  console.log(`[android-patch] 没有找到 ${manifestPath}，跳过`);
  process.exit(0);
}

const source = fs.readFileSync(manifestPath, "utf8");
if (source.includes("android.permission.REQUEST_INSTALL_PACKAGES")) {
  console.log("[android-patch] 权限已存在");
  process.exit(0);
}

// 挂在 INTERNET 之后，保持同类声明聚在一起；找不到就退到 </manifest> 前。
const anchor = source.match(/^.*android\.permission\.INTERNET.*$/m);
const patched = anchor
  ? source.replace(anchor[0], `${anchor[0]}\n${permission}`)
  : source.replace("</manifest>", `${permission}\n</manifest>`);

fs.writeFileSync(manifestPath, patched, "utf8");
console.log("[android-patch] 已写入 REQUEST_INSTALL_PACKAGES");
