import neo4j from 'neo4j-driver';
import { Processor as DocumentProcessor } from './processor.js';
import { LLMService } from './llm.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GraphTraversalService } from './graphTraversal.js';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the root directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Core relationship types
const CORE_RELATIONSHIPS = {
    HAS_CHUNK: 'HAS_CHUNK'
};

// Core node labels
const NODE_LABELS = {
    DOCUMENT: 'Document',
    DOCUMENT_CHUNK: 'DocumentChunk',
    ENTITY: 'Entity'
};

export class DocuGraphRAG {
    constructor(config = {}) {
        this.config = {
            neo4jUrl: 'bolt://localhost:7687',
            neo4jUser: 'neo4j',
            neo4jPassword: 'password',
            openaiApiKey: process.env.OPENAI_API_KEY,
            openaiModel: 'gpt-4',
            chunkSize: 1000,
            chunkOverlap: 200,
            searchLimit: 3,
            debug: true,
            ...config,
        };

        this.debug = this.config.debug;
        this.initialized = false;
        this.driver = null;
        this.processor = null;
        this.llm = null;
        this.graphTraversal = null;
    }

    log(step, action, message, data = {}) {
        if (this.debug) {
            const timestamp = new Date().toISOString();
            const dataStr = Object.keys(data).length > 0 ? ` | ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(', ')}` : '';
            console.log(`[${timestamp}] [DocuGraphRAG] STEP ${step} - ${action}: ${message}${dataStr}`);
        }
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            this.log('1', 'initialize', 'Starting DocuGraphRAG initialization');

            // Initialize Neo4j driver
            this.log('1.1', 'initialize', 'Initializing Neo4j driver');
            this.driver = neo4j.driver(
                this.config.neo4jUrl,
                neo4j.auth.basic(this.config.neo4jUser, this.config.neo4jPassword)
            );

            // Initialize document processor
            this.log('1.2', 'initialize', 'Initializing document processor');
            this.processor = new DocumentProcessor({
                debug: this.debug
            });

            // Initialize LLM service
            this.log('1.3', 'initialize', 'Initializing LLM service');
            this.llm = new LLMService({
                driver: this.driver,
                debug: this.debug,
                apiKey: this.config.openaiApiKey,
                model: this.config.openaiModel
            });

            // Initialize GraphTraversal service
            this.log('1.4', 'initialize', 'Initializing GraphTraversal service');
            this.graphTraversal = new GraphTraversalService({
                driver: this.driver,
                debug: this.debug,
                searchLimit: this.config.searchLimit
            });

            // Create basic indexes
            this.log('1.5', 'initialize', 'Creating Neo4j indexes');
            const session = this.driver.session();
            try {
                // Create indexes for Document nodes
                await session.run(`
                    CREATE INDEX document_id IF NOT EXISTS
                    FOR (d:Document)
                    ON (d.documentId)
                `);

                // Create indexes for DocumentChunk nodes
                await session.run(`
                    CREATE INDEX chunk_id IF NOT EXISTS
                    FOR (c:DocumentChunk)
                    ON (c.documentId, c.chunkId)
                `);

                // Create indexes for Entity nodes
                await session.run(`
                    CREATE INDEX entity_text_type IF NOT EXISTS
                    FOR (e:Entity)
                    ON (e.text, e.type)
                `);

                // Create full-text search index for content
                await session.run(`
                    CREATE FULLTEXT INDEX chunk_content IF NOT EXISTS
                    FOR (c:DocumentChunk)
                    ON EACH [c.content]
                `);

                this.log('1.6', 'initialize', 'Neo4j indexes created successfully');
            } finally {
                await session.close();
            }

            this.initialized = true;
            this.log('1.7', 'initialize', 'DocuGraphRAG initialization completed');
        } catch (error) {
            this.log('ERROR', 'initialize', 'Failed to initialize DocuGraphRAG', { error: error.message });
            throw error;
        }
    }

    async splitText(text, chunkSize = 1000) {
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: chunkSize,
            chunkOverlap: this.config.chunkOverlap,
            separators: ["\n\n", "\n", ". ", " ", ""]
        });

        const docs = await splitter.createDocuments([text]);
        return docs.map(doc => ({
            pageContent: doc.pageContent,
            metadata: { start: 0, end: doc.pageContent.length }
        }));
    }

    generateUUID() {
        return uuidv4();
    }

    async processDocument(text, analysisDescription) {
        try {
            this.log('2', 'processDocument', 'Starting document processing');

            if (!this.initialized) {
                this.log('2.1', 'processDocument', 'Initializing DocuGraphRAG');
                await this.initialize();
            }

            // Validate and convert text input
            if (!text) {
                throw new Error('Text content is required');
            }

            this.log('2.2', 'processDocument', 'Validating text input');
            // Convert Buffer to string if needed
            if (Buffer.isBuffer(text)) {
                text = text.toString('utf-8');
            }

            // Ensure text is a string
            if (typeof text !== 'string') {
                throw new Error('Text content must be a string or Buffer');
            }

            const documentId = this.generateUUID();
            this.log('2.3', 'processDocument', 'Generated document ID', { documentId });

            const metadata = {
                documentId,
                created: new Date().toISOString(),
                status: 'processing'
            };

            const session = this.driver.session();
            try {
                // Create document node with processing status
                this.log('2.4', 'processDocument', 'Creating document node');
                await session.run(
                    'CREATE (d:Document {documentId: $documentId, created: $created, status: $status})',
                    metadata
                );

                // Split text into chunks
                this.log('2.5', 'processDocument', 'Splitting text into chunks');
                const chunks = await this.splitText(text);
                this.log('2.6', 'processDocument', 'Text split completed', { chunkCount: chunks.length });

                // Process each chunk
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    this.log('2.7', 'processDocument', `Processing chunk ${i + 1}/${chunks.length}`);

                    // Create chunk node and link to document
                    this.log('2.8', 'processDocument', `Creating chunk node ${i + 1}`);
                    await session.run(`
                        MATCH (d:Document {documentId: $documentId})
                        CREATE (c:DocumentChunk {documentId: $documentId, content: $content, index: $index, created: $created})
                        CREATE (d)-[:HAS_CHUNK]->(c)
                        `, {
                        documentId: metadata.documentId,
                        content: chunk.pageContent,
                        index: i,
                        created: new Date().toISOString()
                    });

                    // Extract entities after chunk is created
                    try {
                        this.log('2.9', 'processDocument', `Extracting entities for chunk ${i + 1}`);
                        const entityResult = await this.extractEntities(chunk.pageContent, i, metadata.documentId, analysisDescription);
                        this.log('2.10', 'processDocument', 'Entity extraction completed', {
                            chunkIndex: i,
                            documentId: metadata.documentId,
                            entityCount: entityResult.entitiesCount,
                            relationshipCount: entityResult.relationshipsCount
                        });
                    } catch (error) {
                        this.log('ERROR', 'processDocument', `Error in chunk ${i + 1} processing`, {
                            error: error.message,
                            chunkIndex: i,
                            documentId: metadata.documentId
                        });
                        // Update document status to error
                        await session.run(
                            'MATCH (d:Document {documentId: $documentId}) SET d.status = $status, d.error = $error',
                            { documentId: metadata.documentId, status: 'error', error: error.message }
                        );
                        throw error;
                    }
                }

                // Update document status to processed
                await session.run(
                    'MATCH (d:Document {documentId: $documentId}) SET d.status = $status, d.processedAt = datetime()',
                    { documentId: metadata.documentId, status: 'processed' }
                );

                this.log('2.11', 'processDocument', 'Document processing completed', { documentId });
                return { documentId: metadata.documentId, status: 'processed' };
            } finally {
                await session.close();
            }
        } catch (error) {
            this.log('ERROR', 'processDocument', 'Error in document processing', {
                error: error.message
            });
            throw error;
        }
    }

    async extractEntities(text, chunkId, documentId, analysisDescription) {
        let entityResult = {
            success: false,
            entitiesCount: 0,
            relationshipsCount: 0
        };

        try {
            this.log('5', 'extractEntities', 'Starting chunk processing', {
                chunkId,
                documentId,
                textLength: text.length
            });

            // Step 1: Generate embedding first
            this.log('5.1', 'extractEntities', 'Generating embedding for chunk');
            let embedding;
            try {
                embedding = await this.generateEmbedding(text);
                this.log('5.2', 'extractEntities', 'Embedding generated successfully', {
                    dimensions: embedding.length
                });
            } catch (error) {
                this.log('WARN', 'extractEntities', 'Failed to generate embedding', {
                    error: error.message
                });
                embedding = null;
            }

            // Step 2: Try entity extraction
            if (typeof chunkId === 'number' && chunkId >= 0 && documentId) {
                try {
                    this.log('5.3', 'extractEntities', 'Attempting entity extraction');
                    const cypherResponse = await this.llm.processTextToGraph(text, documentId, chunkId, analysisDescription, embedding);

                    if (cypherResponse?.query && typeof cypherResponse.query === 'string' && !cypherResponse.query.includes('...')) {
                        const session = this.driver.session();
                        try {
                            this.log('5.4', 'extractEntities', 'Executing entity extraction query');
                            const result = await session.run(cypherResponse.query, cypherResponse.params);
                            const record = result.records[0];
                            entityResult = {
                                success: true,
                                entitiesCount: record?.get('entityCount') || 0,
                                relationshipsCount: record?.get('relationshipCount') || 0
                            };
                            this.log('5.5', 'extractEntities', 'Entity extraction successful', entityResult);
                        } finally {
                            await session.close();
                        }
                    }
                } catch (error) {
                    this.log('WARN', 'extractEntities', 'Entity extraction failed', {
                        error: error.message
                    });
                }
            }

            // Step 3: Always create/update the chunk with text and embedding
            this.log('5.6', 'extractEntities', 'Creating/updating chunk with text and embedding');
            const session = this.driver.session();
            try {
                const query = `
                    MATCH (d:Document {documentId: $documentId})
                    MERGE (c:DocumentChunk {documentId: $documentId, chunkId: $chunkId})
                    SET c += {
                        content: $text,
                        embedding: $embedding,
                        created: datetime(),
                        hasEntities: $hasEntities,
                        lastUpdated: datetime()
                    }
                    MERGE (d)-[:HAS_CHUNK]->(c)
                    RETURN c
                `;

                await session.run(query, {
                    documentId,
                    chunkId,
                    text,
                    embedding,
                    hasEntities: entityResult.success
                });

                this.log('5.7', 'extractEntities', 'Chunk processing completed', {
                    documentId,
                    chunkId,
                    hasEmbedding: !!embedding,
                    hasEntities: entityResult.success
                });

                return {
                    ...entityResult,
                    hasEmbedding: !!embedding,
                    extractionResults: {
                        total: entityResult.entitiesCount,
                        relationships: entityResult.relationshipsCount
                    }
                };
            } finally {
                await session.close();
            }
        } catch (error) {
            this.log('ERROR', 'extractEntities', 'Critical error in chunk processing', {
                error: error.message,
                chunkId,
                documentId
            });
            throw error;
        }
    }

    async generateEmbedding(text) {
        try {
            this.log('6', 'generateEmbedding', 'Starting embedding generation', {
                textLength: text.length
            });

            const response = await this.llm.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text,
                dimensions: 1536
            });

            this.log('6.1', 'generateEmbedding', 'Embedding generated successfully', {
                dimensions: response.data[0].embedding.length
            });

            return response.data[0].embedding;
        } catch (error) {
            this.log('ERROR', 'generateEmbedding', 'Error generating embedding', {
                error: error.message
            });
            throw error;
        }
    }

    async chat(question, options = {}) {
        try {
            this.log('3', 'enhancedChat', 'Starting enhanced chat processing', { question });
            const { documentIds } = options;

            if (!documentIds || documentIds.length === 0) {
                this.log('ERROR', 'enhancedChat', 'No documents selected');
                return "Please select at least one document to search through.";
            }

            // Generate embedding for the question
            this.log('3.1', 'enhancedChat', 'Generating question embedding');
            const questionEmbedding = await this.generateEmbedding(question);

            // Get vector, text, and graph search results in parallel
            this.log('3.2', 'enhancedChat', 'Starting parallel search');
            const [vectorResults, textResults, graphResults] = await Promise.all([
                this.llm.searchSimilarVectors(questionEmbedding, documentIds),
                this.llm.searchSimilarChunks(question, '', documentIds),
                this.llm.searchGraphRelationships(question, documentIds)
            ]);

            this.log('3.3', 'enhancedChat', 'Search completed', {
                vectorResultsCount: vectorResults.length,
                textResultsCount: textResults.length,
                graphResultsCount: graphResults.length
            });

            // Debug logging
            if (this.debug) {
                console.log('Vector Results:', vectorResults);
                console.log('Text Results:', textResults);
                console.log('Graph Results:', graphResults);
            }

            // Combine and deduplicate results
            const allResults = new Map();

            // Add vector results
            vectorResults.forEach(result => {
                allResults.set(result.content, {
                    content: result.content,
                    score: result.score * 0.4,  // Vector results weighted at 40%
                    documentId: result.documentId,
                    entities: [],
                    relationships: []
                });
            });

            // Add text results, combining scores if content already exists
            textResults.forEach(result => {
                if (allResults.has(result.content)) {
                    const existing = allResults.get(result.content);
                    existing.score += result.relevance * 0.3;  // Text results weighted at 30%
                } else {
                    allResults.set(result.content, {
                        content: result.content,
                        score: result.relevance * 0.3,
                        documentId: result.documentId,
                        entities: [],
                        relationships: []
                    });
                }
            });

            // Add graph results, combining scores and metadata
            graphResults.forEach(result => {
                if (allResults.has(result.chunkContent)) {
                    const existing = allResults.get(result.chunkContent);
                    existing.score += result.graphScore * 0.3;  // Graph results weighted at 30%
                    existing.entities = result.entities || [];
                    existing.relationships = result.relationships || [];
                } else {
                    allResults.set(result.chunkContent, {
                        content: result.chunkContent,
                        score: result.graphScore * 0.3,
                        documentId: result.documentId,
                        entities: result.entities || [],
                        relationships: result.relationships || []
                    });
                }
            });

            // Convert to array and sort by combined score
            const sortedResults = Array.from(allResults.values())
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);  // Keep top 5 results

            this.log('3.4', 'enhancedChat', 'Results combined and sorted', {
                combinedResultsCount: sortedResults.length
            });

            if (sortedResults.length === 0) {
                this.log('3.5', 'enhancedChat', 'No relevant results found');
                return "I couldn't find any relevant information in the selected documents to answer your question.";
            }

            // Format context with both vector, text, and graph results
            this.log('3.6', 'enhancedChat', 'Formatting context for LLM');
            const formattedContext = this.formatContextForLLM(sortedResults);

            // Generate the final answer
            this.log('3.7', 'enhancedChat', 'Generating answer');
            const answer = await this.llm.generateAnswer(question, formattedContext);
            this.log('3.8', 'enhancedChat', 'Answer generated successfully');

            return answer;
        } catch (error) {
            this.log('ERROR', 'enhancedChat', 'Error in chat processing', {
                error: error.message
            });
            return "I encountered an error while trying to process your question. Please try again.";
        }
    }

    async findEntitiesInQuestion(question, documentFilter = '', documentIds = []) {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (e:Entity)<-[:HAS_ENTITY]-(c:DocumentChunk)
                WHERE (toLower(e.text) IN [word IN split(toLower($question), ' ') | word]
                   OR toLower($question) CONTAINS toLower(e.text))
                   ${documentFilter}
                RETURN DISTINCT e
                ORDER BY size(e.text) DESC
                LIMIT 5
            `, {
                question,
                documentIds
            });

            return result.records.map(record => record.get('e').properties);
        } finally {
            await session.close();
        }
    }

    formatContextForLLM(mergedContext) {
        let formattedContext = '';

        // Group contexts by type
        const contextTypes = {
            vector: 'Vector Similarity',
            path: 'Document Path',
            temporal: 'Temporal Context',
            reasoning: 'Knowledge Reasoning',
            entity: 'Entity Context',
            relationship: 'Entity Relationships'
        };

        for (const context of mergedContext) {
            formattedContext += `\n### ${contextTypes[context.type] || 'Context'} (Score: ${context.normalizedScore.toFixed(3)})\n`;

            // Add content
            if (context.content) {
                formattedContext += `Content: ${context.content}\n`;
            }

            // Add entities if present
            if (context.entities?.length > 0) {
                formattedContext += '\nEntities:\n';
                context.entities.forEach(entity => {
                    formattedContext += `- ${entity.type}: ${entity.text}\n`;
                });
            }

            // Add relationships if present
            if (context.relationships?.length > 0) {
                formattedContext += '\nRelationships:\n';
                context.relationships.forEach(rel => {
                    formattedContext += `- ${rel.fromEntity} ${rel.type} ${rel.toEntity}\n`;
                });
            }

            formattedContext += '\n---\n';
        }

        return formattedContext;
    }

    async cleanup() {
        if (this.driver) {
            const session = this.driver.session();
            try {
                await session.run('MATCH (n) DETACH DELETE n');
            } finally {
                await session.close();
                await this.driver.close();
            }
            this.driver = null;
            this.initialized = false;
            this.processor = null;
            this.llm = null;
            this.graphTraversal = null;
        }
        return true;
    }
}