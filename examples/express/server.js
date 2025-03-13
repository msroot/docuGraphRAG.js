import express from 'express';
import multer from 'multer';
import { DocuGraphRAG } from '../../src/DocuGraphRAG.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import neo4j from 'neo4j-driver';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the root directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
 
// Constants
const HARDCODED_USER_ID = '1'; // TODO: Replace with proper user authentication

// Initialize express app with security defaults
const app = express();

// Middleware setup with security headers
app.use(express.json());  // Add this BEFORE routes
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Neo4j driver
const driver = neo4j.driver(
    process.env.NEO4J_URL,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        // Accept PDF files only
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'));
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Initialize DocuGraphRAG with environment variables
const docurag = new DocuGraphRAG({
    neo4jUrl: process.env.NEO4J_URL,
    neo4jUser: process.env.NEO4J_USER,
    neo4jPassword: process.env.NEO4J_PASSWORD,
    debug: process.env.DEBUG === 'true'
});

// Get all documents for a user
app.get('/documents', async (req, res) => {
    const session = driver.session();
    try {
        // Query Neo4j for documents with all properties
        const result = await session.run(
            `MATCH (d:Document) 
             WHERE d.userId = $userId 
             RETURN d`,
            { userId: HARDCODED_USER_ID }
        );
        
        const documents = result.records.map(record => {
            const doc = record.get('d').properties;
            const neoQuery = `// 1. Check all Documents
MATCH (d:Document)
RETURN d;

// 2. Check Document-Chunk connections
MATCH (d:Document)-[r:HAS_CHUNK]->(c:DocumentChunk)
RETURN d, r, c;

// 3. Check Chunks to Entities
MATCH (c:DocumentChunk)-[r]->(e:Entity)
RETURN c, r, e;

// 4. Check Chunks to Keywords
MATCH (c:DocumentChunk)-[r]->(k:Keyword)
RETURN c, r, k;

// 5. Check Chunks to Concepts
MATCH (c:DocumentChunk)-[r]->(co:Concept)
RETURN c, r, co;

// 6. Check for any ERROR nodes
MATCH (e:ERROR)
RETURN e;

// 7. Check all relationships from chunks (to see what we might have missed)
MATCH (c:DocumentChunk)-[r]-(x)
RETURN c, type(r), x;`;
            
            return {
                ...doc,
                neoQuery
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

// Routes
app.post('/upload', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false,
                error: 'No PDF file uploaded' 
            });
        }

        console.log('Processing file:', {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        });

        const result = await docurag.processDocument(req.file.buffer, req.file.originalname);
        res.json({
            success: true,
            documentId: result.documentId
        });
    } catch (error) {
        console.error('Error processing document:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to process document'
        });
    }
});

app.post('/chat', async (req, res) => {
    try {
        // Accept either 'question' or 'message' from the request body
        const { question, message } = req.body;
        const userQuery = question || message;
        
        console.log('Chat request:', { userQuery, originalBody: req.body });
        
        if (!userQuery) {
            return res.status(400).json({ 
                success: false, 
                error: 'Question is required. Please provide either a "question" or "message" field in your request.' 
            });
        }

        const result = await docurag.chat(userQuery);
        res.json(result);
    } catch (error) {
        console.error('Error processing chat:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'An unexpected error occurred while processing your request.'
        });
    }
});

// Cleanup endpoint
app.post('/cleanup', async (req, res) => {
    const session = driver.session();
    try {
        // Clean up Neo4j data
        await session.run('MATCH (d:Document) DETACH DELETE d');
        
        // Clean up DocuRAG resources
        await docurag.cleanup();
        
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
const port = process.env.PORT || 3000;

// Initialize DocuRAG and start server
async function startServer() {
    try {
        console.log('Initializing DocuRAG...');
        await docurag.initialize();
        console.log('DocuRAG initialized successfully');
        
        const server = app.listen(port, () => {
            console.log(`Server running at http://localhost:${port}`);
        });

        // Handle server shutdown gracefully
        process.on('SIGTERM', async () => {
            console.log('Received SIGTERM. Performing graceful shutdown...');
            await driver.close();
            server.close(async () => {
                await docurag.cleanup();
                process.exit(0);
            });
        });
    } catch (error) {
        console.error('Failed to initialize DocuRAG:', error);
        process.exit(1);
    }
}

startServer(); 