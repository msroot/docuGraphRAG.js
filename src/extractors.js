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
        const doc = nlp(text);
        const entities = [];

        // Extract people
        doc.people().forEach(match => {
            entities.push({ text: match.text(), type: 'PERSON' });
        });

        // Extract organizations
        doc.organizations().forEach(match => {
            entities.push({ text: match.text(), type: 'ORGANIZATION' });
        });

        // Extract places
        doc.places().forEach(match => {
            entities.push({ text: match.text(), type: 'LOCATION' });
        });

        return entities;
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

    async extractAll(text) {
        return {
            entities: await this.extractEntities(text),
            keywords: this.extractKeywords(text),
            concepts: await this.extractConcepts(text)
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