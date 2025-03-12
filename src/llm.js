import axios from 'axios';

export class LLMService {
    constructor(config = {}) {
        this.config = {
            llmUrl: 'http://localhost:11434',
            llmModel: 'mistral',
            modelVersion: 'v0.3',
            debug: false,
            maxRetries: 3,
            retryDelay: 1000, // 1 second
            timeout: 30000, // 30 seconds
            ...config
        };
        this.debug = this.config.debug;
    }

    formatInstruction(prompt) {
        return `[INST] ${prompt.trim()} [/INST]`;
    }

    log(...args) {
        if (this.debug) {
            console.log(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}]`, ...args);
        }
    }

    async validateLLMServer() {
        try {
            const response = await axios.get(`${this.config.llmUrl}/api/tags`, {
                timeout: 5000
            });
            return response.status === 200;
        } catch (error) {
            this.log('LLM server validation failed:', error.message);
            return false;
        }
    }

    async retryRequest(requestFn, retryCount = 0) {
        try {
            return await requestFn();
        } catch (error) {
            if (error.response?.status === 500 && retryCount < this.config.maxRetries) {
                this.log(`Request failed (attempt ${retryCount + 1}/${this.config.maxRetries}), retrying in ${this.config.retryDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                return this.retryRequest(requestFn, retryCount + 1);
            }
            throw error;
        }
    }

    async makeRequest(endpoint, data, options = {}) {
        const serverAvailable = await this.validateLLMServer();
        if (!serverAvailable) {
            throw new Error('LLM server is not available');
        }

        const requestConfig = {
            timeout: this.config.timeout,
            ...options
        };

        try {
            return await this.retryRequest(async () => {
                // Keep request minimal - just model and prompt
                const requestData = {
                    model: this.config.llmModel,
                    prompt: data.prompt
                };

                // Only add temperature if specified
                if (data.temperature !== undefined) {
                    requestData.temperature = data.temperature;
                }

                // Handle streaming if specified
                if (data.stream) {
                    requestConfig.responseType = 'stream';
                }

                this.log('Making request:', {
                    endpoint,
                    prompt: data.prompt?.substring(0, 100) + '...',
                    stream: !!data.stream
                });

                const response = await axios.post(
                    `${this.config.llmUrl}${endpoint}`,
                    requestData,
                    requestConfig
                );

                // For non-streaming responses, ensure we have a proper response structure
                if (!data.stream && !response.data) {
                    throw new Error('Empty response from LLM server');
                }

                return response;
            });
        } catch (error) {
            // Simplified error logging
            const errorDetails = {
                message: error.message,
                endpoint,
                prompt: data.prompt?.substring(0, 100) + '...'
            };
            
            console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] API request failed:`, 
                JSON.stringify(errorDetails, null, 2));

            throw error;
        }
    }

    async getEmbeddings(text) {
        try {
            this.log('Getting embeddings for text');
            const response = await this.makeRequest('/api/embeddings', {
                prompt: text
            });
            this.log('Embeddings retrieved successfully');
            return response.data.embedding;
        } catch (error) {
            console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Error getting embeddings:`, error);
            throw error;
        }
    }

    async extractConcepts(text) {
        try {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return [];
            }

            const prompt = `Analyze the following text and extract key concepts. Focus on:
1. Main themes and topics
2. Important technical or domain-specific terms
3. Abstract ideas or principles discussed
4. Contextual relationships between concepts

Text: ${text}

Provide your analysis as a comma-separated list of concepts, ensuring each concept:
- Captures a complete idea (can be multiple words if needed)
- Is relevant to the text's domain and context
- Represents a meaningful abstraction or theme

Concepts:`;

            const response = await this.makeRequest('/api/generate', {
                prompt,
                temperature: 0.3,
                max_tokens: 150,
                stream: false,
                format: 'text'
            });

            return this.parseConcepts(response);
        } catch (error) {
            console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Error extracting concepts:`, error);
            return [];
        }
    }

    parseConcepts(response) {
        let conceptText = '';
        
        if (response?.data?.response) {
            conceptText = response.data.response;
        } else if (Array.isArray(response?.data)) {
            conceptText = response.data
                .filter(chunk => chunk?.response)
                .map(chunk => chunk.response)
                .join('');
        } else {
            console.warn('[LLMService] Warning: Unexpected API response structure:', response?.data);
            return [];
        }

        try {
            let concepts = conceptText.split(',')
                .map(concept => concept.trim())
                .filter(concept => concept.length > 0);

            if (concepts.length === 0) {
                concepts = conceptText.split('\n')
                    .map(concept => concept.trim())
                    .filter(concept => concept.length > 0);
            }

            return concepts
                .filter(concept => {
                    const cleaned = concept.replace(/[^a-zA-Z0-9]/g, '');
                    return cleaned.length > 1 && isNaN(cleaned);
                })
                .filter((concept, index, array) => array.indexOf(concept) === index);
        } catch (parseError) {
            console.warn('[LLMService] Warning: Error parsing concepts:', parseError.message);
            const singleConcept = conceptText.trim();
            return singleConcept.length > 0 ? [singleConcept] : [];
        }
    }

    async generateAnswer(question, context) {
        try {
            const prompt = `
Context information is below.
---------------------
${context}
---------------------

Given the context information, answer the following question. If the answer cannot be found in the context, say "I don't have enough information to answer that question."

Question: ${question}
Answer:`;

            this.log('Sending request to LLM API');
            
            // Use Promise to handle streaming response
            return new Promise((resolve, reject) => {
                let fullResponse = '';
                
                this.makeRequest('/api/generate', {
                    prompt,
                    stream: true,
                    format: 'text'
                }, {
                    responseType: 'stream'
                }).then(response => {
                    response.data.on('data', chunk => {
                        try {
                            const data = JSON.parse(chunk.toString());
                            if (data.response) {
                                fullResponse += data.response;
                            }
                        } catch (error) {
                            console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Error parsing stream chunk:`, error);
                        }
                    });

                    response.data.on('end', () => {
                        this.log('Successfully received complete response');
                        resolve(fullResponse);
                    });

                    response.data.on('error', error => {
                        console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Stream error:`, error);
                        reject(error);
                    });
                }).catch(error => {
                    console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Request error:`, error);
                    reject(error);
                });
            });
        } catch (error) {
            console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Error generating answer:`, error);
            throw error;
        }
    }

    async generateStreamingAnswer(question, context, options = {}) {
        try {
            const prompt = `
Context information is below.
---------------------
${context}
---------------------

Given the context information, answer the following question. If the answer cannot be found in the context, say "I don't have enough information to answer that question."

Question: ${question}
Answer:`;

            this.log('Starting streaming response');
            const response = await this.makeRequest('/api/generate', {
                prompt,
                stream: true,
                format: 'text'
            }, {
                responseType: 'stream'
            });

            response.data.on('data', chunk => {
                try {
                    const data = JSON.parse(chunk.toString());
                    if (data.response) {
                        options.onData?.(data.response);
                    }
                    // If this is the last chunk, call onEnd
                    if (data.done && options.onEnd) {
                        options.onEnd();
                    }
                } catch (error) {
                    console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Error parsing stream chunk:`, error);
                    options.onError?.(error);
                }
            });

            response.data.on('error', error => {
                console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Stream error:`, error);
                options.onError?.(error);
            });

        } catch (error) {
            console.error(`[LLMService][${this.config.llmModel} ${this.config.modelVersion}] Error in streaming answer:`, error);
            options.onError?.(error);
        }
    }

    async generateCypherQuery(text) {
        try {
            // For JSON generation, we'll use raw mode without instruction tags
            const prompt = `
You are a JSON generator that analyzes text and identifies entities and relationships.
You must ONLY return a valid JSON object, nothing else - no explanations, no text, no code blocks.

The JSON must follow this exact structure:
{
    "entities": [
        {
            "id": "unique_variable_name",
            "label": "PERSON|ORGANIZATION|LOCATION|TECHNOLOGY|PRODUCT|EVENT",
            "properties": {
                "name": "entity name",
                "type": "optional entity type",
                "role": "optional role"
            }
        }
    ],
    "relationships": [
        {
            "from": "source_entity_id",
            "to": "target_entity_id",
            "type": "RELATIONSHIP_TYPE",
            "properties": {
                "optional_property": "value"
            }
        }
    ]
}

Rules:
1. Entity labels must be one of: PERSON, ORGANIZATION, LOCATION, TECHNOLOGY, PRODUCT, EVENT
2. Entity IDs should be short and descriptive (e.g., p1, org1, loc1)
3. Relationship types must be in UPPERCASE with underscores (e.g., WORKS_AT, LIVES_IN)
4. All properties must be strings
5. Do not include null or empty properties

Analyze this text and return ONLY a JSON object:
${text}`;

            this.log('Requesting entity analysis');
            const response = await this.makeRequest('/api/generate', {
                prompt,
                temperature: 0.1,
                stream: false,
                format: 'json',
                raw: true // Enable raw mode for JSON generation
            });

            if (response?.data?.response) {
                let jsonStr = response.data.response.trim();
                
                // Remove any non-JSON content
                const jsonStart = jsonStr.indexOf('{');
                const jsonEnd = jsonStr.lastIndexOf('}');
                
                if (jsonStart === -1 || jsonEnd === -1) {
                    throw new Error('No JSON object found in response');
                }
                
                jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);

                try {
                    // Parse the JSON response
                    const data = JSON.parse(jsonStr);
                    
                    // Validate the structure
                    if (!data.entities || !Array.isArray(data.entities)) {
                        throw new Error('Missing or invalid entities array');
                    }
                    if (!data.relationships || !Array.isArray(data.relationships)) {
                        throw new Error('Missing or invalid relationships array');
                    }

                    // Validate entity labels
                    const validLabels = ['PERSON', 'ORGANIZATION', 'LOCATION', 'TECHNOLOGY', 'PRODUCT', 'EVENT'];
                    for (const entity of data.entities) {
                        if (!validLabels.includes(entity.label)) {
                            throw new Error(`Invalid entity label: ${entity.label}`);
                        }
                    }

                    // Validate relationships
                    const entityIdSet = new Set(data.entities.map(e => e.id));
                    for (const rel of data.relationships) {
                        if (!entityIdSet.has(rel.from)) {
                            throw new Error(`Invalid relationship: source entity ${rel.from} not found`);
                        }
                        if (!entityIdSet.has(rel.to)) {
                            throw new Error(`Invalid relationship: target entity ${rel.to} not found`);
                        }
                        if (!/^[A-Z][A-Z_]*[A-Z]$/.test(rel.type)) {
                            throw new Error(`Invalid relationship type: ${rel.type}`);
                        }
                    }

                    // Generate Cypher query from the validated data
                    let queryParts = [];

                    // Create entity nodes
                    for (const entity of data.entities) {
                        const properties = Object.entries(entity.properties)
                            .filter(([_, value]) => value !== null && value !== undefined && value !== '')
                            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                            .join(', ');
                        
                        queryParts.push(`MERGE (${entity.id}:${entity.label} {${properties}})`);
                    }

                    // Create relationships
                    for (const rel of data.relationships) {
                        const properties = rel.properties && Object.keys(rel.properties).length > 0
                            ? ` {${Object.entries(rel.properties)
                                .filter(([_, value]) => value !== null && value !== undefined && value !== '')
                                .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                                .join(', ')}}`
                            : '';
                        
                        queryParts.push(`MERGE (${rel.from})-[:${rel.type}${properties}]->(${rel.to})`);
                    }

                    // Add RETURN clause
                    const returnIds = data.entities.map(e => e.id);
                    queryParts.push(`RETURN ${returnIds.join(', ')}`);

                    // Combine all parts
                    const query = queryParts.join('\n');
                    
                    this.log('Generated Cypher query:', query);
                    return query;
                } catch (parseError) {
                    console.error('[LLMService] JSON validation error:', parseError.message);
                    // Return a simple query that creates an error entity
                    return `
                        MERGE (error:ERROR {
                            message: ${JSON.stringify(parseError.message)},
                            text: ${JSON.stringify(text.substring(0, 100) + '...')}
                        })
                        RETURN error
                    `;
                }
            }

            throw new Error('Unexpected API response structure');
        } catch (error) {
            console.error('[LLMService] Error generating Cypher query:', error);
            // Return a simple query that creates an error entity
            return `
                MERGE (error:ERROR {
                    message: ${JSON.stringify(error.message)},
                    text: ${JSON.stringify(text.substring(0, 100) + '...')}
                })
                RETURN error
            `;
        }
    }

    async generateDatabaseQuery(question) {
        try {
            const prompt = `
Generate a Neo4j Cypher query to find relevant information for the following question.
The database has the following structure:
- Document nodes with properties: id, fileName, fileType, uploadDate, totalChunks
- DocumentChunk nodes with properties: id, documentId, content, index
- Entity nodes with properties: text, type, and additional details
- Relationships between Document-[:HAS_CHUNK]->DocumentChunk
- Relationships between DocumentChunk-[:HAS_ENTITY]->Entity

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

            this.log('Requesting database query generation for question:', question);
            const response = await this.makeRequest('/api/generate', {
                prompt,
                temperature: 0.2,
                stream: false
            });

            // Handle Ollama's response format
            let query = '';
            if (response?.data?.response) {
                query = response.data.response.trim();
            } else if (typeof response?.data === 'string') {
                query = response.data.trim();
            } else {
                this.log('Unexpected response format:', response?.data);
                throw new Error('Unexpected API response structure');
            }
                
            // Remove code block markers and clean the query
            query = query
                .replace(/```[a-zA-Z]*\n/g, '')
                .replace(/```/g, '')
                .replace(/`/g, '')
                .replace(/<[^>]*>/g, '')
                .replace(/#.*$/gm, '') // Remove comments
                .trim();

            // Extract only the Cypher query
            const cypherKeywords = ['MATCH', 'CALL', 'CREATE', 'MERGE', 'RETURN', 'WITH'];
            for (const keyword of cypherKeywords) {
                const index = query.indexOf(keyword);
                if (index !== -1) {
                    query = query.substring(index);
                    break;
                }
            }
            
            // Remove any text after the last semicolon
            const semicolonIndex = query.lastIndexOf(';');
            if (semicolonIndex !== -1) {
                query = query.substring(0, semicolonIndex);
            }

            // Clean up whitespace and line breaks
            query = query
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .join('\n');

            // Basic syntax validation
            const validateQuery = (q) => {
                // Check for balanced parentheses
                let count = 0;
                for (const char of q) {
                    if (char === '(') count++;
                    if (char === ')') count--;
                    if (count < 0) return false;
                }
                if (count !== 0) return false;

                // Check for required keywords in correct order
                const hasMatch = /^MATCH|^OPTIONAL\s+MATCH/.test(q);
                const hasReturn = /RETURN/.test(q);
                
                // Check for invalid patterns
                const hasInvalidPattern = /\)\s*\(/.test(q) || // Detect node juxtaposition
                    /\)\)(?!\s*-|\s*{|\s*\]|\s*\)|\s*,|\s*WHERE|\s*RETURN|\s*WITH|\s*ORDER|\s*$)/.test(q);
                
                // Check that nodes are properly connected
                const hasUnconnectedNodes = /\([^)]+\)\s+\([^)]+\)/.test(q);
                
                // Check relationship patterns
                const hasValidRelationships = /\)-\[:?[A-Z_]*\]?->\(/.test(q);

                // Check that all returned fields have aliases
                const returnClause = q.match(/RETURN\s+([^ORDER|^LIMIT|^;]*)/i)?.[1] || '';
                const hasUnaliasedFields = returnClause
                    .split(',')
                    .some(field => !field.includes(' as ') && 
                          !field.trim().match(/^[a-zA-Z][a-zA-Z0-9_]*$/));

                // Check for undefined variables in WHERE clauses
                const whereClause = q.match(/WHERE\s+([^RETURN|^WITH]*)/i)?.[1] || '';
                const variables = q.match(/\(([a-zA-Z][a-zA-Z0-9_]*)\:/g)?.map(v => v.slice(1, -1)) || [];
                const hasUndefinedVars = whereClause !== '' && 
                    whereClause.match(/[a-zA-Z][a-zA-Z0-9_]*\./g)?.some(v => 
                        !variables.includes(v.slice(0, -1))) || false;
                
                return hasMatch && hasReturn && !hasInvalidPattern && !hasUnconnectedNodes && 
                       hasValidRelationships && !hasUnaliasedFields && !hasUndefinedVars;
            };

            if (!validateQuery(query)) {
                this.log('Query validation failed, using fallback query');
                query = `
                    MATCH (c:DocumentChunk)
                    OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e:Entity)
                    WITH c, collect(e) as entities, count(e) as entityCount
                    RETURN c.content as content, 
                           entities,
                           entityCount,
                           size(entities) as totalEntities
                    ORDER BY entityCount DESC
                    LIMIT 5
                `;
            }

            // Ensure consistent field names
            if (query.includes('c.content') && !query.includes('as content')) {
                query = query.replace(/c\.content(?!\s+as\s+content)/, 'c.content as content');
            }
            if (query.includes('collect(') && !query.includes('as entities') && query.includes('Entity')) {
                query = query.replace(/collect\([^)]+\)(?!\s+as\s+\w+)/, match => `${match} as entities`);
            }

            // Log the final query with clear formatting
            console.log('\n[Neo4j Query]', '-'.repeat(50));
            console.log('Question:', question);
            console.log('Generated Query:');
            console.log(query.split('\n').map(line => '  ' + line).join('\n'));
            console.log('-'.repeat(60), '\n');

            return query;
        } catch (error) {
            console.error('[LLMService] Error generating database query:', error);
            const fallbackQuery = `
                MATCH (c:DocumentChunk)
                OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e:Entity)
                WITH c, collect(e) as entities, count(e) as entityCount
                RETURN c.content as content, 
                       entities,
                       entityCount,
                       size(entities) as totalEntities
                ORDER BY entityCount DESC
                LIMIT 5
            `;

            // Log the fallback query
            console.log('\n[Neo4j Query - Fallback]', '-'.repeat(40));
            console.log('Question:', question);
            console.log('Using fallback query due to error:', error.message);
            console.log(fallbackQuery.split('\n').map(line => '  ' + line).join('\n'));
            console.log('-'.repeat(60), '\n');

            return fallbackQuery;
        }
    }
} 