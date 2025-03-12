import axios from 'axios';

export class LLMService {
    constructor(config = {}) {
        this.config = {
            llmUrl: 'http://localhost:11434',
            // llmModel: 'llama2',
            llmModel: 'mistral',
            debug: false,
            ...config
        };
        this.debug = this.config.debug;
    }

    log(...args) {
        if (this.debug) {
            console.log('[LLMService]', ...args);
        }
    }

    async getEmbeddings(text) {
        try {
            this.log('Getting embeddings for text');
            const response = await axios.post(`${this.config.llmUrl}/api/embeddings`, {
                model: this.config.llmModel,
                prompt: text
            });
            this.log('Embeddings retrieved successfully');
            return response.data.embedding;
        } catch (error) {
            console.error('[LLMService] Error getting embeddings:', error);
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

            const response = await axios.post(`${this.config.llmUrl}/api/generate`, {
                model: this.config.llmModel,
                prompt: prompt,
                temperature: 0.3,
                max_tokens: 150,
                stream: false
            });

            return this.parseConcepts(response);
        } catch (error) {
            console.error('[LLMService] Error extracting concepts:', error);
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
                
                axios.post(`${this.config.llmUrl}/api/generate`, {
                    model: this.config.llmModel,
                    prompt: prompt,
                    stream: true
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
                            console.error('[LLMService] Error parsing stream chunk:', error);
                        }
                    });

                    response.data.on('end', () => {
                        this.log('Successfully received complete response');
                        resolve(fullResponse);
                    });

                    response.data.on('error', error => {
                        console.error('[LLMService] Stream error:', error);
                        reject(error);
                    });
                }).catch(error => {
                    console.error('[LLMService] Request error:', error);
                    reject(error);
                });
            });
        } catch (error) {
            console.error('[LLMService] Error generating answer:', error);
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
            const response = await axios.post(`${this.config.llmUrl}/api/generate`, {
                model: this.config.llmModel,
                prompt: prompt,
                stream: true
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
                    console.error('[LLMService] Error parsing stream chunk:', error);
                    options.onError?.(error);
                }
            });

            response.data.on('error', error => {
                console.error('[LLMService] Stream error:', error);
                options.onError?.(error);
            });

        } catch (error) {
            console.error('[LLMService] Error in streaming answer:', error);
            options.onError?.(error);
        }
    }
} 