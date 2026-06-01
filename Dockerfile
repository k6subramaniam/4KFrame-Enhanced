# 4KFrame Enhanced — backend image (also serves the built display + admin SPAs).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY display/package.json display/
COPY admin/package.json admin/
RUN npm install
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
# ffmpeg powers video posters/transcoding; openssl self-signs the HTTPS cert on first boot.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV FRAME_DATA_DIR=/data
COPY --from=build /app .
EXPOSE 9095 9096
VOLUME ["/data"]
CMD ["node", "server/dist/index.js"]
