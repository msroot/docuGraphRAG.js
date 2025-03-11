import axios from 'axios';
import { createVectorStore } from './vectorStore.js';
import { DocumentProcessor } from './documentProcessor.js';

export class DocuGraphRAG {
    constructor(config = {}) {
        this.config = {
            vectorStore: 'neo4j',
            vectorStoreConfig: {
                url: 'bolt://localhost:7687',
                user: 'neo4j',
                password: 'password123'
            },
            vectorSize: 3072,
            llmUrl: 'http://localhost:11434',
            llmModel: 'llama3.2',
            chunkSize: 1000,
            chunkOverlap: 200,
            searchLimit: 3,
            debug: true,
            ...config
        };

        this.debug = this.config.debug;

        // Initialize components
        this.vectorStore = createVectorStore(this.config.vectorStore, {
            ...this.config.vectorStoreConfig,
            debug: this.debug
        });
        
        this.documentProcessor = new DocumentProcessor(this.config);
    }

    log(...args) {
        if (this.debug) {
            console.log('[DocuGraphRAG]', ...args);
        }
    }

    async initialize() {
        this.log('Initializing DocuGraphRAG');
        await this.vectorStore.initialize();
        this.log('Initialization complete');
    }

    async getEmbeddings(text) {
        try {
            this.log('Getting embeddings for text');
            const response = await axios.post(`${this.config.llmUrl}/api/embeddings`, {
                model: this.config.llmModel,
                prompt: text
            });
            this.log('Embeddings retrieved successfully');
            return response.data.embedding;
        } catch (error) {
            console.error('[DocuGraphRAG] Error getting embeddings:', error);
            throw error;
        }
    }

    async processDocument(buffer, fileName) {
        try {
            this.log(`Processing document: ${fileName}`);

            // Process document using DocumentProcessor
            this.log('Step 1: Processing document with DocumentProcessor');
            const { metadata, chunks } = await this.documentProcessor.processDocument(buffer, fileName);
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
            await this.vectorStore.addToStore(
                chunksWithEmbeddings, 
                metadata, 
                chunks.map(chunk => chunk.extractedInfo)
            );
            this.log('Storage complete');

            return { documentId: metadata.id };
        } catch (error) {
            console.error('[DocuGraphRAG] Error processing document:', error);
            throw error;
        }
    }

    async chat(question, options = {}) {
        try {
            this.log(`Processing question:`, question);

            // Get embedding for the question
            this.log('Step 1: Getting question embedding');
            const questionEmbedding = await this.getEmbeddings(question);

            // Search for relevant chunks
            this.log('Step 2: Searching for relevant chunks');
            const relevantChunks = await this.vectorStore.search(
                null, // No specific document ID - search all documents
                questionEmbedding,
                this.config.searchLimit
            );
            this.log(`Found ${relevantChunks.length} relevant chunks`);

            // Prepare context for LLM
            this.log('Step 3: Preparing context for LLM');
            const context = relevantChunks.map(chunk => chunk.text).join('\n\n');

            // Generate LLM prompt
            const prompt = `
Context information is below.
---------------------
${context}
---------------------

Given the context information, answer the following question. If the answer cannot be found in the context, say "I don't have enough information to answer that question."

Question: ${question}
Answer:`;

            this.log('Step 4: Sending request to LLM');
            // Get LLM response
            if (options.onData) {
                // Handle streaming response for Express compatibility
                this.log('Streaming response to client');
                const response = await axios.post(`${this.config.llmUrl}/api/generate`, {
                    model: this.config.llmModel,
                    prompt: prompt,
                    stream: true
                }, {
                    responseType: 'stream'
                });

                response.data.on('data', chunk => {
                    try {
                        const data = JSON.parse(chunk.toString());
                        if (data.response) {
                            options.onData({
                                content: data.response,
                                sources: relevantChunks,
                                debug: this.debug ? {
                                    context,
                                    prompt,
                                    chunks: relevantChunks
                                } : undefined
                            });
                        }
                    } catch (error) {
                        console.error('Error parsing stream chunk:', error);
                    }
                });

                response.data.on('end', () => {
                    if (options.onEnd) {
                        this.log('Stream complete');
                        options.onEnd();
                    }
                });

                response.data.on('error', error => {
                    console.error('Stream error:', error);
                    if (options.onError) {
                        options.onError(error);
                    }
                });
            } else {
                // Return complete response
                this.log('Returning complete response');
                return {
                    response: response.data.response,
                    sources: relevantChunks,
                    debug: this.debug ? {
                        context,
                        prompt,
                        chunks: relevantChunks
                    } : undefined
                };
            }
        } catch (error) {
            console.error('[DocuGraphRAG] Error asking question:', error);
            if (options.onError) {
                options.onError(error);
            } else {
                throw error;
            }
        }
    }

    async cleanup(documentId) {
        try {
            this.log(`Cleaning up document: ${documentId}`);
            await this.vectorStore.cleanup(documentId);
            this.log('Cleanup complete');
            return true;
        } catch (error) {
            console.error('[DocuGraphRAG] Error during cleanup:', error);
            throw error;
        }
    }

    async close() {
        this.log('Closing connections');
        await this.vectorStore.close();
        this.log('All connections closed');
    }
} 