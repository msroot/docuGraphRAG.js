import axios from 'axios';
import neo4j from 'neo4j-driver';
import { Processor as DocumentProcessor } from './processor.js';
import { LLMService } from './llm.js';
import { DatabaseSeeder } from './seed.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the root directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Add debug logging for environment variables


// Constants for Neo4j relationships and entity types
const RELATIONSHIPS = {
    HAS_CHUNK: 'HAS_CHUNK',
    HAS_ENTITY: 'HAS_ENTITY',
    HAS_KEYWORD: 'HAS_KEYWORD',
    MENTIONS: 'MENTIONS',
    RELATED_TO: 'RELATED_TO'
};

const NODE_LABELS = {
    DOCUMENT: 'Document',
    DOCUMENT_CHUNK: 'DocumentChunk',
    ENTITY: 'Entity'
};

const ENTITY_TYPES = {
    PERSON: 'PERSON',      // People, including fictional
    ORG: 'ORG',           // Companies, agencies, institutions
    GPE: 'GPE',           // Countries, cities, states
    LOC: 'LOC',           // Non-GPE locations, mountain ranges, water bodies
    PRODUCT: 'PRODUCT',    // Products, objects, vehicles, foods, etc.
    EVENT: 'EVENT',       // Named hurricanes, battles, wars, sports events
    WORK_OF_ART: 'WORK_OF_ART', // Titles of books, songs, etc.
    LAW: 'LAW',           // Named documents made into laws
    LANGUAGE: 'LANGUAGE',  // Any named language
    DATE: 'DATE',         // Absolute or relative dates or periods
    TIME: 'TIME',         // Times smaller than a day
    PERCENT: 'PERCENT',   // Percentage
    MONEY: 'MONEY',       // Monetary values, including unit
    QUANTITY: 'QUANTITY', // Measurements, as of weight or distance
    ORDINAL: 'ORDINAL',   // "first", "second", etc.
    CARDINAL: 'CARDINAL', // Numerals that don't fall under another type
    NORP: 'NORP',        // Nationalities or religious or political groups
    FAC: 'FAC',          // Buildings, airports, highways, bridges, etc.
    KEYWORD: 'KEYWORD'    // Fallback for unrecognized types
};

const NODE_PROPERTIES = {
    DOCUMENT_ID: 'documentId',
    FILE_NAME: 'fileName',
    FILE_TYPE: 'fileType',
    UPLOAD_DATE: 'uploadDate',
    TOTAL_CHUNKS: 'totalChunks',
    CONTENT: 'content',
    INDEX: 'index',
    TEXT: 'text',
    TYPE: 'type',
    START_CHAR: 'startChar',
    END_CHAR: 'endChar',
    UNIQUE_ID: 'uniqueId',
    LEMMA: 'lemma',
    POS: 'pos',
    DEP: 'dep',
    IS_ROOT: 'isRoot',
    SYNTACTIC_ROLE: 'syntacticRole',
    MORPHOLOGY: 'morphology',
    CONFIDENCE_SCORE: 'confidenceScore'
};



export class DocuGraphRAG {
    constructor(config = {}) {

        this.config = {
            neo4jUrl: 'bolt://localhost:7687',
            neo4jUser: 'neo4j',
            neo4jPassword: 'password',
            spacyApiUrl: 'http://localhost:8080',
            ollamaApiUrl: 'http://localhost:11434/api/generate',
            chunkSize: 1000,
            chunkOverlap: 200,
            searchLimit: 3,
            debug: false,
            ...config,
        };

        this.debug = this.config.debug;
        this.initialized = false;
        this.driver = null;
        this.processor = null;
        this.llm = null;

        // Make constants available as class properties
        this.RELATIONSHIPS = RELATIONSHIPS;
        this.NODE_LABELS = NODE_LABELS;
        this.ENTITY_TYPES = ENTITY_TYPES;
        this.NODE_PROPERTIES = NODE_PROPERTIES;
    }

    log(step, methodName, message, context = {}) {
        if (this.debug) {
            const className = this.constructor.name;

            // Format the log message
            console.log(
                `[Step: ${step}][${className}][${methodName}]: ${message}`,
                // Only include non-standard context
                Object.entries(context).length > 0 ? context : ''
            );
        }
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

            // Initialize document processor
            this.processor = new DocumentProcessor({
                debug: this.debug
            });

            // Initialize LLM service
            this.llm = new LLMService({
                driver: this.driver,
                debug: this.debug,
                apiUrl: this.config.ollamaApiUrl,
                model: 'mistral:7b'
            });

            // Initialize the LLM service to fetch the schema once
            await this.llm.initialize();

            // Initialize database with constraints and indexes
            const session = this.driver.session();
            try {
                const seeder = new DatabaseSeeder(NODE_LABELS, RELATIONSHIPS, ENTITY_TYPES, NODE_PROPERTIES);
                await seeder.seed(session);
            } finally {
                await session.close();
            }

            this.initialized = true;
        } catch (error) {
            console.error('Failed to initialize DocuGraphRAG:', error);
            throw error;
        }
    }

    async validateCypherQuery(cypherQuery) {
        console.log("cypherQuery:", cypherQuery)
        // Split the query into CREATE and MERGE parts
        const [createPart, ...mergeParts] = cypherQuery.split(/MERGE\s+/);

        if (!createPart) return null;

        // Process CREATE statements
        let validCreateStatements = [];
        const createNodes = createPart.replace(/CREATE\s+/, '').split(',');

        for (const node of createNodes) {
            // Validate node has Entity label and proper structure
            if (node.includes(':Entity')) {
                // Extract and validate properties
                const propertyMatch = node.match(/\{([^}]+)\}/);
                if (propertyMatch) {
                    try {
                        // Convert property string to valid JSON format
                        const propertyStr = propertyMatch[1]
                            .replace(/(\w+):/g, '"$1":')  // Add quotes to property names
                            .replace(/'/g, '"')           // Replace single quotes with double quotes
                            .replace(/\s*,\s*/g, ',')     // Clean up spaces around commas
                            .trim();

                        // Validate JSON structure
                        const properties = JSON.parse(`{${propertyStr}}`);

                        // Reconstruct node with validated properties
                        const nodeAlias = node.match(/\(([^:]+):/)?.[1] || 'n' + validCreateStatements.length;
                        const validNode = `(${nodeAlias}:Entity ${JSON.stringify(properties)})`;
                        validCreateStatements.push(validNode);
                    } catch (error) {
                        if (this.debug) {
                            console.error('Error parsing node properties:', error);
                        }
                        continue;
                    }
                }
            }
        }

        if (validCreateStatements.length === 0) return null;

        // Process MERGE statements for relationships
        let validMergeStatements = [];

        for (const mergePart of mergeParts) {
            const relationshipMatch = mergePart.match(/\((.*?)\)-\[:([^\]]+)\]->\((.*?)\)/);
            if (relationshipMatch) {
                const [_, fromNode, relType, toNode] = relationshipMatch;
                if (Object.values(this.RELATIONSHIPS).includes(relType)) {
                    validMergeStatements.push(`MERGE (${fromNode})-[:${relType}]->(${toNode})`);
                }
            }
        }

        // Construct the final validated query
        let validatedQuery = `CREATE ${validCreateStatements.join(',\n')}`;
        if (validMergeStatements.length > 0) {
            validatedQuery += '\n' + validMergeStatements.join('\n');
        }

        return validatedQuery;
    }

    async processLLMResponse(response) {
        if (!response || !response.response) {
            return [];
        }

        // Extract the Cypher query from the response
        let cypherQuery = response.response;

        // Remove markdown code blocks if present
        cypherQuery = cypherQuery.replace(/```cypher\n/g, '').replace(/```/g, '');

        // Validate the query
        const validatedQuery = await this.validateCypherQuery(cypherQuery);
        if (!validatedQuery) {
            return [];
        }

        // Execute the validated query
        const session = this.driver.session();
        try {
            const result = await session.run(validatedQuery);
            return result.records;
        } catch (error) {
            // If there's an error, log it but don't throw
            if (this.debug) {
                console.error('Error executing query:', error);
            }
            return [];
        } finally {
            await session.close();
        }
    }

    async processDocument(buffer, fileName) {
        try {
            this.log('1', 'processDocument', 'Starting document processing');
            const { metadata, chunks } = await this.processor.processDocument(buffer, fileName);
            this.log('2', 'processDocument', 'Document processed into chunks', {
                documentId: metadata.documentId,
                totalChunks: chunks.length
            });

            const session = this.driver.session();
            try {
                // First, create the document node
                await session.executeWrite(async tx => {
                    await tx.run(`
                        CREATE (d:${this.NODE_LABELS.DOCUMENT} {
                            ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                            ${this.NODE_PROPERTIES.FILE_NAME}: $fileName,
                            ${this.NODE_PROPERTIES.FILE_TYPE}: $fileType,
                            ${this.NODE_PROPERTIES.UPLOAD_DATE}: datetime($uploadDate),
                            ${this.NODE_PROPERTIES.TOTAL_CHUNKS}: $totalChunks,
                            ${this.NODE_PROPERTIES.CONTENT}: $content
                        })
                    `, {
                        ...metadata,
                        content: chunks.map(c => c.text).join('\n')
                    });
                    this.log('3', 'processDocument', 'Document node created', {
                        documentId: metadata.documentId
                    });
                });

                // Then, process each chunk in its own transaction
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    this.log('4', 'processDocument', `Processing chunk ${i + 1}/${chunks.length}`, {
                        chunkIndex: i,
                        documentId: metadata.documentId
                    });

                    // Create chunk node in its own transaction
                    await session.executeWrite(async tx => {
                        await tx.run(`
                            MATCH (d:${this.NODE_LABELS.DOCUMENT} {${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId})
                            CREATE (c:${this.NODE_LABELS.DOCUMENT_CHUNK} {                                
                                ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                                ${this.NODE_PROPERTIES.CONTENT}: $content,
                                ${this.NODE_PROPERTIES.INDEX}: $index,
                                ${this.NODE_PROPERTIES.START_CHAR}: $startChar,
                                ${this.NODE_PROPERTIES.END_CHAR}: $endChar
                            })
                            CREATE (d)-[:${this.RELATIONSHIPS.HAS_CHUNK}]->(c)
                            RETURN c
                        `, {
                            documentId: metadata.documentId,
                            content: chunk.text,
                            index: chunk.chunkIndex,
                            startChar: chunk.startChar || 0,
                            endChar: chunk.endChar || chunk.text.length
                        });

                        this.log('5', 'processDocument', 'Chunk node created', {
                            chunkIndex: i,
                            documentId: metadata.documentId
                        });
                    });

                    // Extract entities after chunk is created
                    try {
                        this.log('6', 'processDocument', 'Starting entity extraction', {
                            chunkIndex: i,
                            documentId: metadata.documentId
                        });

                        const entityResult = await this.extractEntities(chunk.text, chunk.chunkIndex, metadata.documentId);

                        this.log('7', 'processDocument', 'Entity extraction completed', {
                            ...entityResult,
                            chunkIndex: i,
                            documentId: metadata.documentId
                        });
                    } catch (error) {
                        this.log('ERROR', 'processDocument', 'Error in chunk processing', {
                            error: error.message,
                            chunkIndex: i,
                            documentId: metadata.documentId
                        });
                        throw error;
                    }
                }
            } finally {
                await session.close();
            }

            this.log('9', 'processDocument', 'Document processing completed', {
                documentId: metadata.documentId
            });
            return { documentId: metadata.documentId };
        } catch (error) {
            this.log('ERROR', 'processDocument', 'Error in document processing', {
                error: error.message
            });
            throw error;
        }
    }

    async chat(question, options = {}) {
        try {
            const dbQuery = await this.llm.generateDatabaseQuery(question);
            const session = this.driver.session();
            try {
                const result = await session.run(dbQuery);
                let contextParts = [];

                result.records.forEach((record) => {
                    const keys = record.keys;
                    const content = record.get('content') || record.get('c.content');
                    if (content) {
                        contextParts.push(content);
                    }

                    const entities = record.get('entities');
                    if (entities && Array.isArray(entities) && entities.length > 0) {
                        const entityContext = entities
                            .map(e => `${e.type}: ${e.text}${e.details ? ` (${JSON.stringify(e.details)})` : ''}`)
                            .join('\n');
                        if (entityContext) {
                            contextParts.push(`Related entities:\n${entityContext}`);
                        }
                    }

                    keys.forEach(key => {
                        if (key !== 'content' && key !== 'entities') {
                            const value = record.get(key);
                            if (value !== null && value !== undefined) {
                                if (Array.isArray(value)) {
                                    contextParts.push(`${key}:\n${value.join('\n')}`);
                                } else if (typeof value === 'object') {
                                    contextParts.push(`${key}: ${JSON.stringify(value, null, 2)}`);
                                } else {
                                    contextParts.push(`${key}: ${value}`);
                                }
                            }
                        }
                    });
                });

                const context = contextParts.join('\n\n');

                if (options.onData) {
                    await this.llm.generateStreamingAnswer(question, context, {
                        onData: (data) => {
                            options.onData({ answer: data, done: false });
                        },
                        onEnd: () => {
                            options.onData({ done: true });
                        },
                        onError: (error) => {
                            options.onData({ error: error.message, done: true });
                        }
                    });
                    return null;
                } else {
                    const answer = await this.llm.generateAnswer(question, context);
                    return {
                        answer,
                        context
                    };
                }
            } finally {
                await session.close();
            }
        } catch (error) {
            throw error;
        }
    }

    async extractEntities(text, chunkId, documentId) {
        try {
            // Validate input parameters
            if (typeof chunkId !== 'number' || chunkId < 0) {
                throw new Error(`Invalid chunkId: ${chunkId}`);
            }
            if (!documentId) {
                throw new Error('documentId is required for entity extraction');
            }

            this.log('1', 'extractEntities', 'Starting entity extraction', {
                chunkId,
                documentId,
                textLength: text?.length || 0
            });

            this.log('2', 'extractEntities', 'Calling SpaCy API', {
                chunkId
            });
            const response = await axios.post('http://localhost:8080/ent', {
                text: text,
                model: "en",
                features: ["ents", "dep", "relations", "syntax", "tokens"]
            });

            this.log('3', 'extractEntities', 'SpaCy API response received', {
                chunkId,
                entitiesFound: response.data?.length || 0,
                entities: response.data?.map(ent => ({
                    text: ent.text,
                    type: ent.label || ent.type || 'KEYWORD',
                    start: ent.start,
                    end: ent.end
                })) || []
            });

            if (!response.data || !response.data.length) {
                this.log('4', 'extractEntities', 'No entities found in text');
                return { response: '' };
            }

            this.log('5', 'extractEntities', 'Mapping SpaCy entities');
            const entities = response.data
                .map(ent => ({
                    text: ent.text,
                    type: ent.label || ent.type || 'KEYWORD',
                    start: ent.start,
                    end: ent.end,
                    description: ent.description || '',
                    lemma: ent.lemma || ent.text,
                    pos: ent.pos || '',
                    dep: ent.dep || '',
                    isRoot: ent.is_root || false,
                    head: ent.head || null,
                    children: ent.children || [],
                    ancestors: ent.ancestors || [],
                    syntacticRole: ent.syntactic_role || '',
                    morphology: ent.morph || {}
                }))
                .filter(ent => ent.text && ent.type);

            this.log('6', 'extractEntities', 'Entities mapped', {
                totalEntities: entities.length,
                entityTypes: [...new Set(entities.map(e => e.type))]
            });

            if (!entities.length) {
                this.log('7', 'extractEntities', 'No valid entities after mapping', {
                    chunkId
                });
                return { response: '' };
            }

            // Generate Cypher query using MERGE for unique entities
            this.log('8', 'extractEntities', 'Generating Cypher statements', {
                chunkId
            });
            const createStatements = entities.map((entity, index) =>
                `CREATE (e${index}:${this.NODE_LABELS.ENTITY}:${entity.type} {
                    ${this.NODE_PROPERTIES.TEXT}: '${entity.text.replace(/'/g, "\\'")}',
                    ${this.NODE_PROPERTIES.TYPE}: '${entity.type}',
                    ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                    ${this.NODE_PROPERTIES.START_CHAR}: ${entity.start},
                    ${this.NODE_PROPERTIES.END_CHAR}: ${entity.end},
                    ${this.NODE_PROPERTIES.LEMMA}: '${(entity.lemma || '').replace(/'/g, "\\'")}',
                    ${this.NODE_PROPERTIES.POS}: '${entity.pos}',
                    ${this.NODE_PROPERTIES.DEP}: '${entity.dep}',
                    ${this.NODE_PROPERTIES.IS_ROOT}: ${entity.isRoot},
                    ${this.NODE_PROPERTIES.SYNTACTIC_ROLE}: '${entity.syntacticRole}',
                    ${this.NODE_PROPERTIES.MORPHOLOGY}: '${JSON.stringify(entity.morphology).replace(/'/g, "\\'")}',
                    ${this.NODE_PROPERTIES.CONFIDENCE_SCORE}: ${entity.confidence || 1.0}
                })`
            );
            this.log('9', 'extractEntities', 'Entity creation statements generated');

            // Create relationships between entities
            this.log('10', 'extractEntities', 'Generating relationship statements');
            const relationshipStatements = [];

            // Process SpaCy relations
            if (response.data.relations) {
                this.log('10.1', 'extractEntities', 'Processing SpaCy relations');
                response.data.relations.forEach((rel, idx) => {
                    const sourceIdx = entities.findIndex(e => e.start === rel.source.start && e.end === rel.source.end);
                    const targetIdx = entities.findIndex(e => e.start === rel.target.start && e.end === rel.target.end);

                    if (sourceIdx !== -1 && targetIdx !== -1) {
                        relationshipStatements.push(
                            `CREATE (e${sourceIdx})-[:${rel.type.toUpperCase()} {
                                ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                                ${this.NODE_PROPERTIES.CONFIDENCE_SCORE}: ${rel.confidence || 1.0},
                                ${this.NODE_PROPERTIES.START_CHAR}: ${rel.start || Math.min(entities[sourceIdx].start, entities[targetIdx].start)},
                                ${this.NODE_PROPERTIES.END_CHAR}: ${rel.end || Math.max(entities[sourceIdx].end, entities[targetIdx].end)}
                            }]->(e${targetIdx})`
                        );
                    }
                });
            }

            // Add syntactic and positional relationships
            this.log('10.2', 'extractEntities', 'Processing syntactic and positional relationships');
            for (let i = 0; i < entities.length; i++) {
                const entity = entities[i];

                // Dependency relations
                if (entity.dep) {
                    const headIdx = entities.findIndex(e => e.start === entity.head?.start && e.end === entity.head?.end);
                    if (headIdx !== -1) {
                        relationshipStatements.push(
                            `CREATE (e${i})-[:${entity.dep.toUpperCase()} {
                                ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                                ${this.NODE_PROPERTIES.CONFIDENCE_SCORE}: 1.0,
                                ${this.NODE_PROPERTIES.START_CHAR}: ${Math.min(entity.start, entities[headIdx].start)},
                                ${this.NODE_PROPERTIES.END_CHAR}: ${Math.max(entity.end, entities[headIdx].end)}
                            }]->(e${headIdx})`
                        );
                    }
                }

                // Positional relationships
                for (let j = 0; j < entities.length; j++) {
                    if (i !== j) {
                        if (entities[i].end === entities[j].start - 1) {
                            relationshipStatements.push(
                                `CREATE (e${i})-[:PRECEDES {
                                    ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                                    ${this.NODE_PROPERTIES.CONFIDENCE_SCORE}: 1.0,
                                    ${this.NODE_PROPERTIES.START_CHAR}: ${entities[i].start},
                                    ${this.NODE_PROPERTIES.END_CHAR}: ${entities[j].end}
                                }]->(e${j})`
                            );
                        }
                        if (entities[i].end >= entities[j].start && entities[i].start <= entities[j].end) {
                            relationshipStatements.push(
                                `CREATE (e${i})-[:OVERLAPS {
                                    ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                                    ${this.NODE_PROPERTIES.CONFIDENCE_SCORE}: 1.0,
                                    ${this.NODE_PROPERTIES.START_CHAR}: ${Math.min(entities[i].start, entities[j].start)},
                                    ${this.NODE_PROPERTIES.END_CHAR}: ${Math.max(entities[i].end, entities[j].end)}
                                }]->(e${j})`
                            );
                        }
                        if (entities[i].start <= entities[j].start && entities[i].end >= entities[j].end) {
                            relationshipStatements.push(
                                `CREATE (e${i})-[:CONTAINS {
                                    ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId,
                                    ${this.NODE_PROPERTIES.CONFIDENCE_SCORE}: 1.0,
                                    ${this.NODE_PROPERTIES.START_CHAR}: ${entities[i].start},
                                    ${this.NODE_PROPERTIES.END_CHAR}: ${entities[i].end}
                                }]->(e${j})`
                            );
                        }
                    }
                }
            }
            this.log('11', 'extractEntities', 'All relationship statements generated', {
                totalRelationships: relationshipStatements.length
            });

            // Match the chunk and create relationships to entities
            this.log('12', 'extractEntities', 'Building final Cypher query');
            const cypherQuery = `
                MATCH (c:${this.NODE_LABELS.DOCUMENT_CHUNK} {
                    ${this.NODE_PROPERTIES.INDEX}: $chunkId,
                    ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId
                })
                // Create entities with document scope
                ${createStatements.join('\n')}
                
                // Link entities to their chunk with document scope
                ${entities.map((_, index) =>
                `CREATE (c)-[:${this.RELATIONSHIPS.HAS_ENTITY} {
                        ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId
                    }]->(e${index})`
            ).join('\n')}
                
                // Create relationships between entities within document scope
                ${relationshipStatements.join('\n')}
                
                RETURN count(DISTINCT e0) as entityCount, count(*) as relationshipCount
            `;

            this.log('13', 'extractEntities', 'Final query built', {
                chunkId,
                createStatementsCount: createStatements.length,
                relationshipStatementsCount: relationshipStatements.length,
                query: cypherQuery
            });

            // Before executing the query, verify the chunk exists
            const session = this.driver.session();
            try {
                const verifyChunk = await session.run(
                    `MATCH (c:${this.NODE_LABELS.DOCUMENT_CHUNK} {
                        ${this.NODE_PROPERTIES.INDEX}: $chunkId,
                        ${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId
                    }) 
                     RETURN c`,
                    { chunkId, documentId }
                );

                if (!verifyChunk.records.length) {
                    throw new Error(`No chunk found with index ${chunkId}`);
                }

                this.log('13.5', 'extractEntities', 'Verified chunk exists', {
                    chunkId,
                    chunkFound: true
                });

                const result = await session.run(cypherQuery, { chunkId, documentId });
                const stats = result.records[0];
                this.log('15', 'extractEntities', 'Query executed successfully', {
                    chunkId,
                    entityCount: stats.get('entityCount'),
                    relationshipCount: stats.get('relationshipCount')
                });
                return {
                    success: true,
                    entitiesCount: stats.get('entityCount'),
                    relationshipsCount: stats.get('relationshipCount')
                };
            } finally {
                await session.close();
            }
        } catch (error) {
            this.log('ERROR', 'extractEntities', 'Error in entity extraction', {
                error: error.message,
                chunkId,
                response: error.response?.data,
                query: error.query
            });
            if (this.debug) {
                console.error('Entity Extraction Error:', error.response?.data || error.message);
                console.error('Failed query:', error.query || 'No query available');
            }
            throw new Error(`Failed to extract and save entities for chunk ${chunkId}: ${error.message}`);
        }
    }

    async verifyEntityProperties(documentId) {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (d:${this.NODE_LABELS.DOCUMENT} {${this.NODE_PROPERTIES.DOCUMENT_ID}: $documentId})
                MATCH (c:${this.NODE_LABELS.DOCUMENT_CHUNK})-[:${this.RELATIONSHIPS.HAS_CHUNK}]-(d)
                MATCH (e)-[:${this.RELATIONSHIPS.HAS_ENTITY}]-(c)
                RETURN 
                    e.${this.NODE_PROPERTIES.TEXT} as text,
                    e.${this.NODE_PROPERTIES.TYPE} as type,
                    e.${this.NODE_PROPERTIES.START_CHAR} as startChar,
                    e.${this.NODE_PROPERTIES.END_CHAR} as endChar,
                    e.${this.NODE_PROPERTIES.UNIQUE_ID} as uniqueId,
                    labels(e) as labels,
                    c.${this.NODE_PROPERTIES.INDEX} as chunkIndex
            `, { documentId });

            return result.records.map(record => ({
                text: record.get('text'),
                type: record.get('type'),
                startChar: record.get('startChar').toNumber(),
                endChar: record.get('endChar').toNumber(),
                uniqueId: record.get('uniqueId'),
                labels: record.get('labels'),
                chunkIndex: record.get('chunkIndex').toNumber()
            }));
        } finally {
            await session.close();
        }
    }

    async cleanup() {
        this.log('1', 'cleanup', 'Starting cleanup process');

        try {
            // Delete all document-related data from the database
            if (this.driver) {
                const session = this.driver.session();
                try {
                    this.log('2', 'cleanup', 'Deleting all document data from Neo4j');

                    // Use a single transaction to delete all document-related data
                    await session.executeWrite(async tx => {
                        // Delete all entity relationships first
                        await tx.run(`
                            MATCH ()-[r]->() 
                            WHERE type(r) IN ['${Object.values(this.RELATIONSHIPS).join("','")}']
                            DELETE r
                        `);

                        // Delete all nodes in one query
                        await tx.run(`
                            MATCH (n)
                            WHERE n:${this.NODE_LABELS.ENTITY} OR 
                                  n:${this.NODE_LABELS.DOCUMENT_CHUNK} OR 
                                  n:${this.NODE_LABELS.DOCUMENT}
                            DELETE n
                        `);
                    });

                    this.log('3', 'cleanup', 'Successfully deleted all document data');
                } catch (dbError) {
                    this.log('ERROR', 'cleanup', 'Error deleting document data', { error: dbError.message });
                    throw dbError;
                } finally {
                    await session.close();
                }

                // Close Neo4j driver
                this.log('4', 'cleanup', 'Closing Neo4j driver');
                await this.driver.close();
                this.driver = null;
            }

            // Reset state
            this.initialized = false;
            this.processor = null;
            this.llm = null;

            this.log('5', 'cleanup', 'Cleanup completed successfully');
            return true;
        } catch (error) {
            this.log('ERROR', 'cleanup', 'Error during cleanup', { error: error.message });
            throw error;
        }
    }
}