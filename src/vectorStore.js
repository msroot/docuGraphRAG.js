import neo4j from 'neo4j-driver';
import { v4 as uuidv4 } from 'uuid';

export class Neo4jVectorStore {
    constructor(config = {}) {
        this.config = {
            url: 'bolt://localhost:7687',
            user: 'neo4j',
            password: 'password123',
            ...config
        };
        this.driver = null;
    }

    async initialize() {
        this.driver = neo4j.driver(
            this.config.url,
            neo4j.auth.basic(this.config.user, this.config.password)
        );

        // Create constraints and indexes
        const session = this.driver.session();
        try {
            // Document and DocumentChunk constraints
            await session.run('CREATE CONSTRAINT document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE');
            await session.run('CREATE CONSTRAINT document_chunk_id IF NOT EXISTS FOR (c:DocumentChunk) REQUIRE c.id IS UNIQUE');
            
            // Entity, Keyword, and Concept constraints
            await session.run('CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE');
            await session.run('CREATE CONSTRAINT keyword_text IF NOT EXISTS FOR (k:Keyword) REQUIRE k.text IS UNIQUE');
            await session.run('CREATE CONSTRAINT concept_text IF NOT EXISTS FOR (c:Concept) REQUIRE c.text IS UNIQUE');
        } finally {
            await session.close();
        }
    }

    async addToStore(chunks, metadata, extractedInfo) {
        const session = this.driver.session();
        try {
            // Create Document node first
            const documentId = metadata.documentId || uuidv4();
            await session.run(`
                CREATE (d:Document)
                SET d = $properties
            `, {
                properties: {
                    id: documentId,
                    fileName: metadata.fileName,
                    uploadDate: new Date().toISOString(),
                    ...metadata
                }
            });

            // Track unique entities, keywords, and concepts for document-level relationships
            const documentEntities = new Set();
            const documentKeywords = new Set();
            const documentConcepts = new Set();

            // Process each chunk
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkInfo = extractedInfo[i];

                // Create DocumentChunk node and connect to Document
                await session.run(`
                    CREATE (c:DocumentChunk)
                    SET c = $properties
                    WITH c
                    MATCH (d:Document {id: $documentId})
                    CREATE (d)-[:HAS_CHUNK]->(c)
                `, {
                    properties: {
                        id: chunk.id,
                        text: chunk.text,
                        documentId: documentId,
                        chunkIndex: i,
                        embedding: chunk.embedding
                    },
                    documentId
                });

                // Create and connect entities
                for (const entity of chunkInfo.entities) {
                    documentEntities.add(JSON.stringify(entity)); // Track for document-level relationship
                    await session.run(`
                        MERGE (e:Entity {id: $entityId})
                        SET e.text = $text, e.type = $type
                        WITH e
                        MATCH (c:DocumentChunk {id: $chunkId})
                        MERGE (c)-[:HAS_ENTITY]->(e)
                    `, {
                        entityId: uuidv4(),
                        text: entity.text,
                        type: entity.type,
                        chunkId: chunk.id
                    });
                }

                // Create and connect keywords
                for (const keyword of chunkInfo.keywords) {
                    documentKeywords.add(keyword); // Track for document-level relationship
                    await session.run(`
                        MERGE (k:Keyword {text: $text})
                        WITH k
                        MATCH (c:DocumentChunk {id: $chunkId})
                        MERGE (c)-[:HAS_KEYWORD]->(k)
                    `, {
                        text: keyword,
                        chunkId: chunk.id
                    });
                }

                // Create and connect concepts
                for (const concept of chunkInfo.concepts) {
                    documentConcepts.add(concept); // Track for document-level relationship
                    await session.run(`
                        MERGE (co:Concept {text: $text})
                        WITH co
                        MATCH (c:DocumentChunk {id: $chunkId})
                        MERGE (c)-[:EXPRESSES_CONCEPT]->(co)
                    `, {
                        text: concept,
                        chunkId: chunk.id
                    });
                }
            }

            // Create document-level relationships
            // Entities
            for (const entityStr of documentEntities) {
                const entity = JSON.parse(entityStr);
                await session.run(`
                    MATCH (d:Document {id: $documentId})
                    MATCH (e:Entity {text: $text, type: $type})
                    MERGE (d)-[:CONTAINS_ENTITY]->(e)
                `, {
                    documentId,
                    text: entity.text,
                    type: entity.type
                });
            }

            // Keywords
            for (const keyword of documentKeywords) {
                await session.run(`
                    MATCH (d:Document {id: $documentId})
                    MATCH (k:Keyword {text: $text})
                    MERGE (d)-[:CONTAINS_KEYWORD]->(k)
                `, {
                    documentId,
                    text: keyword
                });
            }

            // Concepts
            for (const concept of documentConcepts) {
                await session.run(`
                    MATCH (d:Document {id: $documentId})
                    MATCH (co:Concept {text: $text})
                    MERGE (d)-[:CONTAINS_CONCEPT]->(co)
                `, {
                    documentId,
                    text: concept
                });
            }

            return chunks.length;
        } finally {
            await session.close();
        }
    }

    async search(documentId, queryEmbedding, limit) {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (c:DocumentChunk)
                WITH c, reduce(acc = 0.0, i in range(0, size(c.embedding)-1) | 
                    acc + c.embedding[i] * $queryEmbedding[i]) AS score
                OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e)
                OPTIONAL MATCH (c)-[:HAS_KEYWORD]->(k)
                OPTIONAL MATCH (c)-[:EXPRESSES_CONCEPT]->(co)
                WITH c, score, 
                     collect(DISTINCT {type: e.type, text: e.text}) as entities,
                     collect(DISTINCT k.text) as keywords,
                     collect(DISTINCT co.text) as concepts
                ORDER BY score DESC
                LIMIT toInteger($limit)
                RETURN c.text AS text, c.fileName AS fileName, c.chunkIndex AS chunkIndex,
                       entities, keywords, concepts, score
            `, {
                queryEmbedding,
                limit
            });

            return result.records.map(record => ({
                text: record.get('text'),
                fileName: record.get('fileName'),
                chunkIndex: record.get('chunkIndex'),
                entities: record.get('entities'),
                keywords: record.get('keywords'),
                concepts: record.get('concepts')
            }));
        } finally {
            await session.close();
        }
    }

    async cleanup(documentId) {
        const session = this.driver.session();
        try {
            // Delete the Document node and all its relationships
            await session.run(`
                MATCH (d:Document {id: $documentId})
                OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
                DETACH DELETE d, c
            `, { documentId });
            return true;
        } finally {
            await session.close();
        }
    }

    async close() {
        if (this.driver) {
            await this.driver.close();
        }
    }
}

// Factory function to create vector store instances
export function createVectorStore(type = 'neo4j', config = {}) {
    switch (type.toLowerCase()) {
        case 'neo4j':
            return new Neo4jVectorStore(config);
        default:
            throw new Error(`Unsupported vector store type: ${type}`);
    }
} 