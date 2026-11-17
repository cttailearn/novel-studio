/*
 * 旧版设置面板已退役。
 *
 * 设置现在是「书案」的一部分：视图在 public/app/settings-view.js，
 * 样式在 public/overlays.css（dialog#settings 那一节），
 * 更新面板仍由 public/update.js 填进 #settings-about-panel。
 *
 * 这个文件不再被 index.html 加载，保留空壳只是为了让缓存里的旧书签
 * 与旧 Service Worker 拿到的地址不至于 404。
 */
export {};
