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

            // Verify file type
            if (!fileName.toLowerCase().endsWith('.pdf')) {
                throw new Error('Only PDF files are supported');
            }

            // 1. Extract text from PDF
            this.log('Step 1: Extracting text from PDF');
            const text = await this.extractTextFromPDF(buffer);
            this.log(`Text extraction complete. Total text length: ${text.length}`);

            // 2. Split text into chunks
            this.log('Step 2: Splitting text into chunks');
            const chunks = await this.textSplitter.splitText(text);
            this.log(`Text splitting complete. Created ${chunks.length} chunks`);

            // 3. Process each chunk
            this.log('Step 3: Creating chunk objects');
            const processedChunks = chunks.map((chunk, index) => ({
                id: uuidv4(),
                text: chunk,
                chunkIndex: index
            }));

            // 4. Create document metadata
            this.log('Step 4: Creating document metadata');
            const documentMetadata = {
                id: uuidv4(),
                fileName,
                fileType: 'pdf',
                uploadDate: new Date().toISOString(),
                totalChunks: processedChunks.length
            };

            this.log('Document processing complete', {
                documentId: documentMetadata.id,
                totalChunks: documentMetadata.totalChunks
            });

            return {
                metadata: documentMetadata,
                chunks: processedChunks
            };
        } catch (error) {
            console.error('[Processor] Error processing document:', error);
            throw error;
        }
    }
} 