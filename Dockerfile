# 4KFrame Enhanced — backend image (also serves the built display + admin SPAs).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY display/package.json display/
COPY admin/package.json admin/
# Node 22 has no tfjs-node prebuilt addon, so node-gyp needs the standard Debian toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN mkdir -p server/models/face \
    && cp node_modules/@vladmandic/face-api/model/tiny_face_detector_model-weights_manifest.json server/models/face/ \
    && cp node_modules/@vladmandic/face-api/model/tiny_face_detector_model.bin server/models/face/ \
    && npm run build

FROM node:22-bookworm-slim AS runtime
# ffmpeg powers video posters/transcoding; openssl self-signs the HTTPS cert on first boot.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV FRAME_DATA_DIR=/data
COPY --from=build /app .
# Keep the opt-in Tiny Face Detector weights available to the runtime.
COPY --from=build /app/server/models/face ./server/models/face
EXPOSE 9095 9096
# Temporary storage-recovery diagnostic. Restored after maintenance.
CMD ["sh", "-lc", "node -e \"const fs=require('fs');const d=JSON.parse(fs.readFileSync('/data/frame.json','utf8'));console.log('RECOVERY_CATALOG_ITEMS='+d.items.length)\" && exec node server/dist/index.js"]
