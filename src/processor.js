import pdfParse from 'pdf-parse';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { Document } from 'langchain/document';

export class Processor {
    constructor(config = {}) {
        this.config = {
            chunkSize: 1000,
            chunkOverlap: 200,
            debug: true,
            ...config
        };

        this.debug = this.config.debug;

        this.textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.config.chunkSize,
            chunkOverlap: this.config.chunkOverlap
        });
    }

    log(step, action, message, data = {}) {
        if (this.debug) {
            const timestamp = new Date().toISOString();
            console.log(JSON.stringify({
                timestamp,
                step: `STEP ${step}`,
                service: 'DocumentProcessor',
                action,
                message,
                ...data
            }, null, 2));
        }
    }

    async extractTextFromPDF(pdfBuffer) {
        try {
            this.log('9', 'extractTextFromPDF', 'Starting PDF text extraction');
            const data = await pdfParse(pdfBuffer);
            this.log('9.1', 'extractTextFromPDF', 'PDF text extraction completed', {
                pageCount: data.numpages,
                textLength: data.text.length
            });
            return data.text;
        } catch (error) {
            this.log('ERROR', 'extractTextFromPDF', 'Error extracting text from PDF', {
                error: error.message
            });
            throw error;
        }
    }

    async processDocument(buffer, fileName) {
        try {
            this.log('8', 'processDocument', 'Starting document processing', {
                fileName
            });

            if (!fileName.toLowerCase().endsWith('.pdf')) {
                throw new Error('Only PDF files are supported');
            }

            this.log('8.1', 'processDocument', 'Extracting text from PDF');
            const text = await this.extractTextFromPDF(buffer);
            this.log('8.2', 'processDocument', 'Text extraction completed', {
                textLength: text.length
            });

            const doc = new Document({
                pageContent: text,
                metadata: {
                    source: fileName,
                    type: 'pdf',
                    created: new Date().toISOString()
                }
            });

            this.log('8.3', 'processDocument', 'Splitting document into chunks');
            const docs = await this.textSplitter.splitDocuments([doc]);
            this.log('8.4', 'processDocument', 'Document splitting completed', {
                chunkCount: docs.length
            });

            const simplifiedChunks = docs.map(doc => ({
                pageContent: doc.pageContent,
                source: doc.metadata.source,
                type: doc.metadata.type,
                created: doc.metadata.created
            }));

            const result = {
                metadata: {
                    fileName,
                    fileType: 'pdf',
                    uploadDate: new Date().toISOString(),
                    totalChunks: simplifiedChunks.length
                },
                chunks: simplifiedChunks
            };

            this.log('8.5', 'processDocument', 'Document processing completed', {
                fileName,
                totalChunks: result.metadata.totalChunks
            });

            return result;
        } catch (error) {
            this.log('ERROR', 'processDocument', 'Error processing document', {
                error: error.message,
                fileName
            });
            throw error;
        }
    }
} 