FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npx esbuild server/index.ts --bundle --platform=node --format=esm --target=node22 \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" --outfile=server.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
