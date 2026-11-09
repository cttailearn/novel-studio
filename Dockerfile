# 墨耕 · 云端账号版服务端镜像
#
# 两段构建：
#   1) builder —— 装依赖、现场跑 `pnpm build:browser`，把浏览器端产物 public/browser 造出来；
#   2) runtime —— 只带生产依赖与源码，外加 builder 造好的 public/browser。
#
# 为什么要有 builder 段：public/browser 是构建产物，仓库里并不保存（.gitignore 里排除了），
# 干净检出直接 `COPY . .` 是拿不到它的 —— 所以必须在镜像里现场构建。
#
# 数据（cloud.db + users/）全部落在 /data 卷里，容器本身无状态，可随时重建。

# ─────────────────────────────── 1) builder：造浏览器端产物
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# 依赖清单单独一层：改代码不会让 pnpm install 重跑。
# corepack 在 Node 24 里还带在镜像内；万一被裁掉就用 npm 全局装同版本 pnpm 兜底。
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
    || npm i -g pnpm@10.33.0

# 浏览器构建只需要运行时依赖（pi-agent-core / pi-ai / partial-json），
# 它用 Node 自带的 stripTypeScriptTypes 转译，不碰 tsc，也就不需要 devDependencies。
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build:browser

# ─────────────────────────────── 2) runtime：真正跑起来的那一层
FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
    || npm i -g pnpm@10.33.0

# --prod：不装 devDependencies（typecheck/构建脚本只在开发机跑）
# --frozen-lockfile：锁文件必须和 package.json 一致，避免镜像里悄悄升级
# --ignore-scripts：不执行第三方 postinstall（本项目没有需要编译的原生依赖）
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# 源码与配置
COPY . .

# 浏览器端产物：只能来自 builder 段（.dockerignore 把 public/browser 排除在上下文外，
# 所以本机的旧产物不会混进来，构建是确定的）。
COPY --from=builder /app/public/browser ./public/browser

ENV NODE_ENV=production \
    DATA_DIR=/data \
    STORAGE=users \
    HOST=0.0.0.0 \
    PORT=8787

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "--experimental-strip-types", "src/server/main.ts"]
