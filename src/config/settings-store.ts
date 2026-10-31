/**
 * 应用设置的纯模型层。
 *
 * 设置的数据形状与归一化都在同目录的 settings.ts 里（那一层本来就是纯的）。
 * 这一层只负责说清楚"设置存储"这个角色长什么样：
 * 磁盘实现是 settings-disk.ts 里的 SettingsStore，
 * 浏览器端是 IndexedDB 版 —— 两者实现同一个接口
 * （SettingsStorePort，见 store-port.ts），所以上层不必知道自己连的是哪一个。
 *
 * 设置与凭据分文件保存：settings.json 可以安全分享，credentials.json 含密钥，
 * 不应进仓。两者都位于被 git 忽略的 data/ 目录下。
 */
import type { SettingsStorePort } from "../store/store-port.ts";

export type { ProviderConfig, Settings } from "./settings.ts";

/**
 * 应用设置存储这个角色。
 *
 * 只留名字：磁盘实现见 settings-disk.ts，浏览器端见 IndexedDB 版。
 */
export type SettingsStore = SettingsStorePort;
