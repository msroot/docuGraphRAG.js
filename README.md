# docuGraphRAG.js

💡 Chat with your PDF documents

A JavaScript library for building RAG-powered document question-answering systems. 
docuGraphRAG.js provides a streamlined solution for implementing Retrieval-Augmented Generation with support for multiple vector stores (Neo4j and Qdrant) and local LLM integration.



![docuGraphRAG.js Demo](https://raw.githubusercontent.com/msroot/docuGraphRAG.js/main/docs/demo.gif)


[![npm version](https://img.shields.io/npm/v/docugraphrag.svg)](https://www.npmjs.com/package/docugraphrag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)


## Core Features

- **LLM Integration**: Flexible local LLM support with streaming responses
- **Vector Storage**: Multiple vector store support
  - Neo4j (with dot product similarity)
  - Qdrant (with cosine similarity)
- **Text Processing**: RecursiveCharacterTextSplitter from LangChain
- **Streaming Responses**: Server-Sent Events (SSE) for real-time chat responses
- **PDF Processing**: Automatic PDF text extraction and chunking
- **Session Management**: Built-in session handling for document contexts
- **Framework Agnostic**: Can be used with any Node.js framework


## Quick Start

### Prerequisites
- Modern JavaScript runtime (Node.js 18+ for server-side)
- Running vector store instance (Neo4j or Qdrant)
- Local LLM server (e.g., Ollama with Llama2)
  > ⚠️ Note: Currently tested and optimized for Llama2. Other models may work but are not officially supported.

### Setup

#### Using Neo4j
```bash
# Start Neo4j
docker run \
  --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password123 \
  neo4j:latest

# Start Llama2
ollama run llama2

# Install docuGraphRAG
npm install docugraphrag
```

#### Using Qdrant
```bash
# Start Qdrant
docker run -p 6333:6333 qdrant/qdrant

# Start Llama2
ollama run llama2

# Install docuGraphRAG
npm install docugraphrag
```

### Basic Usage

#### With Neo4j
```javascript
import { DocuGraphRAG } from 'docugraphrag';

// Initialize DocuGraphRAG with Neo4j
const docuGraphRAG = new DocuGraphRAG({
    vectorStore: 'neo4j',
    vectorStoreConfig: {
        url: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'password123'
    },
    llmUrl: 'http://localhost:11434'
});

// Initialize
await docuGraphRAG.initialize();

// Process a PDF
const pdfBuffer = await fs.readFile('document.pdf');
await docuGraphRAG.processPDFBuffer(pdfBuffer, 'document.pdf');

// Chat with streaming
await docuGraphRAG.chat("What is this document about?", {
    onData: (data) => console.log(data.response),
    onEnd: () => console.log("Done"),
    onError: (error) => console.error(error)
});

// Clean up when done
await docuGraphRAG.cleanup();
```

#### With Qdrant
```javascript
import { DocuGraphRAG } from 'docugraphrag';

// Initialize DocuGraphRAG with Qdrant
const docuGraphRAG = new DocuGraphRAG({
    vectorStore: 'qdrant',
    vectorStoreConfig: {
        url: 'http://localhost:6333',
        vectorSize: 3072,
        vectorDistance: 'Cosine'
    },
    llmUrl: 'http://localhost:11434'
});

// Rest of the usage is the same as Neo4j example
```

## Configuration Options

```javascript
{
    // Vector Store Selection
    vectorStore: 'neo4j' | 'qdrant',
    
    // Neo4j Configuration
    vectorStoreConfig: {
        url: string,        // Neo4j URL (e.g., 'bolt://localhost:7687')
        user: string,       // Neo4j username
        password: string    // Neo4j password
    }
    
    // OR Qdrant Configuration
    vectorStoreConfig: {
        url: string,           // Qdrant server URL
        vectorSize: number,    // Default: 3072
        vectorDistance: string // Default: 'Cosine'
    },

    // LLM Configuration
    llmUrl: string,        // LLM server URL
    llmModel: string,      // Default: 'llama3.2'

    // Text Processing
    chunkSize: number,     // Default: 1000
    chunkOverlap: number,  // Default: 200
    searchLimit: number    // Default: 3
}
```


## Examples
- [Express Example](./examples/express) - Complete implementation with UI
- [NestJS Example](./examples/nest) - Same features, NestJS implementation


## Contributing

Areas for contribution:
- Additional vector store integrations
- Alternative LLM providers
- Enhanced chunking strategies
- Performance optimizations
- Testing infrastructure

## License

MIT License - see [LICENSE](LICENSE)

## Resources

- [Neo4j Documentation](https://neo4j.com/docs/)
- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [LangChain JS](https://js.langchain.com/)
- [Ollama](https://ollama.ai/)
- [LLama2](https://ai.meta.com/llama/)

---
Built with ❤️ by [Yannis Kolovos](http://msroot.me/)

## Features

- PDF document processing
- Vector storage support:
  - Neo4j (with dot product similarity)
  - More coming soon...
- LLM integration with Ollama
- Streaming responses
- Source citations

## Installation

```bash
npm install docugraphrag
```

## Examples

The repository includes several examples demonstrating different use cases and configurations:

### Neo4j Example
Located in `examples/neo4j/`, this example shows how to:
- Set up DocuGraphRAG with Neo4j as the vector store
- Process and query PDF documents
- Get responses with source citations

See the [Neo4j Example README](examples/neo4j/README.md) for details.

### NestJS Example
Located in `examples/nest/`, this example demonstrates:
- Integration with NestJS framework
- REST API endpoints for document upload and chat
- Streaming responses

See the [NestJS Example README](examples/nest/README.md) for details.

## Basic Usage

```javascript
import { DocuGraphRAG } from 'docugraphrag';

// Initialize with Neo4j vector store
const docuGraphRAG = new DocuGraphRAG({
    vectorStore: 'neo4j',
    vectorStoreConfig: {
        url: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'password123'
    }
});

// Initialize
await docuGraphRAG.initialize();

// Process a PDF
const pdfBuffer = await fs.readFile('document.pdf');
await docuGraphRAG.processPDFBuffer(pdfBuffer, 'document.pdf');

// Ask questions
const response = await docuGraphRAG.chat('What is this document about?');
console.log(response.response);
console.log('Sources:', response.sources);

// Cleanup when done
await docuGraphRAG.cleanup();
```

## Configuration

The DocuGraphRAG constructor accepts a configuration object with the following options:

```javascript
{
    // Vector store configuration
    vectorStore: 'neo4j', // Currently supported: 'neo4j'
    vectorStoreConfig: {
        url: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'password123'
    },
    
    // LLM configuration
    llmUrl: 'http://localhost:11434',
    llmModel: 'llama2',
    
    // Text processing configuration
    chunkSize: 1000,
    chunkOverlap: 200,
    searchLimit: 3
}
```

## License

MIT