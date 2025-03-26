import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import neo4j from 'neo4j-driver';
import { DocuGraphRAG } from '../src/index.js';
import * as pdfjsLib from 'pdfjs-dist';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'node_modules/pdfjs-dist/build/pdf.worker.mjs'
);


// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the root directory
dotenv.config({ path: path.resolve(__dirname, './.env') });

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

// Initialize DocuGraphRAG with environment variables
const docurag = new DocuGraphRAG({
    openaiApiKey: process.env.OPENAI_API_KEY,
});

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

// Helper function to extract text from PDF
async function extractTextFromPDF(buffer) {
    // Convert Buffer to Uint8Array
    const uint8Array = new Uint8Array(buffer);
    const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += pageText + '\n';
    }

    return fullText;
}

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
                 fileName: d.fileName,
                 uploadedAt: d.created,
                 status: d.status,
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

        // Extract text from PDF using pdfjs-dist
        const fullText = await extractTextFromPDF(req.file.buffer);
        const fileName = req.file.originalname;

        // Process the extracted text
        const result = await docurag.processDocument(fullText, scenarioDescription, fileName);

        res.json({
            success: true,
            documentId: result.documentId,
            name: fileName
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
    const { question, documentIds, vectorSearch, textSearch, graphSearch } = req.body;
    console.log('Chat request:', {
        question,
        documentIds,
        searchOptions: { vectorSearch, textSearch, graphSearch }
    });

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
        const stream = await docurag.chat(question, {
            documentIds,
            searchOptions: {
                vectorSearch: vectorSearch ?? true,
                textSearch: textSearch ?? true,
                graphSearch: graphSearch ?? true
            }
        });

        // Handle each chunk from the stream
        for await (const chunk of stream) {
            if (chunk.choices && chunk.choices[0]?.delta?.content) {
                res.write(`data: ${JSON.stringify({ content: chunk.choices[0].delta.content })}\n\n`);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('Error handling chat:', error);
        res.write(`data: ${JSON.stringify({ error: error.message || 'An error occurred while processing your question.' })}\n\n`);
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

app.post('/graph-data', async (req, res) => {
    const { documentIds } = req.body;

    if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
        return res.status(400).json({ error: 'Invalid document IDs' });
    }

    try {
        const session = driver.session();
        const query = `
            MATCH (d:Document)-[:HAS_CHUNK]->(c:DocumentChunk)-[:APPEARS_IN]->(e:Entity)
            WHERE d.documentId IN $documentIds
            WITH d, c, e
            MATCH (e)-[r]->(e2:Entity)
            WHERE e.documentId = e2.documentId
            RETURN DISTINCT 
                d.documentId as docId,
                d.name as docName,
                c.index as chunkIndex,
                e.text as sourceText,
                e.type as sourceType,
                type(r) as relationType,
                e2.text as targetText,
                e2.type as targetType
        `;

        const result = await session.run(query, { documentIds });

        // Transform the results into a graph structure
        const nodes = new Map();
        const edges = new Set();

        result.records.forEach(record => {
            // Add document node
            const docId = record.get('docId');
            nodes.set(docId, {
                id: docId,
                label: record.get('docName') || docId,
                type: 'Document'
            });

            // Add source entity node
            const sourceId = `${docId}-${record.get('sourceText')}`;
            nodes.set(sourceId, {
                id: sourceId,
                label: record.get('sourceText'),
                type: record.get('sourceType')
            });

            // Add target entity node
            const targetId = `${docId}-${record.get('targetText')}`;
            nodes.set(targetId, {
                id: targetId,
                label: record.get('targetText'),
                type: record.get('targetType')
            });

            // Add edges
            edges.add({
                from: docId,
                to: sourceId,
                type: 'HAS_ENTITY'
            });

            edges.add({
                from: sourceId,
                to: targetId,
                type: record.get('relationType')
            });
        });

        await session.close();

        res.json({
            nodes: Array.from(nodes.values()),
            edges: Array.from(edges)
        });

    } catch (error) {
        console.error('Error fetching graph data:', error);
        res.status(500).json({ error: 'Failed to fetch graph data' });
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