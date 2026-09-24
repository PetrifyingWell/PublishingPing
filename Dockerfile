FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "src/index.js"]
