# 墨耕 · 云端账号版服务端镜像
#
# 服务端直接跑 TypeScript（node --experimental-strip-types），浏览器产物 public/browser
# 已经构建好并在版本库里，所以镜像里不需要 pnpm build，也不需要 devDependencies。
# 数据（cloud.db + users/）全部落在 /data 卷里，容器本身无状态，可随时重建。

FROM node:24-bookworm-slim

WORKDIR /app

# 依赖清单单独一层：改代码不会让 pnpm install 重跑。
# corepack 在 Node 24 里还带在镜像内；万一被裁掉就用 npm 全局装同版本 pnpm 兜底。
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
    || npm i -g pnpm@10.33.0

# --prod：不装 devDependencies（typecheck/构建脚本只在开发机跑）
# --frozen-lockfile：锁文件必须和 package.json 一致，避免镜像里悄悄升级
# --ignore-scripts：不执行第三方 postinstall（本项目没有需要编译的原生依赖）
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# 源码与已构建的 public/browser
COPY . .

ENV NODE_ENV=production \
    DATA_DIR=/data \
    STORAGE=users \
    HOST=0.0.0.0 \
    PORT=8787

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "--experimental-strip-types", "src/server/main.ts"]
