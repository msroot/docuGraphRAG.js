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
            llmUrl: 'http://localhost:11434',
            llmModel: 'mistral',
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
                
                // Entity constraint
                await session.run('CREATE CONSTRAINT entity_text_type IF NOT EXISTS FOR (e:Entity) REQUIRE (e.text, e.type) IS UNIQUE');

            } finally {
                await session.close();
            }

            // Initialize processor
            const processorConfig = {
                ...this.config
            };
            
            this.log('Creating Processor with config:', processorConfig);
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

            // Store in Neo4j
            this.log('Step 2: Storing document and chunks in Neo4j');
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

                    // Process each chunk
                    for (const chunk of chunks) {
                        // Create chunk node and connect to document
                        await tx.run(`
                            MATCH (d:Document {id: $documentId})
                            CREATE (c:DocumentChunk {
                                id: $chunkId,
                                documentId: $documentId,
                                content: $content,
                                index: $index
                            })
                            CREATE (d)-[:HAS_CHUNK]->(c)
                            RETURN c
                        `, {
                            documentId: metadata.id,
                            chunkId: chunk.id,
                            content: chunk.text,
                            index: chunk.chunkIndex
                        });

                        // Generate and execute Cypher query for the chunk's content
                        try {
                            this.log(`Generating Cypher query for chunk ${chunk.id}`);
                            const cypherQuery = await this.llm.generateCypherQuery(chunk.text);
                            
                            if (cypherQuery) {
                                this.log(`Executing generated Cypher query for chunk ${chunk.id}`);
                                // Add WITH clause to connect with the chunk
                                const queryWithChunk = `
                                    MATCH (c:DocumentChunk {id: $chunkId})
                                    WITH c
                                    ${cypherQuery}
                                `;
                                await tx.run(queryWithChunk, { chunkId: chunk.id });
                            }
                        } catch (error) {
                            console.error(`Error processing relationships for chunk ${chunk.id}:`, error);
                            // Continue with next chunk even if this one fails
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

    async chat(question, options = {}) {
        try {
            this.log(`Processing chat question: ${question}`);
            
            // Step 1: Generate Neo4j query based on the question
            this.log('Generating database query from question');
            const dbQuery = await this.llm.generateDatabaseQuery(question);
            
            // Step 2: Execute the generated query to get relevant data
            this.log('Executing generated database query');
            const session = this.driver.session();
            try {
                const result = await session.run(dbQuery);
                
                // Log query results
                console.log('\n[Neo4j Results]', '-'.repeat(47));
                console.log('Records found:', result.records.length);
                
                // Extract and format the context from the query results
                let contextParts = [];
                
                result.records.forEach((record, index) => {
                    console.log(`\nRecord ${index + 1}:`);
                    
                    // Get all available keys from the record
                    const keys = record.keys;
                    
                    // Add content if present
                    const content = record.get('content') || record.get('c.content');
                    if (content) {
                        contextParts.push(content);
                        console.log('Content:', content.substring(0, 150) + '...');
                    }
                    
                    // Add entity information if present
                    const entities = record.get('entities');
                    if (entities && Array.isArray(entities) && entities.length > 0) {
                        const entityContext = entities
                            .map(e => `${e.type}: ${e.text}${e.details ? ` (${JSON.stringify(e.details)})` : ''}`)
                            .join('\n');
                        if (entityContext) {
                            contextParts.push(`Related entities:\n${entityContext}`);
                            console.log('Entities:', entities.map(e => `${e.type}: ${e.text}`));
                        }
                    }

                    // Add any other relevant information from the record
                    keys.forEach(key => {
                        if (key !== 'content' && key !== 'entities') {
                            const value = record.get(key);
                            if (value !== null && value !== undefined) {
                                if (Array.isArray(value)) {
                                    contextParts.push(`${key}:\n${value.join('\n')}`);
                                    console.log(`${key}:`, value.length, 'items');
                                } else if (typeof value === 'object') {
                                    contextParts.push(`${key}: ${JSON.stringify(value, null, 2)}`);
                                    console.log(`${key}:`, JSON.stringify(value));
                                } else {
                                    contextParts.push(`${key}: ${value}`);
                                    console.log(`${key}:`, value);
                                }
                            }
                        }
                    });
                });
                console.log('-'.repeat(60), '\n');

                const context = contextParts.join('\n\n');
                
                // Step 3: Get answer from LLM using the context
                this.log('Getting answer from LLM with context');
                if (options.onData) {
                    // If streaming callback is provided, use streaming mode
                    await this.llm.generateStreamingAnswer(question, context, {
                        onData: (data) => {
                            options.onData({ answer: data, done: false });
                        },
                        onEnd: () => {
                            options.onData({ done: true });
                        },
                        onError: (error) => {
                            console.error('[DocuGraphRAG] Streaming error:', error);
                            options.onData({ error: error.message, done: true });
                        }
                    });
                    return null; // Return null as we're streaming the response
                } else {
                    // If no streaming callback, get complete response
                    const answer = await this.llm.generateAnswer(question, context);
                    return {
                        answer,
                        context
                    };
                }
            } finally {
                await session.close();
            }
        } catch (error) {
            console.error('[DocuGraphRAG] Error in chat:', error);
            throw error;
        }
    }
}