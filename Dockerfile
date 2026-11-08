FROM node:24-alpine

RUN apk add --no-cache qpdf poppler-utils font-liberation

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js pdftools.js halves.js PDFold.svg ./
COPY public ./public

ENV NODE_ENV=production PORT=3000 DATA_DIR=/tmp/pdfold
USER node
EXPOSE 3000
CMD ["node", "server.js"]
