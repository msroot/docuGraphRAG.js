import express from 'express';
import multer from 'multer';
import { DocuGraphRAG } from '../../src/index.js';
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

// Get current document
app.get('/documents', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (d:Document) 
             RETURN d`
        );
        const documents = result.records.map(record => record.get('d').properties);
        res.json(documents);
    } catch (error) {
        console.error('Error fetching documents:', error);
        res.status(500).json({ error: 'Error fetching documents' });
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

        console.log('Handling file upload:', {
            fileName: req.file.originalname,
            fileSize: req.file.size
        });

        const result = await docurag.processDocument(req.file.buffer, req.file.originalname);
        res.json({
            success: true,
            documentId: result.documentId
        });
    } catch (error) {
        console.error('Error handling document:', error);
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
        console.error('Error handling chat:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'An unexpected error occurred with your request.'
        });
    }
});

// Cleanup endpoint
app.post('/cleanup', async (req, res) => {
    try {
        // Clean up all document data and resources using DocuGraphRAG
        await docurag.cleanup();

        // Reinitialize DocuGraphRAG for future use
        await docurag.initialize();

        res.json({
            success: true,
            message: 'Document removed successfully'
        });
    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to remove document'
        });
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
                try {
                    await docurag.cleanup();
                } catch (error) {
                    console.error('Error during shutdown cleanup:', error);
                } finally {
                    process.exit(0);
                }
            });
        });
    } catch (error) {
        console.error('Failed to initialize DocuRAG:', error);
        process.exit(1);
    }
}

startServer(); 