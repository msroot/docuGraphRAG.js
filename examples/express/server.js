import express from 'express';
import multer from 'multer';
import { DocuGraphRAG } from '../../index.js';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import neo4j from 'neo4j-driver';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const HARDCODED_USER_ID = '1'; // TODO: Replace with proper user authentication

// Initialize express app with security defaults
const app = express();

// Middleware setup with security headers
app.use(cors());
app.use(express.json());  // Add this BEFORE routes
app.use(express.static(path.join(__dirname, 'public')));

// Neo4j configuration
const neo4jUrl = process.env.VECTOR_STORE_URL || 'bolt://localhost:7687';
const neo4jUser = process.env.VECTOR_STORE_USER || 'neo4j';
const neo4jPassword = process.env.VECTOR_STORE_PASSWORD || 'password123';

// Initialize Neo4j driver
const driver = neo4j.driver(
    neo4jUrl,
    neo4j.auth.basic(neo4jUser, neo4jPassword)
);

// Initialize DocuRAG instance
const docuRAG = new DocuGraphRAG({
    vectorStore: 'neo4j',
    vectorStoreConfig: {
        url: neo4jUrl,
        user: neo4jUser,
        password: neo4jPassword
    },
    llmUrl: process.env.LLM_URL || 'http://localhost:11434'
});

// Get all documents for a user
app.get('/documents', async (req, res) => {
    const session = driver.session();
    try {
        // Query Neo4j for documents
        const result = await session.run(
            `MATCH (d:Document) 
             WHERE d.userId = $userId 
             RETURN d`,
            { userId: HARDCODED_USER_ID }
        );
        
        const documents = result.records.map(record => {
            const doc = record.get('d').properties;
            return {
                id: doc.id || doc.documentId,
                name: doc.name || doc.fileName,
                uploadedAt: doc.uploadedAt || doc.timestamp || new Date().toISOString(),
                status: doc.status || 'processed'
            };
        });

        res.json({
            success: true,
            documents: documents
        });
    } catch (error) {
        console.error('Error fetching documents:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch documents'
        });
    } finally {
        await session.close();
    }
});

// Configure multer for secure PDF upload
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'));
        }
    }
});

// Upload endpoint
app.post('/upload', upload.single('pdf'), async (req, res) => {
    const session = driver.session();
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false,
                error: 'No PDF file uploaded'
            });
        }

        const { buffer, originalname } = req.file;

        // Process document
        const result = await docuRAG.processDocument(buffer, originalname);
        
        if (!result || !result.documentId) {
            throw new Error('PDF processing failed');
        }

        // Store document metadata in Neo4j
        const documentInfo = {
            id: result.documentId,
            name: originalname,
            userId: HARDCODED_USER_ID,
            uploadedAt: new Date().toISOString(),
            status: 'processed'
        };

        // Store in Neo4j
        await session.run(
            `MERGE (d:Document {id: $id})
             SET d += $properties
             RETURN d`,
            {
                id: documentInfo.id,
                properties: documentInfo
            }
        );

        res.json({ 
            success: true,
            message: 'PDF processed successfully',
            document: documentInfo
        });
    } catch (error) {
        console.error('PDF processing error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to process PDF file'
        });
    } finally {
        await session.close();
    }
});

// Chat endpoint with Server-Sent Events (SSE)
app.post('/chat', async (req, res) => {
    const session = driver.session();
    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                success: false,
                error: 'Invalid request body'
            });
        }

        const { message } = req.body;

        if (!message || typeof message !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Message is required and must be a string'
            });
        }

        // Get all document IDs for the user
        const result = await session.run(
            `MATCH (d:Document) 
             WHERE d.userId = $userId 
             RETURN d.id`,
            { userId: HARDCODED_USER_ID }
        );
        
        const documentIds = result.records.map(record => record.get('d.id'));
        
        if (documentIds.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No documents found for user'
            });
        }

        // Configure SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Chat with all documents
        await docuRAG.chat(message, {
            documentIds, // Pass array of document IDs
            onData: (data) => {
                try {
                    // Send the content and any source information
                    res.write(`data: ${JSON.stringify({
                        content: data.content,
                        sources: data.sources?.map(source => ({
                            fileName: source.fileName,
                            text: source.text.substring(0, 150) + '...' // Send preview of source text
                        }))
                    })}\n\n`);
                } catch (error) {
                    console.error('Stream write error:', error);
                    res.write(`data: ${JSON.stringify({ 
                        success: false, 
                        error: 'Error streaming response' 
                    })}\n\n`);
                    res.end();
                }
            },
            onEnd: () => {
                try {
                    res.write('data: [DONE]\n\n');
                    res.end();
                } catch (error) {
                    console.error('Stream end error:', error);
                }
            },
            onError: (error) => {
                console.error('Chat processing error:', error);
                res.write(`data: ${JSON.stringify({ 
                    success: false, 
                    error: 'Failed to process chat message' 
                })}\n\n`);
                res.end();
            }
        });
    } catch (error) {
        console.error('Chat endpoint error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to process chat message' 
            });
        }
    } finally {
        await session.close();
    }
});

// Cleanup endpoint
app.post('/cleanup', async (req, res) => {
    const session = driver.session();
    try {
        // Clean up Neo4j data
        await session.run('MATCH (d:Document) DETACH DELETE d');
        
        // Clean up DocuRAG resources
        await docuRAG.cleanup();
        
        res.json({ 
            success: true, 
            message: 'Resources cleaned up successfully' 
        });
    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to cleanup resources' 
        });
    } finally {
        await session.close();
    }
});

// Start server with proper error handling
const PORT = process.env.PORT || 3000;

// Initialize DocuRAG and start server
async function startServer() {
    try {
        await docuRAG.initialize();
        console.log('DocuRAG initialized successfully');
        
        const server = app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
        });

        // Handle server shutdown gracefully
        process.on('SIGTERM', async () => {
            console.log('Received SIGTERM. Performing graceful shutdown...');
            await driver.close();
            server.close(async () => {
                await docuRAG.cleanup();
                process.exit(0);
            });
        });
    } catch (error) {
        console.error('Failed to initialize DocuRAG:', error);
        process.exit(1);
    }
}

startServer(); 