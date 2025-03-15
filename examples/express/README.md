# docuGraphRAG.js Express Example

This is an example implementation showing how to use docuGraphRAG.js with Express and Server-Sent Events (SSE).

## Features
- PDF file upload and processing
- Real-time chat with streaming responses
- Beautiful UI with drag & drop
- PDF preview
- Source citations

## Prerequisites
- Node.js 18+
- Docker (for Neo4j)
- OpenAI API key

## Quick Start

1. Start the required services:
```bash
# Start Neo4j
docker-compose up -d
```

2. Install dependencies:
```bash
cd examples/express
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Add your OpenAI API key to .env
```

4. Run the server:
```bash
npm start
```

5. Open your browser:
```
http://localhost:3000
```

## API Endpoints

- `POST /upload` - Upload and process a PDF file
- `POST /chat` - Chat with the processed document (SSE)
- `POST /cleanup` - Clean up resources

## UI Features

- Drag and drop PDF upload
- Real-time chat interface
- PDF preview panel
- Source citation display
- Error handling and loading states

## Security Features

- File type validation (PDF only)
- File size limits (10MB)
- CORS enabled
- Sanitized error responses 