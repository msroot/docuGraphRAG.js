import neo4j from 'neo4j-driver';

import { LLMService } from './llm.js';
import { v4 as uuidv4 } from 'uuid';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

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
            openaiApiKey: '',
            chunkSize: 1000,
            chunkOverlap: 200,
            searchLimit: 3,
            debug: false,
            vectorSearchWeight: 0.4,
            textSearchWeight: 0.3,
            graphSearchWeight: 0.3,
            ...config,
        };

        this.debug = this.config.debug;
        this.initialized = false;
        this.driver = null;

        this.llm = null;
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



            // Initialize LLM service
            this.llm = new LLMService({
                openaiApiKey: this.config.openaiApiKey,
                driver: this.driver,
                debug: this.config.debug
            });

            // Create basic indexes
            const session = this.driver.session();
            try {
                // Create each index in a separate transaction
                await session.executeWrite(tx =>
                    tx.run(`CREATE INDEX document_id IF NOT EXISTS FOR (d:Document) ON (d.documentId)`)
                );

                await session.executeWrite(tx =>
                    tx.run(`CREATE INDEX chunk_id IF NOT EXISTS FOR (c:DocumentChunk) ON (c.documentId, c.chunkId)`)
                );

                await session.executeWrite(tx =>
                    tx.run(`CREATE INDEX entity_text_type IF NOT EXISTS FOR (e:Entity) ON (e.text, e.type)`)
                );

                await session.executeWrite(tx =>
                    tx.run(`CREATE FULLTEXT INDEX chunk_content IF NOT EXISTS FOR (c:DocumentChunk) ON EACH [c.content]`)
                );



            } finally {
                await session.close();
            }

            this.initialized = true;
        } catch (error) {
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

    async runQuery(query, params) {
        const session = this.driver.session();
        try {
            const result = await session.run(query, params);
            return result;
        } catch (error) {
            throw error;
        } finally {
            await session.close();
        }
    }

    async processDocument(text, analysisDescription, fileName) {
        console.log('📄 Processing document...');
        if (!text || typeof text !== 'string') {
            throw new Error('Text input is required and must be a string');
        }

        const documentId = uuidv4();

        try {
            await this.runQuery(
                'CREATE (d:Document {documentId: $documentId, fileName: $fileName, created: $created, status: $status})',
                { documentId, fileName, created: new Date().toISOString(), status: 'processing' }
            );

            const chunks = await this.splitText(text);
            console.log('📑 Processing chunks...');

            const chunkPromises = chunks.map(async (chunk, index) => {
                const chunkId = uuidv4();
                const embedding = await this.llm.generateEmbedding(chunk.pageContent);

                await this.runQuery(`
                    MATCH (d:Document {documentId: $documentId})
                    CREATE (c:DocumentChunk {
                        documentId: $documentId, 
                        content: $content, 
                        index: $index, 
                        text: $text, 
                        created: $created,
                        embedding: $embedding
                    })
                    CREATE (d)-[:HAS_CHUNK]->(c)
                `, {
                    documentId,
                    content: chunk.pageContent,
                    index,
                    text: `Chunk ${index}`,
                    created: new Date().toISOString(),
                    embedding
                });

                try {
                    const entityResult = await this.extractEntities(chunk.pageContent, index, documentId, analysisDescription);
                } catch (error) {
                    await this.runQuery(
                        'MATCH (d:Document {documentId: $documentId}) SET d.status = $status, d.error = $error',
                        { documentId, status: 'error', error: error.message }
                    );
                    throw error;
                }
            });

            await Promise.all(chunkPromises);
            console.log('✅ Document processed successfully');
            return { documentId };
        } catch (error) {
            throw error;
        }
    }

    async extractEntities(text, chunkId, documentId, analysisDescription) {
        try {
            // Step 1: Generate embedding first
            const embedding = await this.llm.generateEmbedding(text);

            // Step 2: Try entity extraction
            const cypher = await this.llm.processTextToGraph(text, documentId, chunkId, analysisDescription, embedding);

            if (cypher?.query && typeof cypher.query === 'string' && !cypher.query.includes('...')) {
                try {
                    await this.runQuery(cypher.query, cypher.params);
                } catch (error) {
                    console.error('Error executing Cypher query:', error);
                    throw error;
                }
            }
        } catch (error) {
            console.error('Error in extractEntities:', error);
            throw error;
        }
    }

    async chat(question, options = {}) {
        console.log('💬 Processing chat request...');
        const { documentIds, vectorSearch = true, textSearch = true, graphSearch = true } = options;

        if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
            throw new Error('At least one document ID is required');
        }

        try {
            const questionEmbedding = await this.llm.generateEmbedding(question);
            let relevantChunks = [];

            if (vectorSearch) {
                const vectorResults = await this.llm.searchSimilarVectors(questionEmbedding, documentIds);
                relevantChunks.push(...vectorResults.map(r => ({ ...r, weight: this.config.vectorSearchWeight })));
            }

            if (textSearch) {
                const textResults = await this.llm.searchSimilarChunks(question, '', documentIds);
                relevantChunks.push(...textResults.map(r => ({ ...r, weight: this.config.textSearchWeight })));
            }

            if (graphSearch) {
                const graphResults = await this.llm.searchGraphRelationships(question, documentIds);
                relevantChunks.push(...graphResults.map(r => ({ ...r, weight: this.config.graphSearchWeight })));
            }

            // Apply weights to scores
            relevantChunks = relevantChunks.map(chunk => ({
                ...chunk,
                weightedScore: chunk.score * chunk.weight
            }));

            // Remove duplicates and sort by weighted score
            relevantChunks = Array.from(new Set(relevantChunks.map(c => c.content)))
                .map(content => relevantChunks.find(c => c.content === content))
                .sort((a, b) => b.weightedScore - a.weightedScore)
                .slice(0, 5);

            const response = await this.llm.generateAnswer(question, this.formatContextForLLM(relevantChunks));
            console.log('✅ Chat response generated');
            return response;
        } catch (error) {
            throw error;
        }
    }

    formatContextForLLM(mergedContext) {
        let formattedContext = '';

        // Group contexts by type
        const contextTypes = {
            vector: 'Vector Similarity',
            text: 'Text Search',
            graph: 'Graph Search'
        };

        for (const context of mergedContext) {
            // Use the weightedScore property instead of score
            const score = context.weightedScore || 0;
            formattedContext += `\n### Context (Score: ${score.toFixed(3)})\n`;

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
        }
        return true;
    }
}