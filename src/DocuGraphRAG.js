import axios from 'axios';
import neo4j from 'neo4j-driver';
import { Processor as DocumentProcessor } from './processor.js';
import { LLMService } from './llm.js';

export class DocuGraphRAG {
    constructor(config = {}) {
        this.config = {
            neo4jUrl: 'bolt://localhost:7687',
            neo4jUser: 'neo4j',
            neo4jPassword: 'password123',
            vectorSize: 3072,
            llmUrl: 'http://localhost:11434',
            llmModel: 'llama2',
            chunkSize: 1000,
            chunkOverlap: 200,
            searchLimit: 3,
            debug: true,
            ...config
        };

        this.debug = this.config.debug;
        this.driver = null;
        this.llm = null;
    }

    log(...args) {
        if (this.debug) {
            console.log('[DocuGraphRAG]', ...args);
        }
    }

    async initialize() {
        this.log('Initializing DocuGraphRAG');
        
        try {
            // Initialize Neo4j driver
            this.driver = neo4j.driver(
                this.config.neo4jUrl,
                neo4j.auth.basic(this.config.neo4jUser, this.config.neo4jPassword)
            );

            // Initialize LLM service
            this.llm = new LLMService(this.config);

            // Test the Neo4j connection
            await this.driver.verifyConnectivity();
            this.log('Neo4j connection verified');

            // Create necessary constraints and indexes
            const session = this.driver.session();
            try {
                // Document and DocumentChunk constraints
                await session.run('CREATE CONSTRAINT document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE');
                await session.run('CREATE CONSTRAINT document_chunk_id IF NOT EXISTS FOR (c:DocumentChunk) REQUIRE c.id IS UNIQUE');
                
                // Entity, Keyword, and Concept constraints
                await session.run('CREATE CONSTRAINT entity_text_type IF NOT EXISTS FOR (e:Entity) REQUIRE (e.text, e.type) IS UNIQUE');
                await session.run('CREATE CONSTRAINT keyword_text IF NOT EXISTS FOR (k:Keyword) REQUIRE k.text IS UNIQUE');
                await session.run('CREATE CONSTRAINT concept_text IF NOT EXISTS FOR (c:Concept) REQUIRE c.text IS UNIQUE');

                // Create vector index for embeddings if Neo4j version supports it
                try {
                    await session.run(
                        'CREATE VECTOR INDEX document_chunk_embedding IF NOT EXISTS ' +
                        'FOR (c:DocumentChunk) ' +
                        'ON (c.embedding) ' +
                        'OPTIONS { ' +
                        '    indexConfig: { ' +
                        '        vector.dimensions: 3072, ' +
                        '        vector.similarity_function: "cosine" ' +
                        '    } ' +
                        '}'
                    );
                } catch (error) {
                    console.warn('Vector index creation failed. Vector similarity will be calculated manually:', error.message);
                }
            } finally {
                await session.close();
            }

            // Initialize processor with shared services
            const processorConfig = {
                driver: this.driver,
                llm: this.llm,
                ...this.config
            };
            
            this.log('Creating Processor with config:', {
                ...processorConfig,
                driver: 'Neo4j Driver Instance',
                llm: 'LLM Service Instance'
            });
            
            this.processor = new DocumentProcessor(processorConfig);

            this.log('Initialization complete');
        } catch (error) {
            console.error('Failed to initialize DocuGraphRAG:', error);
            if (this.driver) {
                await this.driver.close();
                this.driver = null;
            }
            throw error;
        }
    }

    async getEmbeddings(text) {
        return this.llm.getEmbeddings(text);
    }

    async createSemanticNode(tx, type, data, chunkId, documentId) {
        const nodeConfig = {
            Entity: {
                label: 'Entity',
                properties: { text: data.text, type: data.type },
                chunkRel: 'HAS_ENTITY',
                docRel: 'CONTAINS_ENTITY'
            },
            Keyword: {
                label: 'Keyword',
                properties: { text: data },
                chunkRel: 'HAS_KEYWORD',
                docRel: 'CONTAINS_KEYWORD'
            },
            Concept: {
                label: 'Concept',
                properties: { text: data },
                chunkRel: 'EXPRESSES_CONCEPT',
                docRel: 'CONTAINS_CONCEPT'
            }
        };

        const config = nodeConfig[type];
        if (!config) {
            throw new Error(`Unsupported semantic node type: ${type}`);
        }

        // Create/merge node and create relationships in a single query
        await tx.run(`
            MATCH (c:DocumentChunk {id: $chunkId})
            MERGE (n:${config.label} ${this.createPropertiesString(config.properties)})
            MERGE (c)-[:${config.chunkRel}]->(n)
            WITH c, n
            MATCH (d:Document {id: c.documentId})
            MERGE (d)-[:${config.docRel}]->(n)
        `, {
            chunkId,
            ...config.properties
        });
    }

    createPropertiesString(properties) {
        const props = Object.entries(properties)
            .map(([key, value]) => `${key}: $${key}`)
            .join(', ');
        return `{${props}}`;
    }

    async processDocument(buffer, fileName) {
        try {
            this.log(`Processing document: ${fileName}`);

            // Process document using Processor
            this.log('Step 1: Processing document with Processor');
            const { metadata, chunks } = await this.processor.processDocument(buffer, fileName);
            this.log('Document processing complete', { 
                documentId: metadata.id,
                totalChunks: chunks.length 
            });

            // Get embeddings for each chunk
            this.log('Step 2: Getting embeddings for chunks');
            const chunksWithEmbeddings = await Promise.all(
                chunks.map(async (chunk, index) => {
                    this.log(`Getting embeddings for chunk ${index + 1}/${chunks.length}`);
                    const withEmbedding = {
                        ...chunk,
                        embedding: await this.getEmbeddings(chunk.text)
                    };
                    this.log(`Embeddings complete for chunk ${index + 1}`);
                    return withEmbedding;
                })
            );

            // Store in Neo4j
            this.log('Step 3: Storing document and chunks in Neo4j');
            const session = this.driver.session();
            try {
                await session.executeWrite(async tx => {
                    // Create document node
                    await tx.run(`
                        CREATE (d:Document {
                            id: $id,
                            fileName: $fileName,
                            fileType: $fileType,
                            uploadDate: datetime($uploadDate),
                            totalChunks: $totalChunks
                        })
                    `, metadata);

                    // Store chunks and their relationships
                    for (const chunk of chunksWithEmbeddings) {
                        // Create chunk node and connect to document
                        await tx.run(`
                            MATCH (d:Document {id: $documentId})
                            CREATE (c:DocumentChunk {
                                id: $chunkId,
                                documentId: $documentId,
                                content: $content,
                                index: $index,
                                embedding: $embedding
                            })
                            CREATE (d)-[:HAS_CHUNK]->(c)
                            RETURN c
                        `, {
                            documentId: metadata.id,
                            chunkId: chunk.id,
                            content: chunk.text,
                            index: chunk.chunkIndex,
                            embedding: chunk.embedding
                        });

                        // Process semantic nodes (entities, keywords, concepts)
                        for (const entity of chunk.extractedInfo.entities) {
                            if (!entity.text || !entity.type) continue;
                            await this.createSemanticNode(tx, 'Entity', entity, chunk.id, metadata.id);
                        }

                        for (const keyword of chunk.extractedInfo.keywords) {
                            if (!keyword || typeof keyword !== 'string') continue;
                            await this.createSemanticNode(tx, 'Keyword', keyword, chunk.id, metadata.id);
                        }

                        for (const concept of chunk.extractedInfo.concepts) {
                            if (!concept || typeof concept !== 'string') continue;
                            await this.createSemanticNode(tx, 'Concept', concept, chunk.id, metadata.id);
                        }
                    }
                });
            } finally {
                await session.close();
            }
            this.log('Storage complete');

            return { documentId: metadata.id };
        } catch (error) {
            console.error('[DocuGraphRAG] Error processing document:', error);
            throw error;
        }
    }

    async vectorSearch(session, embedding, limit, useVectorIndex = true) {
        const query = useVectorIndex ? `
            MATCH (c:DocumentChunk)
            WITH c, vector.similarity(c.embedding, $embedding) AS score
            WHERE score > 0.7
            OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e)
            OPTIONAL MATCH (c)-[:HAS_KEYWORD]->(k)
            OPTIONAL MATCH (c)-[:EXPRESSES_CONCEPT]->(co)
            WITH c, score,
                 collect(DISTINCT {type: e.type, text: e.text}) as entities,
                 collect(DISTINCT k.text) as keywords,
                 collect(DISTINCT co.text) as concepts
            ORDER BY score DESC
            LIMIT $limit
            RETURN c.content AS text, c.documentId AS documentId,
                   entities, keywords, concepts, score
        ` : `
            MATCH (c:DocumentChunk)
            WITH c, reduce(acc = 0.0, i in range(0, size(c.embedding)-1) |
                acc + c.embedding[i] * $embedding[i]) AS score
            WHERE score > 0.7
            OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e)
            OPTIONAL MATCH (c)-[:HAS_KEYWORD]->(k)
            OPTIONAL MATCH (c)-[:EXPRESSES_CONCEPT]->(co)
            WITH c, score,
                 collect(DISTINCT {type: e.type, text: e.text}) as entities,
                 collect(DISTINCT k.text) as keywords,
                 collect(DISTINCT co.text) as concepts
            ORDER BY score DESC
            LIMIT $limit
            RETURN c.content AS text, c.documentId AS documentId,
                   entities, keywords, concepts, score
        `;

        const result = await session.run(query, {
            embedding,
            limit
        });

        return result.records.map(record => ({
            text: record.get('text'),
            documentId: record.get('documentId'),
            entities: record.get('entities'),
            keywords: record.get('keywords'),
            concepts: record.get('concepts'),
            score: record.get('score')
        }));
    }

    async chat(question, options = {}) {
        try {
            this.log(`Processing chat question: ${question}`);
            
            // Get embeddings for the question
            this.log('Getting embeddings for question');
            const questionEmbedding = await this.getEmbeddings(question);
            
            // Search for relevant chunks
            this.log('Searching for relevant chunks');
            const session = this.driver.session();
            try {
                let chunks;
                try {
                    // Try using vector index first
                    chunks = await this.vectorSearch(session, questionEmbedding, this.config.searchLimit, true);
                } catch (error) {
                    // Fallback to manual calculation if vector index fails
                    this.log('Vector index search failed, falling back to manual calculation');
                    chunks = await this.vectorSearch(session, questionEmbedding, this.config.searchLimit, false);
                }

                // Prepare context for LLM
                const context = chunks.map(chunk => chunk.text).join('\n\n');
                
                // Get answer from LLM
                this.log('Getting answer from LLM');
                const answer = await this.llm.chat([
                    {
                        role: 'system',
                        content: `You are a helpful assistant. Answer questions based on the following context:\n\n${context}`
                    },
                    {
                        role: 'user',
                        content: question
                    }
                ]);

                return {
                    answer,
                    chunks,
                    context
                };
            } finally {
                await session.close();
            }
        } catch (error) {
            console.error('[DocuGraphRAG] Error in chat:', error);
            throw error;
        }
    }
}