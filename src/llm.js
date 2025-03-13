import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LLM_CONFIG = {
    MODEL: 'mistral',
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000,
    TIMEOUT: 30000,
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

// Default schema structure to use if database query fails
const DEFAULT_SCHEMA = {
    nodes: {
        "Document": [
            "documentId",
            "fileName",
            "fileType",
            "uploadDate",
            "totalChunks",
            "content"
        ],
        "DocumentChunk": [
            "documentId",
            "content",
            "index",
            "startChar",
            "endChar"
        ],
        "Entity": [
            "text",
            "type",
            "documentId",
            "startChar",
            "endChar",
            "description",
            "lemma",
            "pos",
            "dep",
            "isRoot",
            "syntacticRole",
            "morphology",
            "confidenceScore"
        ]
    },
    relationships: [
        "HAS_CHUNK",
        "HAS_ENTITY",
        "HAS_KEYWORD",
        "EXPRESSES_CONCEPT",
        "CONTAINS_ENTITY",
        "CONTAINS_KEYWORD",
        "CONTAINS_CONCEPT",
        "MENTIONS",
        "RELATED_TO",
        "PRECEDES",
        "OVERLAPS",
        "CONTAINS"
    ]
};

export class LLMService {
    constructor(config = {}) {
        this.config = {
            model: config.model || LLM_CONFIG.MODEL,
            debug: config.debug ?? LLM_CONFIG.DEBUG,
            maxRetries: config.maxRetries || LLM_CONFIG.MAX_RETRIES,
            retryDelay: config.retryDelay || LLM_CONFIG.RETRY_DELAY,
            timeout: config.timeout || LLM_CONFIG.TIMEOUT
        };

        this.debug = this.config.debug;
        this.driver = config.driver; // Neo4j driver instance
        this.dbSchema = null; // Will be populated during initialization
    }

    async initialize() {
        // Make a single database request to get the schema
        if (this.driver) {
            try {
                this.log('Fetching database schema...');
                const schema = await this.fetchSchemaFromDatabase();
                this.dbSchema = schema;
                this.log('Database schema loaded successfully');
            } catch (error) {
                this.log('Error fetching database schema, using default schema:', error);
                this.dbSchema = this.getDefaultSchema();
            }
        } else {
            this.log('No Neo4j driver provided, using default schema');
            this.dbSchema = this.getDefaultSchema();
        }
        return this;
    }

    getDefaultSchema() {
        return {
            nodes: DEFAULT_SCHEMA.nodes,
            relationships: new Set(DEFAULT_SCHEMA.relationships)
        };
    }

    async fetchSchemaFromDatabase() {
        const session = this.driver.session();
        try {
            // Query to get node labels and their properties
            const nodeResult = await session.run(`
                CALL apoc.meta.schema() YIELD value
                RETURN value
            `);
            
            const nodes = {};
            const relationships = new Set();
            
            if (nodeResult.records.length > 0) {
                const schemaData = nodeResult.records[0].get('value');
                
                // Process nodes and their properties
                for (const [nodeLabel, nodeData] of Object.entries(schemaData)) {
                    if (nodeData.type === 'node') {
                        nodes[nodeLabel] = Object.keys(nodeData.properties);
                    }
                }
                
                // Get relationship types
                const relResult = await session.run(`
                    CALL db.relationshipTypes() YIELD relationshipType
                    RETURN collect(relationshipType) as types
                `);
                
                if (relResult.records.length > 0) {
                    const relTypes = relResult.records[0].get('types');
                    relTypes.forEach(type => relationships.add(type));
                }
            }
            
            return { nodes, relationships };
        } finally {
            await session.close();
        }
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

            let buffer = '';
            
            response.data.on('data', (chunk) => {
                const chunkStr = chunk.toString();
                buffer += chunkStr;
                
                // Process complete JSON objects
                let startIdx = 0;
                let endIdx = buffer.indexOf('\n', startIdx);
                
                while (endIdx !== -1) {
                    const jsonStr = buffer.substring(startIdx, endIdx);
                    startIdx = endIdx + 1;
                    endIdx = buffer.indexOf('\n', startIdx);
                    
                    try {
                        const data = JSON.parse(jsonStr);
                        if (data.response && callbacks.onData) {
                            callbacks.onData(data.response);
                        }
                    } catch (e) {
                        // Skip invalid JSON
                    }
                }
                
                // Keep the remaining incomplete JSON
                buffer = buffer.substring(startIdx);
            });
            
            response.data.on('end', () => {
                if (callbacks.onEnd) {
                    callbacks.onEnd();
                }
            });
            
            response.data.on('error', (error) => {
                if (callbacks.onError) {
                    callbacks.onError(error);
                }
            });
            
        } catch (error) {
            if (callbacks.onError) {
                callbacks.onError(error);
            } else {
                throw error;
            }
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

            if (!response) {
                return null;
            }

            // Split response into lines and process each line
            const lines = response.split('\n')
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

    async generateDatabaseQuery(question) {
        try {
            // Ensure schema is initialized
            if (!this.dbSchema) {
                await this.initialize();
            }
            
            // Build database structure description from the schema
            const nodeDescriptions = Object.entries(this.dbSchema.nodes)
                .map(([nodeType, properties]) => 
                    `- ${nodeType} nodes with properties: ${properties.join(', ')}`
                );
            
            const relationshipDescriptions = Array.from(this.dbSchema.relationships)
                .map(relType => `- Relationships of type [:${relType}] between nodes`);
            
            const dbStructure = [...nodeDescriptions, ...relationshipDescriptions].join('\n');

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

            this.log('Requesting database query generation');
            const response = await this.queryLLM(prompt, 0.2);

            this.log('LLM database query response received');
            
            if (!response) {
                throw new Error('Empty response from LLM');
            }

            // Clean up the query
            const query = response
                .replace(/```[a-zA-Z]*\n/g, '')
                .replace(/```/g, '')
                .trim();

            this.log('Generated database query:', query);
            return query;
        } catch (error) {
            console.error('[LLMService] Error generating database query:', error);
            return `
                MATCH (c:DocumentChunk)
                OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e:Entity)
                RETURN c.content as content, 
                       collect(e) as entities
                LIMIT 5
            `;
        }
    }
}