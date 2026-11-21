FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production STORY_HOST=0.0.0.0 STORY_HTTP_PORT=4310 STORY_DB=/app/data/story.sqlite
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 4310
CMD ["npm", "start"]
