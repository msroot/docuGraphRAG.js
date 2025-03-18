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

    async makeOpenAIRequest(messages = [], options = {}) {
        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages,
                temperature: this.config.temperature,
                stream: options.stream ?? false,
                ...options
            });

            return response.choices[0]?.message?.content;

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

        const messages = [
            { role: "system", content: this.systemPrompt },
            {
                role: "user",
                content: `Given this text and analysis focus, extract entities and relationships:\n\nText: ${text}\n\nAnalysis focus: ${analysisDescription}`
            }
        ];

        const content = await this.makeOpenAIRequest(messages);



        const parsedResponse = JSON.parse(content);
        let entities = parsedResponse.entities || [];
        let relationships = parsedResponse.relationships || [];




        // Validate and sanitize entity properties
        entities = entities.map(e => {
            const baseProps = {
                text: String(e.text).trim(),
                type: String(e.type).trim()
            };

            // Add all properties from the entity
            if (e.properties && typeof e.properties === 'object') {
                for (const [key, value] of Object.entries(e.properties)) {
                    if (value != null) {
                        baseProps[key] = String(value).trim();
                    }
                }
            }

            return baseProps;
        });

        relationships = relationships.map(r => ({
            from: String(r.from).trim(),
            fromType: String(r.fromType).trim(),
            to: String(r.to).trim(),
            toType: String(r.toType).trim(),
            type: String(r.type).trim()
        }))


        // Full query with entities and relationships
        const query = `
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





        const params = {
            documentId,
            chunkIndex,
            text,
            embedding,
            entities,
            relationships
        };

        return { query, params };
    }



    async generateAnswer(question, context) {


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
        // First, extract key entities from the question using OpenAI
        const messages = [{
            role: "system", content: "Extract key entities from the question. Return ONLY a JSON array of strings with the entity names. Example: ['John Smith', 'Microsoft']"
        }, { role: "user", content: question }]

        const entityResponse = await this.makeOpenAIRequest(messages, { temperature: 0 });
        let searchEntities = JSON.parse(entityResponse);
        console.log('Search entities:', searchEntities);

        // First, let's see what entities we have in the database
        const debugQuery = `
            MATCH (e:Entity)
            RETURN e.text, e.type, e.documentId
            LIMIT 10
        `;
        const debugResult = await this.runQuery(debugQuery);
        console.log('All entities in database:', debugResult.records.map(r => ({
            text: r.get('e.text'),
            type: r.get('e.type'),
            documentId: r.get('e.documentId')
        })));

        // Build a Cypher query that finds paths between entities and through relevant chunks
        const query = `
                // Match documents within scope
                MATCH (d:Document)
                WHERE d.documentId IN $documentIds
                WITH d
                
                // Find chunks that contain our search entities
                MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)-[:HAS_ENTITY]->(e:Entity)
                WHERE any(searchTerm IN $searchEntities 
                    WHERE toLower(e.text) = toLower(searchTerm) 
                    OR toLower(e.text) CONTAINS toLower(searchTerm)
                    OR toLower(searchTerm) CONTAINS toLower(e.text))
                
                // Get the chunk content and matching entities
                WITH c, collect(DISTINCT e) as matchingEntities
                
                // For each matching entity, find related entities through relationships
                UNWIND matchingEntities as me
                MATCH path = (me)-[:RELATES_TO*0..3]-(related:Entity)
                
                // Get the chunk content and path information
                WITH c, path, me, related
                
                // Calculate relevance score based on path length and entity matches
                WITH c, path,
                     size(relationships(path)) as pathLength,
                     [node IN nodes(path) WHERE node:Entity | node.text] as entityTexts
                
                // Calculate a relevance score
                WITH c, path, pathLength,
                     1.0 / (pathLength + 1) as pathScore,
                     size([x IN entityTexts WHERE any(term IN $searchEntities 
                          WHERE toLower(x) = toLower(term)
                          OR toLower(x) CONTAINS toLower(term)
                          OR toLower(term) CONTAINS toLower(x))]) as matchCount
                
                // Combine scores and return results
                WITH c, path,
                     (pathScore * matchCount) as relevanceScore
                
                // Group by chunk and collect all paths
                WITH c.documentId as docId, c.content as content,
                     collect({
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
                     }) as paths
                
                // Get the best path for each chunk
                WITH docId, content, paths,
                     reduce(maxScore = 0.0, p IN paths | CASE WHEN p.score > maxScore THEN p.score ELSE maxScore END) as bestScore,
                     [p IN paths WHERE p.score = reduce(maxScore = 0.0, p2 IN paths | CASE WHEN p2.score > maxScore THEN p2.score ELSE maxScore END)][0] as bestPath
                
                // Deduplicate by content and documentId
                WITH docId, content, bestScore, bestPath
                ORDER BY bestScore DESC
                
                // Collect unique results
                WITH collect({
                    content: content,
                    documentId: docId,
                    score: bestScore,
                    entities: bestPath.entities,
                    relationships: bestPath.relationships
                }) as results
                
                // Return unique results
                RETURN [r IN results WHERE r.content IS NOT NULL] as result
                LIMIT 10`;

        const result = await this.runQuery(query, {
            documentIds,
            searchEntities
        });

        const data = result.records[0]?.get('result') || [];
        console.log('Query results:', JSON.stringify(data, null, 2));
        return data;
    }


}