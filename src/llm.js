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
            throw error;
        }
    }

    async generateEmbedding(text) {
        try {
            const response = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text,
                dimensions: 1536
            });

            return response.data[0].embedding;
        } catch (error) {
            throw error;
        }
    }

    async processTextToGraph(text, documentId, chunkIndex, analysisDescription, embedding) {
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
            useSimpleQuery = true;
        }

        let query;
        if (!useSimpleQuery && entities.length > 0) {
            try {
                // Validate and sanitize entity properties
                entities = entities.map(e => {
                    const baseProps = {
                        text: String(e.text),
                        type: String(e.type)
                    };

                    // Add all properties from the entity
                    if (e.properties && typeof e.properties === 'object') {
                        for (const [key, value] of Object.entries(e.properties)) {
                            if (value != null) {
                                baseProps[key] = String(value).trim();
                                baseProps[`prop_${key}`] = String(value).trim();
                            }
                        }
                    }

                    return baseProps;
                });

                // Full query with entities and relationships
                query = `
                    // First create or merge the document chunk with its embedding
                    MATCH (d:Document {documentId: $documentId})
                    MERGE (c:DocumentChunk {documentId: $documentId, chunkIndex: $chunkIndex})
                    SET c += {
                        content: $text,
                        embedding: $embedding,
                        hasEntities: true,
                        created: datetime(),
                        lastUpdated: datetime()
                    }
                    MERGE (d)-[:HAS_CHUNK]->(c)

                    // Then create or merge entities using APOC with all properties
                    WITH c
                    UNWIND $entities as entity
                    CALL apoc.merge.node(['Entity'], 
                        {text: entity.text, type: entity.type}, 
                        entity
                    ) YIELD node
                    MERGE (c)-[:HAS_ENTITY]->(node)

                    // Finally create or merge relationships using APOC with all properties
                    WITH c, collect(node) as entityNodes
                    UNWIND $relationships as rel
                    MATCH (e1:Entity {text: rel.from, type: rel.fromType})<-[:HAS_ENTITY]-(c)
                    MATCH (e2:Entity {text: rel.to, type: rel.toType})<-[:HAS_ENTITY]-(c)
                    CALL apoc.merge.relationship(e1, rel.type, 
                        {type: rel.type}, 
                        {
                            type: rel.type,
                            fromType: rel.fromType,
                            toType: rel.toType
                        }, 
                        e2
                    ) YIELD rel as r
                    RETURN c, count(r) as relationshipCount, count(entityNodes) as entityCount
                `;
            } catch (error) {
                useSimpleQuery = true;
            }
        } else {
            useSimpleQuery = true;
        }

        if (useSimpleQuery) {
            query = `
                MATCH (d:Document {documentId: $documentId})
                MERGE (c:DocumentChunk {documentId: $documentId, chunkIndex: $chunkIndex})
                SET c += {
                    content: $text,
                    embedding: $embedding,
                    hasEntities: false,
                    lastUpdated: datetime()
                }
                MERGE (d)-[:HAS_CHUNK]->(c)
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
            entities: entities.map(e => {
                const baseProps = {
                    text: String(e.text).trim(),
                    type: String(e.type).trim()
                };

                // Add all properties from the entity
                if (e.properties && typeof e.properties === 'object') {
                    for (const [key, value] of Object.entries(e.properties)) {
                        if (value != null) {
                            baseProps[key] = String(value).trim();
                            baseProps[`prop_${key}`] = String(value).trim();
                        }
                    }
                }

                return baseProps;
            }),
            relationships: relationships.map(r => ({
                from: String(r.from).trim(),
                fromType: String(r.fromType).trim(),
                to: String(r.to).trim(),
                toType: String(r.toType).trim(),
                type: String(r.type).trim()
            }))
        };

        return { query, params };
    }

    async chat(question, { documentIds }) {
        try {
            // Get combined search results
            const searchResults = await this.enhancedSearch(question, documentIds);

            // Process the results to create a context for the LLM
            let context = '';
            searchResults.forEach(result => {
                // Add the chunk content with scores
                context += `\n📄 **Content** (Relevance: ${(result.combinedScore * 100).toFixed(1)}%)\n${result.content}\n`;

                // Add entity information if available
                if (result.entities && result.entities.length > 0) {
                    context += '\n🏷️ **Relevant Entities**:\n';
                    result.entities.forEach(entity => {
                        context += `• ${entity.type}: **${entity.text}**\n`;
                    });
                }

                // Add relationship information if available
                if (result.relationships && result.relationships.length > 0) {
                    context += '\n🔗 **Relationships**:\n';
                    result.relationships.forEach(rel => {
                        context += `• **${rel.from}** ➜ _${rel.type}_ ➜ **${rel.to}**\n`;
                    });
                }

                context += '\n---\n';
            });

            // Generate the answer using the combined context
            return await this.generateAnswer(question, context);
        } catch (error) {
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
            throw error;
        }
    }

    async generateAnswer(question, context) {
        try {
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
                stream: true
            });

            return response;
        } catch (error) {
            throw error;
        }
    }

    // Add a method to search using vector similarity
    async searchSimilarVectors(questionEmbedding, documentIds) {
        const session = this.driver.session();
        try {
            // Use native cosine similarity calculation
            const query = `
                // Match chunks from specified documents
                MATCH (c:DocumentChunk)
                WHERE c.documentId IN $documentIds
                  AND c.embedding IS NOT NULL

                // Calculate cosine similarity using dot product and magnitudes
                WITH c, 
                     reduce(dot = 0.0, i in range(0, size($embedding)-1) |
                        dot + c.embedding[i] * $embedding[i]
                     ) / (
                        sqrt(reduce(mag1 = 0.0, i in range(0, size(c.embedding)-1) |
                            mag1 + c.embedding[i] * c.embedding[i]
                        )) *
                        sqrt(reduce(mag2 = 0.0, i in range(0, size($embedding)-1) |
                            mag2 + $embedding[i] * $embedding[i]
                        ))
                     ) AS similarity
                WHERE similarity > 0.6  // Minimum similarity threshold

                // Return results ordered by similarity
                RETURN 
                    c.content AS content,
                    c.documentId AS documentId,
                    similarity AS score
                ORDER BY similarity DESC
                LIMIT 5
            `;

            const result = await session.run(query, {
                documentIds,
                embedding: questionEmbedding
            });

            return result.records.map(record => ({
                content: record.get('content'),
                documentId: record.get('documentId'),
                score: record.get('score')
            }));
        } catch (error) {
            return [];
        } finally {
            await session.close();
        }
    }

    async searchSimilarChunks(question, _, documentIds) {
        const session = this.driver.session();
        try {
            // Use text search with CONTAINS and word matching
            const query = `
                MATCH (c:DocumentChunk)
                WHERE c.documentId IN $documentIds
                
                // Split question into words for better matching
                WITH c, split(toLower($question), ' ') as searchWords
                
                // Calculate how many words match
                WITH c, searchWords,
                     reduce(score = 0.0,
                           word IN searchWords |
                           score + CASE 
                                    WHEN toLower(c.content) CONTAINS toLower(word)
                                    THEN 1.0
                                    ELSE 0.0
                                  END
                     ) as matchCount
                
                // Calculate relevance score
                WITH c, 
                     matchCount / size(searchWords) as relevance
                WHERE relevance > 0
                
                RETURN 
                    c.content as content,
                    c.documentId as documentId,
                    relevance
                ORDER BY relevance DESC
                LIMIT 5
            `;

            const result = await session.run(query, {
                question,
                documentIds
            });

            return result.records.map(record => ({
                content: record.get('content'),
                documentId: record.get('documentId'),
                relevance: record.get('relevance')
            }));

        } catch (error) {
            // Fallback to simple contains search
            try {
                const fallbackQuery = `
                    MATCH (c:DocumentChunk)
                    WHERE c.documentId IN $documentIds
                    AND toLower(c.content) CONTAINS toLower($question)
                    RETURN 
                        c.content as content,
                        c.documentId as documentId,
                        0.5 as relevance
                    LIMIT 5
                `;

                const fallbackResult = await session.run(fallbackQuery, {
                    question,
                    documentIds
                });

                return fallbackResult.records.map(record => ({
                    content: record.get('content'),
                    documentId: record.get('documentId'),
                    relevance: 0.5
                }));
            } catch (e) {
                return [];
            }
        } finally {
            await session.close();
        }
    }

    async enhancedSearch(question, documentIds) {
        try {
            // Generate embedding for the question
            const questionEmbedding = await this.getEmbedding(question);
            const session = this.driver.session();

            try {
                // Single query combining vector, text, and graph search
                const query = `
                    // Match chunks from specified documents
                    MATCH (c:DocumentChunk)
                    WHERE c.documentId IN $documentIds
                      AND c.embedding IS NOT NULL

                    // Calculate vector similarity
                    WITH c, gds.similarity.cosine(c.embedding, $embedding) AS vectorScore

                    // Add text matching score
                    WITH c, vectorScore,
                         CASE 
                            WHEN toLower(c.content) CONTAINS toLower($question) 
                            THEN toFloat(size(split(toLower(c.content), toLower($question))) - 1) / size(split(c.content, ' '))
                            ELSE 0 
                         END AS textScore

                    // Get entities and relationships
                    OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e:Entity)
                    OPTIONAL MATCH (e)-[r:RELATES_TO]->(related:Entity)
                    WHERE (c)-[:HAS_ENTITY]->(related)

                    // Calculate graph relevance score
                    WITH c, vectorScore, textScore,
                         collect(DISTINCT e) as entities,
                         collect(DISTINCT r) as relationships,
                         CASE 
                            WHEN size(collect(DISTINCT e)) > 0 
                            THEN toFloat(size(collect(DISTINCT r))) / size(collect(DISTINCT e))
                            ELSE 0 
                         END AS graphScore

                    // Calculate combined score
                    WITH c, 
                         vectorScore * 0.4 + 
                         textScore * 0.3 + 
                         graphScore * 0.3 AS combinedScore,
                         vectorScore, textScore, graphScore,
                         entities, relationships
                    WHERE combinedScore > 0.3

                    // Return results
                    RETURN 
                        c.content as content,
                        c.documentId as documentId,
                        vectorScore,
                        textScore,
                        graphScore,
                        combinedScore,
                        [e IN entities | {
                            text: e.text,
                            type: e.type,
                            properties: e.properties
                        }] as entities,
                        [r IN relationships | {
                            from: startNode(r).text,
                            fromType: startNode(r).type,
                            to: endNode(r).text,
                            toType: endNode(r).type,
                            type: type(r)
                        }] as relationships
                    ORDER BY combinedScore DESC
                    LIMIT 5
                `;

                const result = await session.run(query, {
                    documentIds,
                    embedding: questionEmbedding,
                    question
                });

                return result.records.map(record => ({
                    content: record.get('content'),
                    documentId: record.get('documentId'),
                    vectorScore: record.get('vectorScore'),
                    textScore: record.get('textScore'),
                    graphScore: record.get('graphScore'),
                    combinedScore: record.get('combinedScore'),
                    entities: record.get('entities'),
                    relationships: record.get('relationships')
                }));

            } finally {
                await session.close();
            }
        } catch (error) {
            throw error;
        }
    }

    // Remove redundant methods that are now combined in enhancedSearch
    async createIndexes() {
        const session = this.driver.session();
        try {
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

            // Create index for embeddings
            await session.run(`
                CREATE INDEX document_chunk_embedding IF NOT EXISTS
                FOR (c:DocumentChunk)
                ON (c.embedding)
            `);

            // Create text search index on content
            await session.run(`
                CREATE TEXT INDEX document_chunk_content IF NOT EXISTS
                FOR (c:DocumentChunk)
                ON (c.content)
            `);

        } catch (error) {
            throw error;
        } finally {
            await session.close();
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
            throw error;
        }
    }

    async searchGraphRelationships(question, documentIds) {
        const session = this.driver.session();
        try {
            // First, extract key entities from the question using OpenAI
            const entityResponse = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages: [{
                    role: "system",
                    content: "Extract key entities from the question. Return ONLY a JSON array of strings with the entity names. Example: ['John Smith', 'Microsoft']"
                }, {
                    role: "user",
                    content: question
                }],
                temperature: 0
            });

            let searchEntities = [];
            try {
                searchEntities = JSON.parse(entityResponse.choices[0].message.content);
            } catch (e) {
                searchEntities = [];
            }

            if (searchEntities.length === 0) {
                return [];
            }

            // Build a Cypher query that finds paths between entities and through relevant chunks
            const query = `
                // Match documents within scope
                MATCH (d:Document)
                WHERE d.documentId IN $documentIds
                WITH d
                
                // Find chunks that contain our search entities
                MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)-[:HAS_ENTITY]->(e:Entity)
                WHERE any(searchTerm IN $searchEntities WHERE toLower(e.text) CONTAINS toLower(searchTerm))
                
                // Find paths between entities in these chunks
                WITH c, collect(e) as startEntities
                UNWIND startEntities as start
                MATCH path = (start)-[:RELATES_TO*1..3]-(related:Entity)
                WHERE all(r IN relationships(path) WHERE startNode(r).documentId = endNode(r).documentId)
                
                // Score the paths based on length and relevance
                WITH c, path,
                     size(relationships(path)) as pathLength,
                     [n IN nodes(path) WHERE n:Entity | n.text] as entityTexts
                
                // Calculate a relevance score
                WITH c, path, pathLength,
                     1.0 / pathLength as pathScore,
                     size([x IN entityTexts WHERE any(term IN $searchEntities 
                          WHERE toLower(x) CONTAINS toLower(term))]) as matchCount
                
                // Combine scores and return results
                WITH c, path,
                     (pathScore * matchCount) as relevanceScore
                ORDER BY relevanceScore DESC
                LIMIT 10
                
                // Return formatted results
                RETURN {
                    chunkContent: c.content,
                    score: relevanceScore,
                    entities: [node IN nodes(path) WHERE node:Entity | {
                        text: node.text,
                        type: node.type,
                        properties: node.properties
                    }],
                    relationships: [rel IN relationships(path) | {
                        from: startNode(rel).text,
                        fromType: startNode(rel).type,
                        to: endNode(rel).text,
                        toType: endNode(rel).type,
                        type: rel.type
                    }]
                } as result`;

            const result = await session.run(query, {
                documentIds,
                searchEntities
            });

            return result.records.map(record => {
                const res = record.get('result');
                return {
                    chunkContent: res.chunkContent,
                    graphScore: res.score,
                    entities: res.entities,
                    relationships: res.relationships
                };
            });
        } catch (error) {
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
            throw error;
        } finally {
            await session.close();
        }
    }
}