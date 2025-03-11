import pdfParse from 'pdf-parse';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createExtractor } from './extractors.js';
import { v4 as uuidv4 } from 'uuid';

export class DocumentProcessor {
    constructor(config = {}) {
        this.config = {
            chunkSize: 1000,
            chunkOverlap: 200,
            llmUrl: 'http://localhost:11434',
            debug: false,
            ...config
        };

        this.textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.config.chunkSize,
            chunkOverlap: this.config.chunkOverlap,
            lengthFunction: (text) => text.length,
        });

        this.extractor = createExtractor({
            llmUrl: this.config.llmUrl,
            llmModel: this.config.llmModel,
            debug: this.config.debug
        });

        this.debug = this.config.debug;
    }

    log(...args) {
        if (this.debug) {
            console.log('[DocumentProcessor]', ...args);
        }
    }

    async extractTextFromPDF(pdfBuffer) {
        try {
            this.log('Starting PDF text extraction');
            const data = await pdfParse(pdfBuffer);
            this.log(`PDF text extraction complete. Extracted ${data.text.length} characters`);
            return data.text;
        } catch (error) {
            console.error('[DocumentProcessor] Error extracting text from PDF:', error);
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

            // 3. Process each chunk in parallel
            this.log('Step 3: Processing chunks and extracting information');
            const processedChunks = await Promise.all(chunks.map(async (chunk, index) => {
                this.log(`Processing chunk ${index + 1}/${chunks.length}`);
                // 3.1 Extract information
                const extractedInfo = await this.extractor.extractAll(chunk);
                this.log(`Chunk ${index + 1} processing complete`, {
                    entities: extractedInfo.entities.length,
                    keywords: extractedInfo.keywords.length,
                    concepts: extractedInfo.concepts.length
                });

                // 3.2 Create chunk metadata
                return {
                    id: uuidv4(),
                    text: chunk,
                    chunkIndex: index,
                    extractedInfo
                };
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
            console.error('[DocumentProcessor] Error processing document:', error);
            throw error;
        }
    }
} 