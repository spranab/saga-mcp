# Build stage: compile TypeScript from source, so the image builds from a
# clean checkout (no prebuilt dist/ needed on the build context).
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ src/
RUN npm run build

# Runtime stage: production deps + compiled output only.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/
COPY glama.json ./

ENTRYPOINT ["node", "dist/index.js"]
