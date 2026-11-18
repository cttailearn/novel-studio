// 给 Android 清单补齐「联网」与「应用内安装更新」需要的声明，并让界面
// 落在系统栏之内。
//
// src-tauri/gen/ 由 `tauri android init` 生成、不进版本库，直接手改会在下次
// 初始化时被覆盖，所以这些声明都在构建前用这个幂等脚本注入：
//   · INTERNET —— 连自建服务器（云端账号版）必需；
//   · REQUEST_INSTALL_PACKAGES —— 应用内下载并安装更新包；
//   · android:usesCleartextTraffic="true" —— 自建服务器常用 http。
//     明文流量有被中间人窃听的风险，正式部署请上 TLS；这条只是让"IP + 端口"
//     的自建场景不至于一装就白屏。仅当 <application> 上没有这个属性时写入。
//   · MainActivity 的 insets 监听 —— Android 15 起强制 edge-to-edge，
//     WebView 会画到状态栏下面，而 WebView 里的 env(safe-area-inset-*) 是 0，
//     于是顶栏那排按钮正好落在状态栏底下点不到。这里给根视图补一圈 padding，
//     顶栏落到状态栏下方、底栏抬到导航栏上方。
//
// 重复执行不会重复插入；文件不存在时（例如只构建桌面端）安静退出。

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

const javaRoot = path.join("src-tauri", "gen", "android", "app", "src", "main", "java");

// 顺序固定，保证重复执行时不会来回挪动。
const PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.REQUEST_INSTALL_PACKAGES",
];

const CLEARTEXT_ATTR = "android:usesCleartextTraffic";

const INSETS_MARK = "MOGENG_INSETS";

/** 在 java/ 下找 MainActivity.kt；生成工程的包名由 identifier 决定，不能写死。 */
function findMainActivity(root) {
  if (!fs.existsSync(root)) return "";
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === "MainActivity.kt") return full;
    }
  }
  return "";
}

/** 从 MainActivity.kt 的路径推出 Kotlin 包名。 */
function packageOf(activityPath) {
  const relative = path.relative(javaRoot, path.dirname(activityPath));
  return relative.split(path.sep).filter(Boolean).join(".");
}

/**
 * MainActivity 的完整内容。
 *
 * 用 ViewCompat 而不是裸 WindowInsets：`systemWindowInsetTop` 这类取值在
 * API 30 已废弃，新写法在 24 到最新版本都能拿到同一份系统栏尺寸。
 */
function mainActivitySource(pkg) {
  return `package ${pkg}

import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySystemBarInsets()
  }

  /**
   * ${INSETS_MARK}: 让界面落在系统栏之内。
   *
   * Android 15 起应用被强制画到状态栏与导航栏下面（opt-out 对 targetSdk 36
   * 已失效）。WebView 里 env(safe-area-inset-*) 恒为 0，所以只能在这里
   * 按系统栏尺寸给根视图补 padding —— 顶栏右上角那几颗按钮才不会顶着
   * 状态栏、点不到。
   */
  private fun applySystemBarInsets() {
    val root = findViewById<ViewGroup>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(root)
  }
}
`;
}

if (!fs.existsSync(manifestPath) && !findMainActivity(javaRoot)) {
  console.log("[android-patch] 没有找到生成的 Android 工程，跳过");
  process.exit(0);
}

const source = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
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

// 3) 界面让位给系统栏：重写 MainActivity.kt（带标记，重复执行不再动）。
const activityPath = findMainActivity(javaRoot);
if (activityPath) {
  const current = fs.readFileSync(activityPath, "utf8");
  if (current.includes(INSETS_MARK)) {
    notes.push("MainActivity 已带系统栏让位代码");
  } else {
    fs.writeFileSync(activityPath, mainActivitySource(packageOf(activityPath)), "utf8");
    added.push("MainActivity 系统栏让位（MOGENG_INSETS）");
  }
} else {
  notes.push("没找到 MainActivity.kt，跳过系统栏让位；顶栏按钮可能被状态栏挡住");
}

if (fs.existsSync(manifestPath)) {
  if (patched !== source) {
    fs.writeFileSync(manifestPath, patched, "utf8");
    for (const item of added) console.log(`[android-patch] 已补 ${item}`);
  } else {
    console.log("[android-patch] 清单已齐，无需修改");
  }
} else {
  for (const item of added) console.log(`[android-patch] 已补 ${item}`);
}
for (const note of notes) console.log(`[android-patch] 注意：${note}`);
