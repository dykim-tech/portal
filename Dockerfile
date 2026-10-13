# DYKIM PORTAL 컨테이너 이미지 (Kubernetes·Docker·Podman 공용)
FROM docker.io/library/node:24-bookworm-slim
# PDF(운영자 매뉴얼·업무기안)용 한글 글꼴(나눔고딕), 시간대 정보
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-nanum tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
# 운영관리 화면이 docs의 설계도·화면 디자인·운영자 매뉴얼을 읽는다.
COPY --chown=node:node docs ./docs
RUN mkdir -p /app/data /app/backups /app/shared && chown -R node:node /app/data /app/backups /app/shared
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data BACKUP_DIR=/app/backups TZ=Asia/Seoul PORTAL_SELF_CHECK=off
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
