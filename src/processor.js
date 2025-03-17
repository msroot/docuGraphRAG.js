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

    async extractTextFromPDF(pdfBuffer) {
        try {
            const data = await pdfParse(pdfBuffer);
            return data.text;
        } catch (error) {
            throw error;
        }
    }

    async processDocument(buffer, fileName) {
        try {
            if (!fileName.toLowerCase().endsWith('.pdf')) {
                throw new Error('Only PDF files are supported');
            }

            const text = await this.extractTextFromPDF(buffer);

            const doc = new Document({
                pageContent: text,
                metadata: {
                    source: fileName,
                    type: 'pdf',
                    created: new Date().toISOString()
                }
            });

            const docs = await this.textSplitter.splitDocuments([doc]);

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

            return result;
        } catch (error) {
            throw error;
        }
    }
} 