/**
 * 厂商密钥的纯模型层。
 *
 * 凭据的数据形状来自 pi-ai（Credential / CredentialInfo），
 * 存储接口由 src/store/store-port.ts 里的 CredentialStorePort 定下。
 * 这一层只负责说清楚"凭据存储"这个角色长什么样：
 * 磁盘实现是 credential-disk.ts 里的 FileCredentialStore，
 * 浏览器端是 IndexedDB 版 —— 两者实现同一个接口，
 * 所以上层（包括 createModels({ credentials })）不必知道自己连的是哪一个。
 *
 * 密钥只存在用户自己的机器上：磁盘版落在 data/credentials.json，
 * 浏览器版落在 IndexedDB。服务器不碰它。
 */
import type { CredentialStorePort } from "../store/store-port.ts";

export type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** 键的脱显写法，仅用于设置页回显。 */
export const MASKED_KEY = "•••••••";

/**
 * 凭据存储这个角色。
 *
 * 只留名字：磁盘实现见 credential-disk.ts，浏览器端见 IndexedDB 版。
 */
export type FileCredentialStore = CredentialStorePort;
