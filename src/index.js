import neo4j from 'neo4j-driver';

import { LLMService } from './llm.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
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
            debug: false,
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
                driver: this.driver,
                debug: this.debug,
                apiKey: this.config.openaiApiKey,
                model: this.config.openaiModel
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

        const documentId = uuidv4();

        const metadata = {
            documentId,
            fileName,
            created: new Date().toISOString(),
            status: 'processing'
        };


        await this.runQuery(
            'CREATE (d:Document {documentId: $documentId, fileName: $fileName, created: $created, status: $status})',
            metadata
        );

        // Split text into chunks
        const chunks = await this.splitText(text);

        // Process chunks in parallel
        const chunkPromises = chunks.map(async (chunk, i) => {
            // Generate embedding for the chunk
            const embedding = await this.llm.generateEmbedding(chunk.pageContent);


            // Create chunk node and link to document with embedding
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
                documentId: metadata.documentId,
                content: chunk.pageContent,
                index: i,
                text: `Chunk ${i}`,
                created: new Date().toISOString(),
                embedding: embedding
            });

            // Extract entities after chunk is created
            try {
                const entityResult = await this.extractEntities(chunk.pageContent, i, metadata.documentId, analysisDescription);
            } catch (error) {
                // Update document status to error
                await this.runQuery(
                    'MATCH (d:Document {documentId: $documentId}) SET d.status = $status, d.error = $error',
                    { documentId: metadata.documentId, status: 'error', error: error.message }
                );
                throw error;
            }
        });

        // Wait for all chunks to be processed
        await Promise.all(chunkPromises);

        // Update document status to processed


        await this.runQuery(
            'MATCH (d:Document {documentId: $documentId}) SET d.status = $status, d.processedAt = datetime()',
            { documentId: metadata.documentId, status: 'processed' }
        );


        return { documentId: metadata.documentId, status: 'processed' };


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
        try {
            const { documentIds, searchOptions = {} } = options;
            const {
                vectorSearch = true,
                textSearch = true,
                graphSearch = true
            } = searchOptions;

            if (!documentIds || documentIds.length === 0) {
                return "Please select at least one document to search through.";
            }



            // Initialize search results
            let vectorResults = [], textResults = [], graphResults = [];
            const searchPromises = [];

            // Generate embedding for vector search if enabled
            let questionEmbedding;
            if (vectorSearch) {
                questionEmbedding = await this.llm.generateEmbedding(question);
            }

            // Configure parallel searches based on enabled options
            if (vectorSearch && questionEmbedding) {
                searchPromises.push(
                    this.llm.searchSimilarVectors(questionEmbedding, documentIds)
                        .then(results => { vectorResults = results; })
                );
            }

            if (textSearch) {
                searchPromises.push(
                    this.llm.searchSimilarChunks(question, '', documentIds)
                        .then(results => { textResults = results; })
                );
            }

            if (graphSearch) {
                searchPromises.push(
                    this.llm.searchGraphRelationships(question, documentIds)
                        .then(results => { graphResults = results; })
                );
            }

            // Wait for all enabled searches to complete
            await Promise.all(searchPromises);

            // Combine and deduplicate results
            const allResults = new Map();

            // Helper function to add results to the map
            const addResults = (results, source) => {
                results.forEach(result => {
                    const key = result.content;
                    if (!allResults.has(key)) {
                        allResults.set(key, {
                            content: result.content,
                            documentId: result.documentId,
                            score: result.score || result.relevance || 0,
                            source: source,
                            entities: result.entities || [],
                            relationships: result.relationships || []
                        });
                    } else {
                        // Update score if new score is higher
                        const existing = allResults.get(key);
                        const newScore = result.score || result.relevance || 0;
                        if (newScore > existing.score) {
                            existing.score = newScore;
                        }
                    }
                });
            };

            // Add results from each search method
            if (vectorSearch) addResults(vectorResults, 'vector');
            if (graphSearch) addResults(graphResults, 'graph');
            if (textSearch) addResults(textResults, 'text');


            // Debug logging for allResults
            console.log('\n=== All Results Map ===');
            allResults.forEach((value, key) => {
                console.log('============> Source:', value.source);
                console.log('Content:', key);
                console.log('Document ID:', value.documentId);
                console.log('Score:', value.score);
                console.log('Entities:', JSON.stringify(value.entities, null, 2));
                console.log('Relationships:', JSON.stringify(value.relationships, null, 2));
            });

            // Convert map to array and sort by score
            const sortedResults = Array.from(allResults.values())
                .sort((a, b) => b.score - a.score).slice(0, 5);

            if (sortedResults.length === 0) {
                return "I couldn't find any relevant information in the selected documents to answer your question.";
            }


            console.log('sortedResults:', JSON.stringify(sortedResults, null, 2));
            // Format context with search results
            const formattedContext = this.formatContextForLLM(sortedResults.map(result => ({
                content: result.content,
                score: result.score,
                entities: result.entities || [],
                relationships: result.relationships || []
            })));


            console.log('formattedContext:', formattedContext);

            // Generate the final answer
            return await this.llm.generateAnswer(question, formattedContext);

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
            // Use the score property directly and provide a default if undefined
            const score = context.score || 0;
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