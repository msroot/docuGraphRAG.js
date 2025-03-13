import pdfParse from 'pdf-parse';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { v4 as uuidv4 } from 'uuid';

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
            chunkOverlap: this.config.chunkOverlap,
            lengthFunction: (text) => text.length,
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
            const chunks = await this.textSplitter.splitText(text);
            const documentId = uuidv4()
            

            const processedChunks = chunks.map((chunk, index) => ({
                text: chunk,
                chunkIndex: index,
                documentId
            }));

            
            const metadata = {
                documentId ,
                fileName,
                fileType: 'pdf',
                uploadDate: new Date().toISOString(),
                totalChunks: processedChunks.length
            };

           

            return {
                metadata,
                chunks: processedChunks
            };
        } catch (error) {
            console.error('[Processor] Error processing document:', error);
            throw error;
        }
    }
} 