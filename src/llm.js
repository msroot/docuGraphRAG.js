import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';

const LLM_CONFIG = {
    MODEL: 'mistral',
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000,
    TIMEOUT: 30000,
    SCHEMA_CACHE_DURATION: 600000, // 10 minutes in milliseconds
    DEBUG: false
};

// Constants for Neo4j relationships and entity types
const RELATIONSHIPS = {
    HAS_CHUNK: 'HAS_CHUNK',
    HAS_ENTITY: 'HAS_ENTITY',
    HAS_KEYWORD: 'HAS_KEYWORD',
    EXPRESSES_CONCEPT: 'EXPRESSES_CONCEPT',
    CONTAINS_ENTITY: 'CONTAINS_ENTITY',
    CONTAINS_KEYWORD: 'CONTAINS_KEYWORD',
    CONTAINS_CONCEPT: 'CONTAINS_CONCEPT',
    MENTIONS: 'MENTIONS',
    RELATED_TO: 'RELATED_TO'
};

const NODE_LABELS = {
    DOCUMENT: 'Document',
    DOCUMENT_CHUNK: 'DocumentChunk',
    ENTITY: 'Entity'
};

const NODE_PROPERTIES = {
    ID: 'id',
    DOCUMENT_ID: 'documentId',
    FILE_NAME: 'fileName',
    FILE_TYPE: 'fileType',
    UPLOAD_DATE: 'uploadDate',
    TOTAL_CHUNKS: 'totalChunks',
    CONTENT: 'content',
    INDEX: 'index',
    TEXT: 'text',
    TYPE: 'type'
};

export class LLMService {
    constructor(config = {}) {
        this.config = {
            model: config.model || LLM_CONFIG.MODEL,
            debug: config.debug ?? LLM_CONFIG.DEBUG,
            maxRetries: config.maxRetries || LLM_CONFIG.MAX_RETRIES,
            retryDelay: config.retryDelay || LLM_CONFIG.RETRY_DELAY,
            timeout: config.timeout || LLM_CONFIG.TIMEOUT,
            schemaCacheDuration: config.schemaCacheDuration || LLM_CONFIG.SCHEMA_CACHE_DURATION
        };

        this.debug = this.config.debug;
        this.driver = config.driver; // Neo4j driver instance
        this.dbSchema = null; // Cached schema
        this.schemaLastUpdated = null;
    }

    log(...args) {
        if (this.debug) {
            console.log(`[LLMService][${this.config.model}]`, ...args);
        }
    }

    async retryRequest(requestFn, retryCount = 0) {
        try {
            return await requestFn();
        } catch (error) {
            if (retryCount < this.config.maxRetries) {
                this.log(`Request failed (attempt ${retryCount + 1}/${this.config.maxRetries}), retrying in ${this.config.retryDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                return this.retryRequest(requestFn, retryCount + 1);
            }
            throw error;
        }
    }

    async queryLLM(prompt, temperature = 0.1) {
        const result = await this.retryRequest(async () => {
            const response = await axios.post('http://localhost:11434/api/generate', {
                model: this.config.model,
                prompt: prompt,
                temperature: temperature,
                stream: false
            });

            return response.data.response;
        });

        return result;
    }

    async streamLLM(prompt, temperature = 0.1, callbacks = {}) {
        this.log('Starting streaming LLM response');
        
        try {
            const response = await axios.post('http://localhost:11434/api/generate', {
                model: this.config.model,
                prompt: prompt,
                temperature: temperature,
                stream: true
            }, {
                responseType: 'stream'
            });

            response.data.on('data', chunk => {
                try {
                    const data = JSON.parse(chunk.toString());
                    if (data.response) {
                        callbacks.onData?.(data.response);
                    }
                    if (data.done) {
                        callbacks.onEnd?.();
                    }
                } catch (error) {
                    console.error(`[LLMService][${this.config.model}] Error parsing stream chunk:`, error);
                    callbacks.onError?.(error);
                }
            });

            response.data.on('error', error => {
                console.error(`[LLMService][${this.config.model}] Stream error:`, error);
                callbacks.onError?.(error);
            });
        } catch (error) {
            console.error(`[LLMService][${this.config.model}] Stream error:`, error);
            callbacks.onError?.(error);
        }
    }

    async generateAnswer(question, context) {
        const prompt = `
Context information is below.
---------------------
${context}
---------------------

Given the context information, answer the following question. 
If the answer cannot be found in the context, say "I don't have enough information to answer that question."

Question: ${question}
Answer:`;

        return new Promise((resolve, reject) => {
            let fullResponse = '';
            
            this.streamLLM(prompt, 0.1, {
                onData: (data) => {
                    fullResponse += data;
                },
                onEnd: () => {
                    this.log('Successfully received complete response');
                    resolve(fullResponse);
                },
                onError: (error) => {
                    reject(error);
                }
            });
        });
    }

    async generateStreamingAnswer(question, context, options = {}) {
        const prompt = `
Context information is below.
---------------------
${context}
---------------------

Given the context information, answer the following question.
If the answer cannot be found in the context, say "I don't have enough information to answer that question."

Question: ${question}
Answer:`;

        await this.streamLLM(prompt, 0.1, {
            onData: (data) => options.onData?.(data),
            onEnd: () => options.onEnd?.(),
            onError: (error) => options.onError?.(error)
        });
    }

    async generateCypherQuery(text) {
        try {
            const prompt = `
You are an entity extractor. Extract entities from the given text.
Extract entities and relationships from the following text to generate a Cypher query suitable for Neo4j. 
The output should be a single Cypher query without any additional text.

Text: ${text}
`;

            this.log('Requesting entity analysis');
            const response = await this.queryLLM(prompt, 0.1);

            if (!response || !response.response) {
                return null;
            }

            // Split response into lines and process each line
            const lines = response.response.split('\n')
                .map(line => line.trim())
                .filter(line => line && line !== 'NONE');

            // Process each line to extract entities
            const entities = [];
            for (const line of lines) {
                const colonIndex = line.indexOf(':');
                if (colonIndex !== -1) {
                    const type = line.substring(0, colonIndex).trim();
                    const text = line.substring(colonIndex + 1).trim();
                    
                    if (type && text) {
                        entities.push({
                            type: type.toUpperCase(),
                            name: text
                        });
                    }
                }
            }

            // Basic validation
            if (!entities.length) {
                return null;
            }

            // Generate Cypher query that connects entities to the current chunk
            const queryParts = [];

            // Create entity nodes and connect them to the chunk
            for (const entity of entities) {
                queryParts.push(`
                    MERGE (e:${entity.type} {text: ${JSON.stringify(entity.name)}})
                    WITH c, e
                    MERGE (c)-[:HAS_ENTITY]->(e)
                `);
            }

            // Return all created entities
            queryParts.push('WITH c, collect(e) as entities RETURN entities');

            return queryParts.join('\n');

        } catch (error) {
            console.error('[LLMService] Error generating Cypher query:', error);
            return null;
        }
    }

    async refreshDbSchema() {
        try {
            const session = this.driver.session();
            const schema = {
                nodes: {},
                relationships: new Set()
            };

            try {
                // Get node labels and their properties using CALL db.schema.nodeTypeProperties()
                const nodeResult = await session.run(`
                    CALL db.schema.nodeTypeProperties()
                    YIELD nodeType, propertyName
                    RETURN nodeType, collect(propertyName) as properties
                `);

                for (const record of nodeResult.records) {
                    const nodeType = record.get('nodeType');
                    const properties = record.get('properties');
                    schema.nodes[nodeType] = properties;
                }

                // Get relationship types using MATCH pattern
                const relResult = await session.run(`
                    MATCH ()-[r]->() 
                    RETURN DISTINCT type(r) as relationshipType
                `);

                for (const record of relResult.records) {
                    schema.relationships.add(record.get('relationshipType'));
                }

                // If no relationships found in DB, use default ones
                if (schema.relationships.size === 0) {
                    Object.values(RELATIONSHIPS).forEach(rel => 
                        schema.relationships.add(rel)
                    );
                }

                // If no nodes found in DB, use default ones
                if (Object.keys(schema.nodes).length === 0) {
                    Object.entries(NODE_LABELS).forEach(([_, label]) => {
                        schema.nodes[label] = Object.values(NODE_PROPERTIES);
                    });
                }

                this.dbSchema = schema;
                this.schemaLastUpdated = Date.now();
                return schema;
            } finally {
                await session.close();
            }
        } catch (error) {
            console.error('[LLMService] Error fetching database schema:', error);
            // Fallback to default schema
            const defaultSchema = {
                nodes: {},
                relationships: new Set(Object.values(RELATIONSHIPS))
            };
            
            Object.entries(NODE_LABELS).forEach(([_, label]) => {
                defaultSchema.nodes[label] = Object.values(NODE_PROPERTIES);
            });
            
            this.dbSchema = defaultSchema;
            this.schemaLastUpdated = Date.now();
            return defaultSchema;
        }
    }

    async getDbSchema() {
        // If we have no cached schema or it's expired, refresh it
        if (!this.dbSchema || 
            !this.schemaLastUpdated || 
            Date.now() - this.schemaLastUpdated > this.config.schemaCacheDuration) {
            this.log('Schema cache expired or not present, refreshing...');
            return await this.refreshDbSchema();
        }
        
        this.log('Using cached schema');
        return this.dbSchema;
    }

    // Add a method to force refresh the schema
    async forceRefreshSchema() {
        this.log('Forcing schema refresh');
        return await this.refreshDbSchema();
    }

    async generateDatabaseQuery(question) {
        try {
            // Get actual schema from database
            const schema = await this.getDbSchema();
            
            // Build database structure description
            let dbStructure;
            
            if (schema) {
                // Build from actual schema
                const nodeDescriptions = Object.entries(schema.nodes)
                    .map(([nodeType, properties]) => 
                        `- ${nodeType} nodes with properties: ${properties.join(', ')}`
                    );
                
                const relationshipDescriptions = Array.from(schema.relationships)
                    .map(relType => {
                        return `- Relationships of type [:${relType}] between nodes`;
                    });
                
                dbStructure = [...nodeDescriptions, ...relationshipDescriptions].join('\n');
            } else {
                // Fallback to our constant-based structure
                dbStructure = `
- ${NODE_LABELS.DOCUMENT} nodes with properties: ${NODE_PROPERTIES.ID}, ${NODE_PROPERTIES.FILE_NAME}, ${NODE_PROPERTIES.FILE_TYPE}, ${NODE_PROPERTIES.UPLOAD_DATE}, ${NODE_PROPERTIES.TOTAL_CHUNKS}
- ${NODE_LABELS.DOCUMENT_CHUNK} nodes with properties: ${NODE_PROPERTIES.ID}, ${NODE_PROPERTIES.DOCUMENT_ID}, ${NODE_PROPERTIES.CONTENT}, ${NODE_PROPERTIES.INDEX}
- ${NODE_LABELS.ENTITY} nodes with properties: ${NODE_PROPERTIES.TEXT}, ${NODE_PROPERTIES.TYPE}
- Relationships between ${NODE_LABELS.DOCUMENT}-[:${RELATIONSHIPS.HAS_CHUNK}]->${NODE_LABELS.DOCUMENT_CHUNK}
- Relationships between ${NODE_LABELS.DOCUMENT_CHUNK}-[:${RELATIONSHIPS.HAS_ENTITY}]->${NODE_LABELS.ENTITY}`;
            }

            const prompt = `
Generate a Neo4j Cypher query to find relevant information for the following question.
The database has the following structure:
${dbStructure}

Question: ${question}

Return ONLY a valid Cypher query without any explanation, comments, or code blocks.
Follow these rules strictly:
1. Start with MATCH or OPTIONAL MATCH
2. Always connect nodes with relationships using -> or -[:RELATIONSHIP]->
3. Never place nodes next to each other without a relationship
4. For queries that return document content:
   - Include 'c.content as content' in the RETURN clause
   - Include 'collect(e) as entities' when returning entities
5. For aggregate queries (counts, statistics):
   - Return meaningful field names that describe the data
   - Include relevant grouping and ordering
6. Place WHERE clauses immediately after their MATCH statements
7. Always check parentheses are balanced
8. Always use aliases for all returned fields
9. Never use undefined variables in WHERE clauses
10. Always connect all referenced nodes in the query path`;

            this.log('Requesting database query generation', prompt);
            const response = await this.queryLLM(prompt, 0.2);

            this.log('LLM database query response', response);
            
            if (!response || !response.response) {
                throw new Error('Empty response from LLM');
            }

            // Clean up the query
            const query = response.response
                .replace(/```[a-zA-Z]*\n/g, '')
                .replace(/```/g, '')
                .trim();

            this.log('Generated database query:', query);
            return query;
        } catch (error) {
            console.error('[LLMService] Error generating database query:', error);
            return `
                MATCH (c:${NODE_LABELS.DOCUMENT_CHUNK})
                OPTIONAL MATCH (c)-[:${RELATIONSHIPS.HAS_ENTITY}]->(e:${NODE_LABELS.ENTITY})
                RETURN c.${NODE_PROPERTIES.CONTENT} as content, 
                       collect(e) as entities
                LIMIT 5
            `;
        }
    }
}