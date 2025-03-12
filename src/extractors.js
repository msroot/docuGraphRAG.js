import nlp from 'compromise';

export class InformationExtractor {
    constructor(config = {}) {
        if (!config.driver) {
            throw new Error('Neo4j driver must be provided to InformationExtractor');
        }
        if (!config.llm) {
            throw new Error('LLM service must be provided to InformationExtractor');
        }
        
        this.config = {
            debug: false,
            ...config
        };
        
        this.driver = config.driver;
        this.llm = config.llm;
        this.debug = this.config.debug;
        
        if (this.debug) {
            console.log('[InformationExtractor] Initialized with driver:', this.driver ? 'Driver present' : 'No driver');
        }
    }

    async extractEntities(text) {
        // Get base entities from NLP
        const doc = nlp(text);
        const baseEntities = [];

        // Extract people
        doc.people().forEach(match => {
            baseEntities.push({ text: match.text(), type: 'PERSON' });
        });

        // Extract organizations
        doc.organizations().forEach(match => {
            baseEntities.push({ text: match.text(), type: 'ORGANIZATION' });
        });

        // Extract places
        doc.places().forEach(match => {
            baseEntities.push({ text: match.text(), type: 'LOCATION' });
        });

        // Use LLM to extract additional entities and enrich existing ones
        try {
            const prompt = `Extract and classify entities from the following text. Include additional details when available.
            Entity types: PERSON, ORGANIZATION, LOCATION, PRODUCT, EVENT, TECHNOLOGY
            Format each entity as: { text: "entity name", type: "ENTITY_TYPE", details: { relevant key-value pairs } }

            For example:
            - PERSON: Include role, title, or affiliation
            - ORGANIZATION: Include industry, size, or purpose
            - LOCATION: Include region, country, or type
            - PRODUCT: Include category, features, or company
            - EVENT: Include date, location, or significance
            - TECHNOLOGY: Include field, purpose, or capabilities

            Text: ${text}`;

            const response = await this.llm.chat([
                {
                    role: "system",
                    content: "You are an expert at identifying and classifying entities in text. Extract entities with their context and additional details when available."
                },
                {
                    role: "user",
                    content: prompt
                }
            ]);

            // Parse LLM response
            const llmEntities = this.parseLLMEntities(response);

            // Merge NLP and LLM entities, preferring LLM details when available
            const mergedEntities = this.mergeEntities(baseEntities, llmEntities);
            
            if (this.debug) {
                console.log('[InformationExtractor] Extracted entities:', {
                    nlp: baseEntities.length,
                    llm: llmEntities.length,
                    merged: mergedEntities.length
                });
            }

            return mergedEntities;
        } catch (error) {
            console.warn('Warning: LLM entity extraction failed, using NLP entities only:', error.message);
            return baseEntities;
        }
    }

    parseLLMEntities(llmResponse) {
        try {
            // Remove any markdown formatting
            const cleanResponse = llmResponse.replace(/```json\n|\n```/g, '');
            const entities = JSON.parse(cleanResponse);
            
            // Validate and format entities
            return entities.filter(entity => 
                entity.text && 
                entity.type && 
                typeof entity.text === 'string' && 
                typeof entity.type === 'string'
            ).map(entity => ({
                ...entity,
                type: entity.type.toUpperCase(),
                details: entity.details || {}
            }));
        } catch (error) {
            console.warn('Warning: Error parsing LLM entities:', error.message);
            return [];
        }
    }

    mergeEntities(nlpEntities, llmEntities) {
        const entityMap = new Map();

        // Add NLP entities first
        nlpEntities.forEach(entity => {
            const key = `${entity.text.toLowerCase()}-${entity.type}`;
            entityMap.set(key, entity);
        });

        // Add or update with LLM entities
        llmEntities.forEach(entity => {
            const key = `${entity.text.toLowerCase()}-${entity.type}`;
            if (entityMap.has(key)) {
                // Merge with existing entity, preserving additional details
                entityMap.set(key, {
                    ...entityMap.get(key),
                    ...entity,
                    details: {
                        ...entityMap.get(key).details,
                        ...entity.details
                    }
                });
            } else {
                entityMap.set(key, entity);
            }
        });

        return Array.from(entityMap.values());
    }

    extractKeywords(text) {
        try {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return [];
            }

            const doc = nlp(text);
            const keywords = new Set();

            // Extract nouns and noun phrases (most important)
            doc.nouns().forEach(match => {
                const phrase = match.text().trim().toLowerCase();
                if (phrase && phrase.length > 1) {
                    keywords.add(phrase);
                }
            });

            // Extract technical terms and acronyms
            doc.match('#Acronym|#Technical').forEach(match => {
                const term = match.text().trim().toLowerCase();
                if (term && term.length > 1) {
                    keywords.add(term);
                }
            });

            // Extract important adjectives (especially technical ones)
            doc.adjectives().forEach(match => {
                const word = match.text().trim().toLowerCase();
                if (word && word.length > 1) {
                    keywords.add(word);
                }
            });

            // Extract significant verbs (filtering out common ones)
            doc.verbs()
                .filter(m => !m.has('#Copula')) // Remove being verbs (is, are, etc.)
                .forEach(match => {
                    const word = match.text().trim().toLowerCase();
                    if (word && word.length > 1) {
                        keywords.add(word);
                    }
                });

            return Array.from(keywords);
        } catch (error) {
            console.warn('Warning: Error extracting keywords:', error.message);
            return [];
        }
    }

    async extractConcepts(text) {
        return this.llm.extractConcepts(text);
    }

    async extractRelationships(text) {
        try {
            const prompt = `Extract relationships between entities in the following text. 
            Format: List of {source, relationship, target} where:
            - source: The entity initiating the relationship
            - relationship: The type of connection (use UPPERCASE)
            - target: The entity receiving the relationship

            Text: ${text}`;

            const response = await this.llm.chat([
                {
                    role: "system",
                    content: "You are a relationship extraction expert. Extract only clear, explicit relationships from the text. Use UPPERCASE for relationship types."
                },
                {
                    role: "user",
                    content: prompt
                }
            ]);

            // Parse the response into structured relationships
            const relationships = this.parseRelationships(response);
            return relationships;
        } catch (error) {
            console.warn('Warning: Error extracting relationships:', error.message);
            return [];
        }
    }

    parseRelationships(llmResponse) {
        try {
            // Remove any markdown formatting
            const cleanResponse = llmResponse.replace(/```json\n|\n```/g, '');
            const relationships = JSON.parse(cleanResponse);
            
            // Validate and format relationships
            return relationships.filter(rel => 
                rel.source && 
                rel.relationship && 
                rel.target && 
                typeof rel.source === 'string' && 
                typeof rel.relationship === 'string' && 
                typeof rel.target === 'string'
            );
        } catch (error) {
            console.warn('Warning: Error parsing relationships:', error.message);
            return [];
        }
    }

    async extractAll(text) {
        const [entities, relationships] = await Promise.all([
            this.extractEntities(text),
            this.extractRelationships(text)
        ]);

        return {
            entities: entities,
            keywords: this.extractKeywords(text),
            concepts: await this.extractConcepts(text),
            relationships: relationships
        };
    }
}

// Factory function to create an information extractor instance
export function createExtractor(config = {}) {
    return new InformationExtractor(config);
}

// Utility functions for direct use
export async function extractInformation(text, config = {}) {
    const extractor = createExtractor(config);
    return extractor.extractAll(text);
}

export async function extractEntities(text, config = {}) {
    const extractor = createExtractor(config);
    return extractor.extractEntities(text);
}

export function extractKeywords(text, config = {}) {
    const extractor = createExtractor(config);
    return extractor.extractKeywords(text);
}

export async function extractConcepts(text, config = {}) {
    const extractor = createExtractor(config);
    return extractor.extractConcepts(text);
} 