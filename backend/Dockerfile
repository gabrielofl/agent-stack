FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV PORT=3000
EXPOSE 3000

CMD ["npm","run","start"]
