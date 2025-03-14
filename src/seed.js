export class DatabaseSeeder {
    constructor(nodeLabels, relationships, entityTypes, nodeProperties) {
        this.NODE_LABELS = nodeLabels;
        this.RELATIONSHIPS = relationships;
        this.ENTITY_TYPES = entityTypes;
        this.NODE_PROPERTIES = nodeProperties;
    }

    async createConstraints(session) {
        try {
            // Try to drop existing constraints and indexes using APOC if available
            try {
                await session.run('CALL apoc.schema.assert({},{})');
            } catch (error) {
                // If APOC is not available, drop constraints manually
                const constraints = await session.run('SHOW CONSTRAINTS');
                for (const record of constraints.records) {
                    const constraintName = record.get('name');
                    if (constraintName) {
                        await session.run(`DROP CONSTRAINT ${constraintName} IF EXISTS`);
                    }
                }

                // Drop indexes manually
                const indexes = await session.run('SHOW INDEXES');
                for (const record of indexes.records) {
                    const indexName = record.get('name');
                    if (indexName) {
                        await session.run(`DROP INDEX ${indexName} IF EXISTS`);
                    }
                }
            }

            // Create constraints for each node label
            for (const [key, label] of Object.entries(this.NODE_LABELS)) {
                // For Document, create constraint on documentId
                if (label === this.NODE_LABELS.DOCUMENT) {
                    await session.run(`
                        CREATE CONSTRAINT document_id IF NOT EXISTS 
                        FOR (n:${label}) 
                        REQUIRE n.${this.NODE_PROPERTIES.DOCUMENT_ID} IS UNIQUE
                    `);
                }

                // For Entity nodes, create composite index on text and type
                if (label === this.NODE_LABELS.ENTITY) {
                    await session.run(`
                        CREATE INDEX entity_text_type IF NOT EXISTS 
                        FOR (n:${label}) 
                        ON (n.${this.NODE_PROPERTIES.TEXT}, n.${this.NODE_PROPERTIES.TYPE})
                    `);
                }
            }

            // Create indexes for better query performance
            await session.run(`
                CREATE INDEX entity_type_index IF NOT EXISTS
                FOR (n:${this.NODE_LABELS.ENTITY})
                ON (n.${this.NODE_PROPERTIES.TYPE})
            `);

            await session.run(`
                CREATE INDEX entity_text_index IF NOT EXISTS
                FOR (n:${this.NODE_LABELS.ENTITY})
                ON (n.${this.NODE_PROPERTIES.TEXT})
            `);

            await session.run(`
                CREATE INDEX document_chunk_id_index IF NOT EXISTS
                FOR (n:${this.NODE_LABELS.DOCUMENT_CHUNK})
                ON (n.${this.NODE_PROPERTIES.DOCUMENT_ID})
            `);

        } catch (error) {
            console.error('Failed to create constraints and indexes:', error);
            throw new Error(`Failed to create constraints and indexes: ${error.message}`);
        }
    }

    async seed(session) {
        try {
            await this.createConstraints(session);
        } catch (error) {
            console.error('Failed to seed database:', error);
            throw new Error(`Failed to seed database: ${error.message}`);
        }
    }
} 