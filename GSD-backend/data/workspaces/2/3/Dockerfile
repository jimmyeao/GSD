# Stage 1: Build the React client
FROM node:18-alpine AS client-builder

WORKDIR /client

# Copy package files
COPY client/package*.json ./

# Install dependencies
RUN npm install

# Copy client source code
COPY client/ ./

# Build the client
RUN npm run build

# Stage 2: Set up the server
FROM node:18-alpine

WORKDIR /app

# Install sqlite3 dependencies
RUN apk add --no-cache python3 make g++ sqlite-dev

# Copy package files
COPY package*.json ./
COPY server.js ./

# Install server dependencies
RUN npm install

# Copy built client from stage 1
COPY --from=client-builder /client/build ./client/build

# Create a non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

CMD ["node", "server.js"]
