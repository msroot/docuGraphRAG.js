import OpenAI from 'openai';

export class LLMService {
    constructor(config = {}) {
        this.config = {
            debug: true,
            apiKey: process.env.OPENAI_API_KEY,
            model: 'gpt-4',
            temperature: 0.1,
            ...config
        };

        this.debug = this.config.debug;
        this.driver = config.driver;
        this.openai = new OpenAI({
            apiKey: this.config.apiKey,
            maxRetries: 3,
            dangerouslyAllowBrowser: true,
            debug: false
        });

        // Define the system prompt for entity and relationship extraction
        this.systemPrompt = `You are an expert at extracting entities and relationships from text.
Your task is to analyze the given text and extract relevant entities and their relationships based on the analysis focus.

Return ONLY a valid JSON object in this format:
{
    "entities": [
        {
            "text": "exact text from document",
            "type": "PERSON|ORGANIZATION|LOCATION|DATE|etc",
            "properties": {
                "key1": "value1",
                "key2": "value2"
                // Additional properties specific to the entity type
            }
        }
    ],
    "relationships": [
        {
            "from": "exact text of source entity",
            "fromType": "type of source entity",
            "to": "exact text of target entity",
            "toType": "type of target entity",
            "type": "WORKS_FOR|LOCATED_IN|MANAGES|etc"
        }
    ]
}

IMPORTANT:
1. Extract ONLY entities and relationships that are RELEVANT to the analysis focus
2. Use the EXACT text from the document for entity names
3. Choose appropriate entity types based on the context
4. Create meaningful relationships between entities
5. All property values must be primitive types (string, number, boolean)
6. Do not use nested objects in properties
7. Ensure relationship endpoints reference existing entities
8. Do not include duplicate entities (same text and type)`;

        this.model = this.config.model;
    }

    log(step, action, message, data = {}) {
        if (this.debug) {
            const timestamp = new Date().toISOString();
            const dataStr = Object.keys(data).length > 0 ? ` | ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(', ')}` : '';
            console.log(`[${timestamp}] [LLMService] STEP ${step} - ${action}: ${message}${dataStr}`);
        }
    }

    async makeOpenAIRequest(messages, options = {}) {
        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages,
                temperature: this.config.temperature,
                stream: options.stream ?? false,
                ...options
            });
            return response;
        } catch (error) {
            console.error('[LLMService] OpenAI API error:', error);
            throw error;
        }
    }

    async processTextToGraph(text, documentId, chunkIndex, analysisDescription, embedding) {

        let entities = [];
        let relationships = [];
        let useSimpleQuery = false;

        try {
            this.log('4.3', 'processTextToGraph', 'Extracting entities and relationships');
            // Try to get entities and relationships from the LLM
            const messages = [
                { role: "system", content: this.systemPrompt },
                {
                    role: "user",
                    content: `Given this text and analysis focus, extract entities and relationships:\n\nText: ${text}\n\nAnalysis focus: ${analysisDescription}`
                }
            ];

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: messages,
                temperature: 0
            });

            const content = response.choices[0]?.message?.content;
            if (content) {
                const parsedResponse = JSON.parse(content);
                entities = parsedResponse.entities || [];
                relationships = parsedResponse.relationships || [];
                this.log('4.4', 'processTextToGraph', 'Entities and relationships extracted', {
                    entityCount: entities.length,
                    relationshipCount: relationships.length
                });
            }
        } catch (error) {
            this.log('WARN', 'processTextToGraph', 'Entity extraction failed, using vector embeddings only', {
                error: error.message
            });
            useSimpleQuery = true;
        }

        let query;
        if (!useSimpleQuery && entities.length > 0) {
            try {
                this.log('4.5', 'processTextToGraph', 'Building full query with entities');
                // Validate and sanitize entity properties
                entities = entities.map(e => {
                    const baseProps = {
                        text: String(e.text),
                        type: String(e.type)
                    };

                    if (e.properties && typeof e.properties === 'object') {
                        for (const [key, value] of Object.entries(e.properties)) {
                            if (value == null) continue;
                            baseProps[`prop_${key}`] = String(value);
                        }
                    }

                    return baseProps;
                });

                // Full query with entities and relationships
                query = `
                    // First create the document chunk with its embedding
                    MATCH (d:Document {documentId: $documentId})
                    CREATE (c:DocumentChunk)
                    SET c += {
                        documentId: $documentId,
                        chunkIndex: $chunkIndex,
                        content: $text,
                        embedding: $embedding,
                        hasEntities: true
                    }
                    CREATE (d)-[:HAS_CHUNK]->(c)

                    // Then create entities
                    WITH c
                    UNWIND $entities as entity
                    CREATE (e:Entity)
                    SET e = entity
                    CREATE (c)-[:HAS_ENTITY]->(e)

                    // Finally create relationships
                    WITH c, collect(e) as entityNodes
                    UNWIND $relationships as rel
                    MATCH (e1:Entity {text: rel.from, type: rel.fromType})<-[:HAS_ENTITY]-(c)
                    MATCH (e2:Entity {text: rel.to, type: rel.toType})<-[:HAS_ENTITY]-(c)
                    CREATE (e1)-[r:RELATES_TO {type: rel.type}]->(e2)
                    RETURN count(r) as relationshipCount, count(entityNodes) as entityCount
                `;
                this.log('4.6', 'processTextToGraph', 'Full query built successfully');
            } catch (error) {
                this.log('WARN', 'processTextToGraph', 'Error preparing entity data, using vector-only storage', {
                    error: error.message
                });
                useSimpleQuery = true;
            }
        } else {
            useSimpleQuery = true;
        }

        if (useSimpleQuery) {
            this.log('4.7', 'processTextToGraph', 'Building simplified vector-only query');
            query = `
                MATCH (d:Document {documentId: $documentId})
                CREATE (c:DocumentChunk)
                SET c += {
                    documentId: $documentId,
                    chunkIndex: $chunkIndex,
                    content: $text,
                    embedding: $embedding,
                    hasEntities: false
                }
                CREATE (d)-[:HAS_CHUNK]->(c)
                RETURN 0 as relationshipCount, 0 as entityCount
            `;
            entities = [];
            relationships = [];
        }

        const params = {
            documentId,
            chunkIndex,
            text,
            embedding,
            entities,
            relationships: relationships.map(r => ({
                from: String(r.from),
                fromType: String(r.fromType),
                to: String(r.to),
                toType: String(r.toType),
                type: String(r.type)
            }))
        };

        this.log('4.8', 'processTextToGraph', 'Query parameters prepared', {
            queryType: useSimpleQuery ? 'vector-only' : 'full',
            entityCount: entities.length,
            relationshipCount: relationships.length
        });

        return { query, params };
    }

    async chat(question, options = {}) {
        try {
            // Show thinking state
            if (options.onThinking) {
                options.onThinking("Thinking...");
            }

            // Get combined vector similarity and graph query results
            const query = await this.generateDatabaseQuery(question, options.documentId);
            const session = this.driver.session();

            try {
                const result = await session.run(query);

                // Process the results to create a context for the LLM
                let context = '';
                const chunks = result.records.map(record => ({
                    content: record.get('content'),
                    similarity: record.get('similarity'),
                    entities: record.get('entities'),
                    relationships: record.get('relationships')
                }));

                // Sort chunks by similarity and build context
                chunks.sort((a, b) => b.similarity - a.similarity);

                chunks.forEach(chunk => {
                    // Add the chunk content with better formatting
                    context += `\n📄 **Content** (Relevance: ${(chunk.similarity * 100).toFixed(1)}%)\n${chunk.content}\n`;

                    // Add entity information if available
                    if (chunk.entities && chunk.entities.length > 0) {
                        context += '\n🏷️ **Relevant Entities**:\n';
                        chunk.entities.forEach(entity => {
                            context += `• ${entity.type}: **${entity.text}**`;
                            if (entity.properties) {
                                context += ` _(${JSON.stringify(entity.properties)})_`;
                            }
                            context += '\n';
                        });
                    }

                    // Add relationship information if available
                    if (chunk.relationships && chunk.relationships.length > 0) {
                        context += '\n🔗 **Relationships**:\n';
                        chunk.relationships.forEach(rel => {
                            context += `• **${rel.fromEntity}** (${rel.fromType}) ➜ _${rel.type}_ ➜ **${rel.toEntity}** (${rel.toType})\n`;
                        });
                    }

                    context += '\n---\n';
                });

                // Generate the final answer using the combined context
                const messages = [
                    {
                        role: "system",
                        content: `You are a helpful assistant that answers questions based on the provided context. 
Use both the content and the structured information about entities and relationships to provide accurate answers.
Format your responses using markdown:
- Use **bold** for emphasis and important points
- Use bullet points (•) for lists
- Use > for quotes or important excerpts
- Use \`code\` for technical terms or values
- Use --- for separating sections
- Use emojis 🎯 to make the response more engaging
- Structure your response with clear sections when appropriate`
                    },
                    {
                        role: "user",
                        content: `Context:\n${context}\n\nQuestion: ${question}\n\nProvide a clear and well-formatted answer based on the above context. If the context doesn't contain enough information to answer the question confidently, say so.`
                    }
                ];

                // Store the current stream controller
                let currentController = null;

                // Handle stream interruption
                const handleInterrupt = () => {
                    if (currentController) {
                        currentController.abort();
                        currentController = null;
                    }
                };

                // Set up stream handling
                if (options.onInterrupt) {
                    options.onInterrupt(handleInterrupt);
                }

                // Create abort controller for this stream
                currentController = new AbortController();

                const response = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: messages,
                    temperature: 0.7,
                    stream: true,
                    signal: currentController.signal
                });

                return response;
            } finally {
                await session.close();
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                return null; // Stream was interrupted
            }
            console.error('Error in chat:', error);
            throw error;
        }
    }

    formatChatResponse(records) {
        let response = {
            content: [],
            entities: []
        };

        records.forEach(record => {
            const content = record.get('content') || record.get('c.content');
            if (content) response.content.push(content);

            const entities = record.get('entities');
            if (entities && Array.isArray(entities)) {
                response.entities.push(...entities);
            }
        });

        return response;
    }

    async generateDatabaseQuery(question, documentId = null) {
        try {
            // First, get similar chunks using vector similarity
            const { query: vectorQuery, params: vectorParams } = await this.searchSimilarChunks(question, documentId);

            // Then, construct a query that combines vector similarity with entity relationships
            const query = `
                // First, get the most similar chunks using vector similarity
                ${vectorQuery}
                WITH collect({content: content, documentId: documentId, similarity: similarity}) as similarChunks

                // Then, get entities and relationships from these chunks
                UNWIND similarChunks as chunk
                MATCH (d:Document {documentId: chunk.documentId})-[:HAS_CHUNK]->(c:DocumentChunk)
                WHERE c.content = chunk.content
                OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e:Entity)
                OPTIONAL MATCH (e)-[r:RELATES_TO]->(e2:Entity)
                WHERE (c)-[:HAS_ENTITY]->(e2)

                // Return both content and graph structure
                RETURN 
                    chunk.content as content,
                    chunk.similarity as similarity,
                    collect(DISTINCT {
                        text: e.text,
                        type: e.type,
                        properties: e.properties
                    }) as entities,
                    collect(DISTINCT {
                        fromEntity: e.text,
                        fromType: e.type,
                        toEntity: e2.text,
                        toType: e2.type,
                        type: r.type
                    }) as relationships
                ORDER BY chunk.similarity DESC
            `;

            return query;
        } catch (error) {
            console.error('Error generating database query:', error);
            throw error;
        }
    }

    async generateAnswer(question, context) {
        this.log('7', 'generateAnswer', 'Starting answer generation', {
            question
        });

        try {
            // Create abort controller for this stream
            const controller = new AbortController();

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: "system",
                        content: `You are a helpful assistant that answers questions based on the provided context. 
Format your responses using markdown:
- Use **bold** for emphasis and important points
- Use bullet points (•) for lists
- Use > for quotes or important excerpts
- Use \`code\` for technical terms or values
- Use --- for separating sections
- Use emojis 🎯 to make the response more engaging
- Structure your response with clear sections when appropriate

Use only the information from the context to answer questions. If you cannot find the answer in the context, say so.`
                    },
                    {
                        role: "user",
                        content: `Context:\n${context}\n\nQuestion: ${question}\n\nProvide a clear and well-formatted answer:`
                    }
                ],
                temperature: 0.7,
                stream: true,
                signal: controller.signal
            });

            this.log('7.1', 'generateAnswer', 'Answer generation completed');
            return {
                response,
                controller
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                return null; // Stream was interrupted
            }
            this.log('ERROR', 'generateAnswer', 'Error generating answer', {
                error: error.message
            });
            throw error;
        }
    }

    // Add a method to search using vector similarity
    async searchSimilarChunks(searchTerms, documentFilter = '', documentIds = []) {
        const session = this.driver.session();
        try {
            // Simple text-based search
            const query = `
                MATCH (c:DocumentChunk)
                WHERE c.documentId IN $documentIds
                AND toLower(c.content) CONTAINS toLower($searchTerms)
                RETURN c.content AS content, c.documentId AS documentId, 1.0 as relevance
                LIMIT toInteger(5)
            `;

            const result = await session.run(query, {
                searchTerms,
                documentIds: documentIds
            });

            if (!result.records || result.records.length === 0) {
                // If no exact matches, return first few chunks
                const fallbackQuery = `
                    MATCH (c:DocumentChunk)
                    WHERE c.documentId IN $documentIds
                    RETURN c.content AS content, c.documentId AS documentId, 0.1 as relevance
                    ORDER BY c.chunkIndex
                    LIMIT toInteger(5)
                `;

                const fallbackResult = await session.run(fallbackQuery, { documentIds });
                return fallbackResult.records.map(record => ({
                    content: record.get('content'),
                    documentId: record.get('documentId'),
                    relevance: record.get('relevance') || 0
                }));
            }

            return result.records.map(record => ({
                content: record.get('content'),
                documentId: record.get('documentId'),
                relevance: record.get('relevance') || 0
            }));
        } catch (error) {
            console.error('Error in searchSimilarChunks:', error);
            return [];
        } finally {
            await session.close();
        }
    }

    // Add method to create necessary indexes
    async createIndexes() {
        const session = this.driver.session();
        try {
            // Create full-text search index on DocumentChunk content
            await session.run(`
                CALL db.index.fulltext.createNodeIndex(
                    "chunkContent",
                    ["DocumentChunk"],
                    ["content"]
                )
            `);

            // Create regular indexes for common lookups
            await session.run(`
                CREATE INDEX document_chunk_id IF NOT EXISTS
                FOR (c:DocumentChunk)
                ON (c.documentId)
            `);

            await session.run(`
                CREATE INDEX entity_text_type IF NOT EXISTS
                FOR (e:Entity)
                ON (e.text, e.type)
            `);

        } catch (error) {
            console.error('Error creating indexes:', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    // Update initialize method to ensure indexes are created
    async initialize() {
        try {
            await this.createIndexes();
            console.log('Indexes created successfully');
        } catch (error) {
            console.error('Error during initialization:', error);
            throw error;
        }
    }

    async getEmbedding(text) {
        try {
            const embeddingResponse = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text,
                encoding_format: "float"
            });

            return embeddingResponse.data[0].embedding;
        } catch (error) {
            console.error('Error getting embedding:', error);
            throw error;
        }
    }

    async searchSimilarVectors(embedding, documentIds) {
        const session = this.driver.session();
        try {
            // We'll use a manual dot product calculation for cosine similarity
            const result = await session.run(`
                MATCH (c:DocumentChunk)
                WHERE c.documentId IN $documentIds AND c.embedding IS NOT NULL
                WITH c, 
                     reduce(dot = 0.0, i IN range(0, size($embedding)-1) | 
                        dot + $embedding[i] * c.embedding[i]) /
                     (sqrt(reduce(norm1 = 0.0, i IN range(0, size($embedding)-1) | 
                        norm1 + $embedding[i] * $embedding[i])) *
                      sqrt(reduce(norm2 = 0.0, i IN range(0, size(c.embedding)-1) | 
                        norm2 + c.embedding[i] * c.embedding[i]))) AS similarity
                WHERE similarity > 0.7
                RETURN c.content AS content, similarity AS score
                ORDER BY similarity DESC
                LIMIT 5
            `, {
                embedding,
                documentIds
            });

            return result.records.map(record => ({
                content: record.get('content'),
                score: record.get('score')
            }));
        } catch (error) {
            console.error('Error in vector search:', error);
            // Fallback to empty results if vector search fails
            return [];
        } finally {
            await session.close();
        }
    }

    // Add embedding storage during chunk creation
    async processChunk(chunk, documentId, index) {
        const session = this.driver.session();
        try {
            // Generate embedding for the chunk
            const embedding = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: chunk.content,
                dimensions: 1536
            });

            // Store chunk with embedding
            await session.run(`
                MATCH (d:Document {documentId: $documentId})
                CREATE (c:DocumentChunk {
                    documentId: $documentId,
                    content: $content,
                    embedding: $embedding,
                    index: $index,
                    created: datetime()
                })
                CREATE (d)-[:HAS_CHUNK]->(c)
            `, {
                documentId,
                content: chunk.content,
                embedding: embedding.data[0].embedding,
                index
            });

            return true;
        } catch (error) {
            console.error('Error processing chunk:', error);
            throw error;
        } finally {
            await session.close();
        }
    }
}