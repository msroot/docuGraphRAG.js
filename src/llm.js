import OpenAI from 'openai';

export class LLMService {
    constructor(config = {}) {
        this.config = {
            debug: false,
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

    log(message) {
        if (this.debug) {
            console.log(`[LLMService][${this.config.model}] ${message}`);
        }
    }

    async makeOpenAIRequest(messages, options = {}) {
        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages,
                // temperature: this.config.temperature,

                // stream: options.stream ?? false,
                // ...options
            });
            return response;
        } catch (error) {
            console.error('[LLMService] OpenAI API error:', error);
            throw error;
        }
    }

    async processTextToGraph(text, documentId, chunkIndex, analysisDescription) {
        let embedding;
        try {
            // First, get the vector embedding for the chunk
            const embeddingResponse = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text,
                encoding_format: "float"
            });

            embedding = embeddingResponse.data[0].embedding;
        } catch (error) {
            console.error('Error getting vector embedding:', error);
            throw error; // We can't proceed without embeddings
        }

        let entities = [];
        let relationships = [];
        let useSimpleQuery = false;

        try {
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
            }
        } catch (error) {
            console.warn('Entity extraction failed, continuing with vector embeddings only:', error);
            useSimpleQuery = true;
        }

        // Create appropriate Cypher query based on whether we have entities and if previous query failed
        let query;
        if (!useSimpleQuery && entities.length > 0) {
            try {
                // Validate and sanitize entity properties to ensure they are primitive types
                entities = entities.map(e => {
                    // Convert base properties to strings
                    const baseProps = {
                        text: String(e.text),
                        type: String(e.type)
                    };

                    // Flatten and sanitize additional properties
                    if (e.properties && typeof e.properties === 'object') {
                        for (const [key, value] of Object.entries(e.properties)) {
                            // Skip null or undefined values
                            if (value == null) continue;
                            // Convert everything else to string
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
            } catch (error) {
                console.warn('Error preparing entity data, falling back to vector-only storage:', error);
                useSimpleQuery = true;
            }
        } else {
            useSimpleQuery = true;
        }

        if (useSimpleQuery) {
            // Simplified query for chunks with only vector embeddings
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
            // Reset entities and relationships for the params
            entities = [];
            relationships = [];
        }

        // Prepare parameters
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

        return { query, params };
    }

    async chat(question, options = {}) {
        try {
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
                    // Add the chunk content
                    context += `\nContent (similarity: ${chunk.similarity.toFixed(3)}):\n${chunk.content}\n`;

                    // Add entity information if available
                    if (chunk.entities && chunk.entities.length > 0) {
                        context += '\nRelevant Entities:\n';
                        chunk.entities.forEach(entity => {
                            context += `- ${entity.type}: ${entity.text}`;
                            if (entity.properties) {
                                context += ` (${JSON.stringify(entity.properties)})`;
                            }
                            context += '\n';
                        });
                    }

                    // Add relationship information if available
                    if (chunk.relationships && chunk.relationships.length > 0) {
                        context += '\nRelationships:\n';
                        chunk.relationships.forEach(rel => {
                            context += `- ${rel.fromEntity} (${rel.fromType}) ${rel.type} ${rel.toEntity} (${rel.toType})\n`;
                        });
                    }

                    context += '\n---\n';
                });

                // Generate the final answer using the combined context
                const messages = [
                    { role: "system", content: "You are a helpful assistant that answers questions based on the provided context. Use both the content and the structured information about entities and relationships to provide accurate answers." },
                    { role: "user", content: `Context:\n${context}\n\nQuestion: ${question}\n\nProvide a clear and concise answer based on the above context. If the context doesn't contain enough information to answer the question confidently, say so.` }
                ];

                const response = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: messages,
                    temperature: 0.7
                });

                return response.choices[0]?.message?.content || 'No answer generated';
            } finally {
                await session.close();
            }
        } catch (error) {
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
        const prompt = `Based on the following context, answer this question: "${question}"

Context:
${context}

Provide a clear and concise answer based ONLY on the information provided in the context.`;

        const response = await this.makeOpenAIRequest([
            {
                role: "system",
                content: "You are a helpful assistant that provides accurate answers based on the given context. Only use information from the provided context."
            },
            { role: "user", content: prompt }
        ]);

        return response.choices[0]?.message?.content || 'No answer generated';
    }

    // Add a method to search using vector similarity
    async searchSimilarChunks(question, documentId = null, topK = 5) {
        try {
            // Get the vector embedding for the question
            const embeddingResponse = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: question,
                encoding_format: "float"
            });

            const questionEmbedding = embeddingResponse.data[0].embedding;

            // Create a full-text search pattern
            // Remove special characters and add fuzzy matching
            const searchTerms = question
                .replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter(term => term.length > 2)
                .map(term => `${term}~`)
                .join(' OR ');

            // Construct the Cypher query using manual cosine similarity calculation
            const query = documentId ? `
                // Match document chunks for the specific document
                MATCH (d:Document {documentId: $documentId})-[:HAS_CHUNK]->(c:DocumentChunk)
                WHERE c.embedding IS NOT NULL
                
                // Calculate cosine similarity manually
                WITH c, 
                     reduce(dot = 0.0, i in range(0, size(c.embedding)-1) | 
                         dot + c.embedding[i] * $questionEmbedding[i]
                     ) / (
                         sqrt(reduce(l2 = 0.0, i in range(0, size(c.embedding)-1) | 
                             l2 + c.embedding[i] * c.embedding[i]
                         )) * 
                         sqrt(reduce(l2 = 0.0, i in range(0, size($questionEmbedding)-1) | 
                             l2 + $questionEmbedding[i] * $questionEmbedding[i]
                         ))
                     ) as vectorScore
                
                // Perform full-text search on content if terms exist
                WITH c, vectorScore,
                     apoc.text.fuzzyMatch(c.content, $searchTerms) as textScore
                
                // Combine scores
                WITH c, 
                     CASE 
                         WHEN vectorScore IS NULL THEN 0 
                         ELSE vectorScore 
                     END * 0.6 + 
                     CASE 
                         WHEN textScore > 0 THEN textScore 
                         ELSE 0 
                     END * 0.4 as combinedScore
                
                // Order by combined score and limit results
                WHERE combinedScore > 0
                ORDER BY combinedScore DESC
                LIMIT $topK
                
                RETURN 
                    c.content as content,
                    c.documentId as documentId,
                    combinedScore as similarity
            ` : `
                // Match all document chunks
                MATCH (d:Document)-[:HAS_CHUNK]->(c:DocumentChunk)
                WHERE c.embedding IS NOT NULL
                
                // Calculate cosine similarity manually
                WITH c, 
                     reduce(dot = 0.0, i in range(0, size(c.embedding)-1) | 
                         dot + c.embedding[i] * $questionEmbedding[i]
                     ) / (
                         sqrt(reduce(l2 = 0.0, i in range(0, size(c.embedding)-1) | 
                             l2 + c.embedding[i] * c.embedding[i]
                         )) * 
                         sqrt(reduce(l2 = 0.0, i in range(0, size($questionEmbedding)-1) | 
                             l2 + $questionEmbedding[i] * $questionEmbedding[i]
                         ))
                     ) as vectorScore
                
                // Perform full-text search on content if terms exist
                WITH c, vectorScore,
                     apoc.text.fuzzyMatch(c.content, $searchTerms) as textScore
                
                // Combine scores
                WITH c, 
                     CASE 
                         WHEN vectorScore IS NULL THEN 0 
                         ELSE vectorScore 
                     END * 0.6 + 
                     CASE 
                         WHEN textScore > 0 THEN textScore 
                         ELSE 0 
                     END * 0.4 as combinedScore
                
                // Order by combined score and limit results
                WHERE combinedScore > 0
                ORDER BY combinedScore DESC
                LIMIT $topK
                
                RETURN 
                    c.content as content,
                    c.documentId as documentId,
                    combinedScore as similarity
            `;

            const params = {
                questionEmbedding,
                documentId,
                topK,
                searchTerms
            };

            return { query, params };
        } catch (error) {
            console.error('Error in searchSimilarChunks:', error);
            throw error;
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

            // Create vector index for similarity search
            await session.run(`
                CALL gds.vector.createIndex(
                    'document_chunks',
                    'DocumentChunk',
                    ['embedding'],
                    {
                        similarity: 'cosine'
                    }
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
}