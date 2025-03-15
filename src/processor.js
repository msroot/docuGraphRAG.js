import pdfParse from 'pdf-parse';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { Document } from 'langchain/document';

export class Processor {
    constructor(config = {}) {
        this.config = {
            chunkSize: 1000,
            chunkOverlap: 200,
            debug: false,
            ...config
        };

        this.debug = this.config.debug;

        this.textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.config.chunkSize,
            chunkOverlap: this.config.chunkOverlap
        });
    }

    log(...args) {
        if (this.debug) {
            console.log('[Processor]', ...args);
        }
    }

    async extractTextFromPDF(pdfBuffer) {
        try {
            this.log('Starting PDF text extraction');
            const data = await pdfParse(pdfBuffer);
            this.log(`PDF text extraction complete. Extracted ${data.text.length} characters`);
            return data.text;
        } catch (error) {
            console.error('[Processor] Error extracting text from PDF:', error);
            throw new Error('Failed to extract text from PDF');
        }
    }

    async processDocument(buffer, fileName) {
        try {
            this.log(`Starting document processing for file: ${fileName}`);
            if (!fileName.toLowerCase().endsWith('.pdf')) {
                throw new Error('Only PDF files are supported');
            }

            const text = await this.extractTextFromPDF(buffer);

            // Create a LangChain Document with basic metadata
            const doc = new Document({
                pageContent: text,
                metadata: {
                    source: fileName,
                    type: 'pdf',
                    created: new Date().toISOString()
                }
            });

            // Use LangChain's built-in document splitting
            const docs = await this.textSplitter.splitDocuments([doc]);

            // Simplify chunks to avoid nested objects
            const simplifiedChunks = docs.map(doc => ({
                pageContent: doc.pageContent,
                source: doc.metadata.source,
                type: doc.metadata.type,
                created: doc.metadata.created
            }));

            return {
                metadata: {
                    fileName,
                    fileType: 'pdf',
                    uploadDate: new Date().toISOString(),
                    totalChunks: simplifiedChunks.length
                },
                chunks: simplifiedChunks
            };
        } catch (error) {
            console.error('[Processor] Error processing document:', error);
            throw error;
        }
    }
} 