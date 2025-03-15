<!-- SystemaAI SophiaAI Delphi-->


# 🚀 docuGraphRAG.js [WIP]

A powerful document analysis tool that combines vector embeddings, graph databases, and language models to create an intelligent document processing and querying system.

## Features 🌟

### 1. Hybrid Search System
Our unique three-layer search approach combines:
- **Semantic Search** (60% weight): Uses OpenAI embeddings to understand meaning and context
- **Full-Text Search** (40% weight): Handles exact matches and fuzzy text search
- **Graph Structure**: Leverages relationships between entities for context-aware results

### 2. Advanced Graph Traversal 🔍
- **Path-Based Context**: Finds relevant information through relationship paths
- **Semantic Subgraphs**: Explores connected information clusters
- **Knowledge Reasoning**: Performs multi-hop inference across entities
- **Temporal Analysis**: Discovers time-related connections
- **Entity Expansion**: Broadens context through related entities
- **Weighted Paths**: Identifies strongest connection routes

### 3. Intelligent Entity Extraction
- Automatically identifies entities (People, Organizations, Locations, etc.)
- Creates relationships between entities
- Maintains entity properties and metadata
- Graceful fallback to vector search if entity extraction fails

### 4. Vector Embeddings
- Uses OpenAI's text-embedding-3-small model
- Stores embeddings alongside content for semantic search
- Enables finding similar content even without exact keyword matches

### 5. Graph Database Integration
- Stores documents as connected chunks
- Maintains relationships between entities
- Enables complex graph queries
- Uses Neo4j for efficient graph operations

## Getting Started 🏁

### Prerequisites
```bash
# Install Node.js dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your API keys and configuration
```

### Configuration
```javascript
{
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4',  // or any other OpenAI model
    neo4jUrl: process.env.NEO4J_URL,
    neo4jUser: process.env.NEO4J_USER,
    neo4jPassword: process.env.NEO4J_PASSWORD,
    // Graph traversal settings
    maxHops: 3,
    temporalWindow: 7,
    minConfidence: 0.6,
    weightDecay: 0.8
}
```

### Basic Usage
```javascript
import { DocuGraphRAG } from 'docugraphrag';

// Initialize
const rag = new DocuGraphRAG(config);
await rag.initialize();

// Process a document
const result = await rag.processDocument(text, "Analysis focus description");

// Enhanced chat with advanced context gathering
const answer = await rag.chat("Who is Dr. Sarah Jones?", { documentId: "doc123" });
```

## How It Works 🔍

### 1. Document Processing
- Splits documents into manageable chunks
- Generates vector embeddings for each chunk
- Extracts entities and relationships
- Stores everything in Neo4j with proper indexing

### 2. Advanced Search Process
When you ask a question:
1. Converts question to vector embedding
2. Performs fuzzy full-text search
3. Identifies relevant entities in the question
4. Explores multiple context gathering strategies:
   - Vector similarity (30% weight)
   - Path-based context (20% weight)
   - Temporal relationships (10% weight)
   - Knowledge reasoning (20% weight)
   - Entity context (10% weight)
   - Entity relationships (10% weight)
5. Merges and ranks all contexts
6. Generates comprehensive answer using GPT-4

### 3. Graph Traversal Algorithms
- **Path Finding**: Discovers connections between concepts
- **Semantic Clustering**: Groups related information
- **Temporal Analysis**: Tracks time-based relationships
- **Entity Expansion**: Broadens contextual understanding
- **Weighted Relationships**: Prioritizes stronger connections

### 4. Data Structure
```cypher
(Document)-[:HAS_CHUNK]->(DocumentChunk)
(DocumentChunk)-[:HAS_ENTITY]->(Entity)
(Entity)-[:RELATES_TO {type: "..."}]->(Entity)
```

## Advanced Features 🔧

### Custom Indexes
- Full-text search index on document content
- Vector index for similarity search
- Regular indexes for common lookups
- Entity text and type indexing
- Temporal index for date-based queries

### Graph Algorithms
- Breadth-first search for relationship exploration
- Shortest path finding between entities
- Semantic subgraph analysis
- Multi-hop reasoning
- Temporal pattern recognition

### Fallback Mechanisms
- Continues processing even if entity extraction fails
- Maintains vector search capabilities
- Tracks chunks with/without entities using `hasEntities` flag
- Graceful degradation of search strategies

## API Reference 📚

### Core Methods
- `processDocument(text, analysisDescription)`
- `chat(question, options)`
- `enhancedChat(question, options)`
- `findPathBasedContext(question, maxHops)`
- `exploreSemanticSubgraph(startNodeId)`
- `performKnowledgeReasoning(question, embedding)`
- `findTemporalContext(date, windowDays)`
- `expandEntityContext(entityName, maxDepth)`
- `findWeightedPaths(startEntity, endEntity)`

### Search Parameters
- Vector similarity weight: 0.3
- Path-based weight: 0.2
- Temporal weight: 0.1
- Reasoning weight: 0.2
- Entity context weight: 0.1
- Relationship weight: 0.1
- Default top K results: 5
- Fuzzy matching enabled for text search

## Contributing 🤝

We welcome contributions! Please check our contributing guidelines for more information.

## License 📄

MIT License - feel free to use in your own projects!

## Support 💬

- Create an issue for bug reports
- Start a discussion for feature requests
- Check our documentation for guides

---

Built with ❤️ by [Yannis Kolovos](http://msroot.me/)