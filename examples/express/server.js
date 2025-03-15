import express from 'express';
import multer from 'multer';
import { DocuGraphRAG } from '../../src/index.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import neo4j from 'neo4j-driver';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

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
             OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
             WITH d, count(c) as chunkCount
             RETURN {
                 id: d.documentId,
                 name: d.name,
                 uploadedAt: d.created,
                 isProcessed: chunkCount > 0,
                 selected: true
             } as document`
        );
        const documents = result.records.map(record => record.get('document'));
        res.json({
            success: true,
            documents: documents
        });
    } catch (error) {
        console.error('Error fetching documents:', error);
        res.status(500).json({
            success: false,
            error: 'Error fetching documents'
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

        const scenarioDescription = req.body.scenarioDescription;
        if (!scenarioDescription) {
            return res.status(400).json({
                success: false,
                error: 'Scenario description is required'
            });
        }

        console.log('Handling file upload:', {
            fileName: req.file.originalname,
            fileSize: req.file.size,
            scenarioDescription
        });

        // Extract text from PDF using pdf-parse
        const pdfData = await pdfParse(req.file.buffer);
        const fullText = pdfData.text;

        // Process the extracted text
        const result = await docurag.processDocument(fullText, scenarioString);

        // Update document name in Neo4j
        const session = driver.session();
        try {
            await session.run(
                'MATCH (d:Document {documentId: $documentId}) SET d.name = $name',
                { documentId: result.documentId, name: req.file.originalname }
            );
        } finally {
            await session.close();
        }

        res.json({
            success: true,
            documentId: result.documentId,
            name: req.file.originalname
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
    const { question, documentIds } = req.body;
    console.log('Chat request:', { question, documentIds });

    if (!question) {
        return res.json({ success: false, error: 'Question is required' });
    }

    if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
        return res.json({ success: false, error: 'At least one document must be selected' });
    }

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        // First get the context
        const searchResults = await docurag.llm.searchSimilarChunks(question, '', documentIds);

        if (!searchResults || searchResults.length === 0) {
            res.write(`data: ${JSON.stringify({ content: "I couldn't find any relevant information in the selected documents to answer your question." })}\n\n`);
            res.end();
            return;
        }

        // Format context
        const formattedContext = docurag.formatContextForLLM([
            {
                type: 'text',
                content: searchResults.map(r => r.content).join('\n\n'),
                normalizedScore: 1.0
            }
        ]);

        // Create the messages for the chat completion
        const messages = [
            {
                role: "system",
                content: "You are a helpful assistant that provides accurate answers based on the given context. Only use information from the provided context."
            },
            {
                role: "user",
                content: `Based on the following context, answer this question: "${question}"\n\nContext:\n${formattedContext}\n\nProvide a clear and concise answer based ONLY on the information provided in the context.`
            }
        ];

        // Stream the response
        const stream = await docurag.llm.openai.chat.completions.create({
            model: "gpt-4",
            messages: messages,
            stream: true
        });

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('Error handling chat:', error);
        res.write(`data: ${JSON.stringify({ error: 'An error occurred while processing your question. Please try again.' })}\n\n`);
        res.end();
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

// Remove the separate generateSchema endpoint since we're handling it in the library
app.post('/generateSchema', async (req, res) => {
    res.status(410).json({
        success: false,
        error: 'This endpoint is deprecated. Please include scenario description with document upload.'
    });
});

// Add delete document endpoint
app.delete('/documents/:documentId', async (req, res) => {
    const session = driver.session();
    try {
        const { documentId } = req.params;

        // Delete document and all related nodes
        await session.run(`
            MATCH (d:Document {documentId: $documentId})
            OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
            OPTIONAL MATCH (c)-[:HAS_ENTITY]->(e:Entity)
            DETACH DELETE d, c, e
        `, { documentId });

        res.json({
            success: true,
            message: 'Document deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting document:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to delete document'
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