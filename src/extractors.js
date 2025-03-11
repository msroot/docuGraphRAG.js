import nlp from 'compromise';
import rake from 'node-rake';
import axios from 'axios';

export class InformationExtractor {
    constructor(config = {}) {
        this.config = {
            llmUrl: 'http://localhost:11434',
            llmModel: 'llama3.2',
            ...config
        };
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
            
            // Try node-rake first
            try {
                const keywords = rake.generate(text.trim());
                if (Array.isArray(keywords) && keywords.length > 0) {
                    return keywords;
                }
            } catch (rakeError) {
                console.warn('Warning: node-rake extraction failed, falling back to compromise:', rakeError.message);
            }

            // Fallback to compromise for keyword extraction
            const doc = nlp(text);
            const keywords = [];
            
            // Extract nouns and noun phrases
            doc.nouns().forEach(match => {
                const phrase = match.text().trim();
                if (phrase && phrase.length > 1) {
                    keywords.push(phrase);
                }
            });

            // Extract verbs that might be technical terms
            doc.verbs().forEach(match => {
                const word = match.text().trim();
                if (word && word.length > 1 && !word.match(/^(is|are|was|were|be|been|being|have|has|had)$/)) {
                    keywords.push(word);
                }
            });

            // Extract adjectives that might be domain-specific
            doc.adjectives().forEach(match => {
                const word = match.text().trim();
                if (word && word.length > 1) {
                    keywords.push(word);
                }
            });

            // Remove duplicates and return
            return [...new Set(keywords)];
        } catch (error) {
            console.warn('Warning: Error extracting keywords:', error.message);
            return [];
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

            const response = await axios.post(`${this.config.llmUrl}/api/generate`, {
                model: this.config.llmModel,
                prompt: prompt,
                temperature: 0.3,
                max_tokens: 150,
                stream: false // Explicitly disable streaming
            });

            // Handle different response formats
            let conceptText = '';
            
            if (response?.data?.response) {
                // Standard response format
                conceptText = response.data.response;
            } else if (Array.isArray(response?.data)) {
                // Streaming response format
                conceptText = response.data
                    .filter(chunk => chunk?.response)
                    .map(chunk => chunk.response)
                    .join('');
            } else {
                console.warn('Warning: Unexpected API response structure:', response?.data);
                return [];
            }

            // Parse and clean up concepts
            try {
                // First try splitting by comma
                let concepts = conceptText.split(',')
                    .map(concept => concept.trim())
                    .filter(concept => concept.length > 0);

                if (concepts.length === 0) {
                    // If no concepts found by comma, try splitting by newline
                    concepts = conceptText.split('\n')
                        .map(concept => concept.trim())
                        .filter(concept => concept.length > 0);
                }

                // Clean up concepts
                concepts = concepts
                    // Remove any concepts that are just numbers or single characters
                    .filter(concept => {
                        const cleaned = concept.replace(/[^a-zA-Z0-9]/g, '');
                        return cleaned.length > 1 && isNaN(cleaned);
                    })
                    // Remove duplicates while preserving order
                    .filter((concept, index, array) => array.indexOf(concept) === index);

                return concepts;
            } catch (parseError) {
                console.warn('Warning: Error parsing concepts:', parseError.message);
                // If all parsing fails, try to return the whole response as a single concept
                const singleConcept = conceptText.trim();
                return singleConcept.length > 0 ? [singleConcept] : [];
            }
        } catch (error) {
            console.error('Error extracting concepts:', error);
            return [];
        }
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