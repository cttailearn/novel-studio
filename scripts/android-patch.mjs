// 给 Android 清单补齐「联网」与「应用内安装更新」需要的声明。
//
// src-tauri/gen/ 由 `tauri android init` 生成、不进版本库，直接手改会在下次
// 初始化时被覆盖，所以这些声明都在构建前用这个幂等脚本注入：
//   · INTERNET —— 连自建服务器（云端账号版）必需；
//   · REQUEST_INSTALL_PACKAGES —— 应用内下载并安装更新包；
//   · android:usesCleartextTraffic="true" —— 自建服务器常用 http。
//     明文流量有被中间人窃听的风险，正式部署请上 TLS；这条只是让"IP + 端口"
//     的自建场景不至于一装就白屏。仅当 <application> 上没有这个属性时写入。
//
// 重复执行不会重复插入；清单不存在时（例如只构建桌面端）安静退出。

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

// 顺序固定，保证重复执行时不会来回挪动。
const PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.REQUEST_INSTALL_PACKAGES",
];

const CLEARTEXT_ATTR = "android:usesCleartextTraffic";

if (!fs.existsSync(manifestPath)) {
  console.log(`[android-patch] 没有找到 ${manifestPath}，跳过`);
  process.exit(0);
}

const source = fs.readFileSync(manifestPath, "utf8");
let patched = source;
const added = [];
const notes = [];

// 1) 权限：缺哪条补哪条，统一插在 <manifest ...> 开头（同类声明聚在一起）。
// 一次插入整块，避免逐条插入时顺序被后一条挤到前面。
const missing = PERMISSIONS.filter((permission) => !patched.includes(permission));
if (missing.length > 0) {
  const block = missing
    .map((permission) => `    <uses-permission android:name="${permission}" />`)
    .join("\n");
  const existing = [...patched.matchAll(/^[ \t]*<uses-permission\b[^\n]*$/gm)];
  if (existing.length > 0) {
    // 已有权限声明时，接在最后一条后面，避免打乱原有顺序。
    const last = existing[existing.length - 1];
    const at = last.index + last[0].length;
    patched = `${patched.slice(0, at)}\n${block}${patched.slice(at)}`;
    added.push(...missing);
  } else if (/<manifest\b[^>]*>/.test(patched)) {
    // 用函数式替换：这样写不依赖替换串里的 $ 转义规则。
    patched = patched.replace(/<manifest\b[^>]*>/, (tag) => `${tag}\n${block}`);
    added.push(...missing);
  } else if (patched.includes("</manifest>")) {
    patched = patched.replace("</manifest>", `${block}\n</manifest>`);
    added.push(...missing);
  } else {
    notes.push(`清单里既没有 <manifest> 也没有 </manifest>，跳过 ${missing.join("、")}`);
  }
}

// 2) 明文流量：只补属性、不改已有取值（重复加属性会让 XML 非法）。
if (patched.includes(CLEARTEXT_ATTR)) {
  if (!new RegExp(`${CLEARTEXT_ATTR}\\s*=\\s*"true"`).test(patched)) {
    notes.push(
      `清单里已有 ${CLEARTEXT_ATTR} 且不是 true，保持原样；` +
        "若连不上 http 的自建服务器，请手动改成 true 或改用 https",
    );
  }
} else if (/<application\b/.test(patched)) {
  patched = patched.replace(/<application\b/, `<application\n        ${CLEARTEXT_ATTR}="true"`);
  added.push(`${CLEARTEXT_ATTR}="true"`);
} else {
  notes.push(
    "没找到 <application> 标签，跳过 usesCleartextTraffic；" +
      "如果客户端要连 http 自建服务器，请手动在 <application> 上补这个属性",
  );
}

if (patched !== source) {
  fs.writeFileSync(manifestPath, patched, "utf8");
  for (const item of added) console.log(`[android-patch] 已补 ${item}`);
} else {
  console.log("[android-patch] 清单已齐，无需修改");
}
for (const note of notes) console.log(`[android-patch] 注意：${note}`);
