# ==========================================
# DOCMIND - RAG Application
# ==========================================

FROM node:20-alpine

WORKDIR /app

# PDF text extraction için poppler-utils
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    poppler-utils \
    curl

# Dependencies
COPY package*.json ./
RUN npm ci --only=production

# Application
COPY . .

# Uploads directory
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "index.js"]