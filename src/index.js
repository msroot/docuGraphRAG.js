import axios from 'axios';
import neo4j from 'neo4j-driver';
import { Processor as DocumentProcessor } from './processor.js';
import { LLMService } from './llm.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GraphTraversalService } from './graphTraversal';

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
            debug: false,
            ...config,
        };

        this.debug = this.config.debug;
        this.initialized = false;
        this.driver = null;
        this.processor = null;
        this.llm = null;
        this.graphTraversal = null;
    }

    log(step, methodName, message, context = {}) {
        if (this.debug) {
            const className = this.constructor.name;
            console.log(
                `[Step: ${step}][${className}][${methodName}]: ${message}`,
                Object.entries(context).length > 0 ? context : ''
            );
        }
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            // Initialize Neo4j driver
            this.driver = neo4j.driver(
                this.config.neo4jUrl,
                neo4j.auth.basic(this.config.neo4jUser, this.config.neo4jPassword)
            );

            // Initialize document processor
            this.processor = new DocumentProcessor({
                debug: this.debug
            });

            // Initialize LLM service
            this.llm = new LLMService({
                driver: this.driver,
                debug: this.debug,
                apiKey: this.config.openaiApiKey,
                model: this.config.openaiModel
            });

            // Initialize GraphTraversal service
            this.graphTraversal = new GraphTraversalService(this.config);

            // Create basic indexes
            const session = this.driver.session();
            try {
                await session.run(`
                    CREATE INDEX IF NOT EXISTS FOR (n:Entity)
                    ON (n.text, n.type, n.documentId)
                `);
            } finally {
                await session.close();
            }

            this.initialized = true;
        } catch (error) {
            console.error('Failed to initialize DocuGraphRAG:', error);
            throw error;
        }
    }

    async splitText(text, chunkSize = 1000) {
        // Split text into chunks of roughly equal size
        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = start + chunkSize;

            // If we're not at the end, try to find a good break point
            if (end < text.length) {
                // Look for the next period, question mark, or exclamation point
                const nextBreak = text.indexOf('.', end);
                const nextQuestion = text.indexOf('?', end);
                const nextExclamation = text.indexOf('!', end);

                // Find the closest break point
                const breaks = [nextBreak, nextQuestion, nextExclamation]
                    .filter(pos => pos !== -1)
                    .sort((a, b) => a - b);

                if (breaks.length > 0) {
                    end = breaks[0] + 1;
                }
            } else {
                end = text.length;
            }

            chunks.push({
                pageContent: text.slice(start, end).trim(),
                metadata: { start, end }
            });

            start = end;
        }

        return chunks;
    }

    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async processDocument(text, analysisDescription) {
        try {
            if (!this.initialized) {
                await this.initialize();
            }

            // Validate and convert text input
            if (!text) {
                throw new Error('Text content is required');
            }

            // Convert Buffer to string if needed
            if (Buffer.isBuffer(text)) {
                text = text.toString('utf-8');
            }

            // Ensure text is a string
            if (typeof text !== 'string') {
                throw new Error('Text content must be a string or Buffer');
            }

            const documentId = this.generateUUID();
            const metadata = {
                documentId,
                created: new Date().toISOString()
            };

            const session = this.driver.session();
            try {
                // Create document node
                await session.run(
                    'CREATE (d:Document {documentId: $documentId, created: $created})',
                    metadata
                );

                // Split text into chunks
                const chunks = await this.splitText(text);

                // Process each chunk
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];

                    // Create chunk node and link to document
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
                        const entityResult = await this.extractEntities(chunk.pageContent, i, metadata.documentId, analysisDescription);
                        this.log('7', 'processDocument', 'Entity extraction completed', {
                            ...entityResult,
                            chunkIndex: i,
                            documentId: metadata.documentId
                        });
                    } catch (error) {
                        this.log('ERROR', 'processDocument', 'Error in chunk processing', {
                            error: error.message,
                            chunkIndex: i,
                            documentId: metadata.documentId
                        });
                        throw error;
                    }
                }
            } finally {
                await session.close();
            }

            return { documentId: metadata.documentId };
        } catch (error) {
            this.log('ERROR', 'processDocument', 'Error in document processing', {
                error: error.message
            });
            throw error;
        }
    }

    async extractEntities(text, chunkId, documentId, analysisDescription) {
        try {
            if (typeof chunkId !== 'number' || chunkId < 0) {
                throw new Error(`Invalid chunkId: ${chunkId}`);
            }
            if (!documentId) {
                throw new Error('documentId is required for entity extraction');
            }

            // Get the Cypher query from LLM
            const cypherResponse = await this.llm.processTextToGraph(text, documentId, chunkId, analysisDescription);

            // Full debug logging
            console.log('Full Cypher Response:', JSON.stringify(cypherResponse, null, 2));

            if (!cypherResponse || typeof cypherResponse !== 'object') {
                throw new Error('Invalid response format from LLM');
            }

            if (!cypherResponse.query || typeof cypherResponse.query !== 'string') {
                throw new Error('Invalid or missing Cypher query in LLM response');
            }

            if (cypherResponse.query.includes('...')) {
                throw new Error('Incomplete Cypher query received from LLM');
            }

            // Validate params structure
            if (!cypherResponse.params || !cypherResponse.params.entities || !Array.isArray(cypherResponse.params.entities)) {
                throw new Error('Invalid or missing entities in parameters');
            }

            if (!cypherResponse.params.relationships || !Array.isArray(cypherResponse.params.relationships)) {
                throw new Error('Invalid or missing relationships in parameters');
            }

            // Sanitize parameters to ensure they are primitive types
            const sanitizeValue = (value) => {
                if (value === null || value === undefined) return null;
                if (typeof value !== 'object') return value;
                if (Array.isArray(value)) return value.map(sanitizeValue);
                if (value instanceof Map) return Object.fromEntries(value);

                const sanitized = {};
                for (const [key, val] of Object.entries(value)) {
                    sanitized[key] = sanitizeValue(val);
                }
                return sanitized;
            };

            // Deep sanitize all parameters
            const sanitizedParams = {
                entities: cypherResponse.params.entities.map(entity => ({
                    ...entity,
                    properties: sanitizeValue(entity.properties)
                })),
                relationships: cypherResponse.params.relationships.map(rel => ({
                    ...rel,
                    properties: sanitizeValue(rel.properties)
                }))
            };

            // Execute the query with sanitized parameters
            const session = this.driver.session();
            try {
                // Merge documentId and chunkId with sanitized parameters
                const finalParams = {
                    ...sanitizedParams,
                    documentId: documentId,
                    chunkIndex: chunkId
                };

                // Log the final query and parameters
                console.log('Executing Cypher Query:', cypherResponse.query);
                console.log('With Parameters:', JSON.stringify(finalParams, null, 2));

                const result = await session.run(cypherResponse.query, finalParams);

                // The query will return entityCount and relationshipCount
                const entityCount = result.records[0]?.get('entityCount') || 0;
                const relationshipCount = result.records[0]?.get('relationshipCount') || 0;

                return {
                    success: true,
                    entitiesCount: entityCount,
                    relationshipsCount: relationshipCount,
                    extractionResults: {
                        total: entityCount,
                        relationships: relationshipCount
                    }
                };
            } finally {
                await session.close();
            }
        } catch (error) {
            this.log('ERROR', 'extractEntities', 'Error in entity extraction', {
                error: error.message,
                chunkId,
                documentId
            });
            throw error;
        }
    }

    async enhancedChat(question, options = {}) {
        const questionEmbedding = await this.llm.getEmbedding(question);

        // Gather context using multiple strategies
        const [
            vectorResults,
            pathResults,
            temporalResults,
            reasoningResults
        ] = await Promise.all([
            this.llm.searchSimilarChunks(question, options.documentId),
            this.graphTraversal.findPathBasedContext(question),
            this.graphTraversal.findTemporalContext(new Date()),
            this.graphTraversal.performKnowledgeReasoning(question, questionEmbedding)
        ]);

        // Extract potential entities from the question
        const entityMatches = await this.findEntitiesInQuestion(question);

        // If we found entities, expand their context
        let entityContexts = [];
        if (entityMatches.length > 0) {
            const entityContextPromises = entityMatches.map(entity =>
                this.graphTraversal.expandEntityContext(entity.text)
            );
            entityContexts = await Promise.all(entityContextPromises);
        }

        // If we have multiple entities, find paths between them
        let entityPaths = [];
        if (entityMatches.length > 1) {
            for (let i = 0; i < entityMatches.length - 1; i++) {
                const paths = await this.graphTraversal.findWeightedPaths(
                    entityMatches[i].text,
                    entityMatches[i + 1].text
                );
                entityPaths.push(...paths);
            }
        }

        // Merge all contexts with appropriate weights
        const mergedContext = await this.graphTraversal.mergeContexts([
            { results: vectorResults, weight: 0.3 },
            { results: pathResults, weight: 0.2 },
            { results: temporalResults, weight: 0.1 },
            { results: reasoningResults, weight: 0.2 },
            { results: entityContexts.flat(), weight: 0.1 },
            { results: entityPaths, weight: 0.1 }
        ]);

        // Format context for the LLM
        const formattedContext = this.formatContextForLLM(mergedContext);

        // Generate the final answer
        return this.llm.generateAnswer(question, formattedContext);
    }

    async findEntitiesInQuestion(question) {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (e:Entity)
                WHERE toLower(e.text) IN [word IN split(toLower($question), ' ') | word]
                   OR toLower($question) CONTAINS toLower(e.text)
                RETURN DISTINCT e
                ORDER BY length(e.text) DESC
                LIMIT 5
            `, { question });

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

    // Original chat method for backward compatibility
    async chat(question, options = {}) {
        return this.enhancedChat(question, options);
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