export class GraphTraversalService {
  constructor(config = {}) {
    this.config = {
      maxHops: 3,
      temporalWindow: 7,
      minConfidence: 0.6,
      weightDecay: 0.8,
      algorithms: ['path', 'temporal', 'semantic'],
      ...config
    };

    if (!config.driver) {
      throw new Error('Neo4j driver is required for GraphTraversalService');
    }
    this.driver = config.driver;
  }

  async initialize() {
    // Temporarily disabled until we implement proper graph algorithm support
    // await this.setupGraphAlgorithms();
    return true;
  }

  async setupGraphAlgorithms() {
    const session = this.driver.session();
    try {
      // Create necessary indexes
      await session.run(`
                CREATE INDEX document_temporal IF NOT EXISTS
                FOR (e:Entity)
                ON (e.type, e.value)
                WHERE e.type = 'DATE'
            `);

      // Create index for entity text and type
      await session.run(`
                CREATE INDEX entity_text_type IF NOT EXISTS
                FOR (e:Entity)
                ON (e.text, e.type)
            `);

      // Create index for document chunks
      await session.run(`
                CREATE INDEX chunk_document IF NOT EXISTS
                FOR (c:DocumentChunk)
                ON (c.documentId, c.chunkIndex)
            `);

    } catch (error) {
      console.error('Error setting up indexes:', error);
      throw error;
    } finally {
      await session.close();
    }
  }

  async findPathBasedContext(question, maxHops = 3, documentFilter = '', documentIds = []) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
                MATCH (start:DocumentChunk)
                WHERE start.content CONTAINS $searchTerm ${documentFilter}
                MATCH path = (start)-[*1..${maxHops}]-(related:DocumentChunk)
                WHERE related.content CONTAINS $searchTerm ${documentFilter}
                WITH path, relationships(path) as rels,
                     reduce(weight = 1.0, r in relationships(path) | 
                            weight * CASE type(r)
                                WHEN 'SIMILAR_TO' THEN 0.9
                                WHEN 'REFERENCES' THEN 0.8
                                WHEN 'CONTINUES' THEN 0.95
                                ELSE 0.7
                            END) as pathRelevance
                RETURN path, pathRelevance
                ORDER BY pathRelevance DESC
                LIMIT 5
            `, {
        searchTerm: question,
        documentIds
      });

      return result.records.map(record => ({
        path: record.get('path'),
        relevance: record.get('pathRelevance')
      }));
    } finally {
      await session.close();
    }
  }

  async exploreSemanticSubgraph(startNodeId) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
                MATCH (start:DocumentChunk {id: $startNodeId})
                MATCH path = (start)-[*1..3]-(n)
                WHERE n:DocumentChunk OR n:Entity
                WITH path, 
                     [n IN nodes(path) WHERE n:Entity | n.text] as entityTexts,
                     length(path) as pathLength
                RETURN path, entityTexts, pathLength,
                       1.0 / pathLength as relevanceScore
                ORDER BY relevanceScore DESC
                LIMIT 10
            `, { startNodeId });

      return result.records.map(record => ({
        path: record.get('path'),
        entities: record.get('entityTexts'),
        length: record.get('pathLength'),
        relevance: record.get('relevanceScore')
      }));
    } finally {
      await session.close();
    }
  }

  async performKnowledgeReasoning(question, questionEmbedding) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
                MATCH (start:Entity)-[r1:RELATES_TO]->(middle:Entity)-[r2:RELATES_TO]->(end:Entity)
                WHERE start.type = 'CONCEPT' AND end.type = 'CONCEPT'
                WITH start, middle, end, r1, r2,
                     // Manual cosine similarity calculation for start entity
                     CASE 
                       WHEN start.embedding IS NOT NULL THEN
                         reduce(dot = 0.0, i in range(0, size(start.embedding)-1) | 
                           dot + start.embedding[i] * $questionEmbedding[i]
                         ) / (
                           sqrt(reduce(l2 = 0.0, i in range(0, size(start.embedding)-1) | 
                             l2 + start.embedding[i] * start.embedding[i]
                           )) * 
                           sqrt(reduce(l2 = 0.0, i in range(0, size($questionEmbedding)-1) | 
                             l2 + $questionEmbedding[i] * $questionEmbedding[i]
                           ))
                         )
                       ELSE 0
                     END as startRelevance,
                     // Manual cosine similarity calculation for end entity
                     CASE 
                       WHEN end.embedding IS NOT NULL THEN
                         reduce(dot = 0.0, i in range(0, size(end.embedding)-1) | 
                           dot + end.embedding[i] * $questionEmbedding[i]
                         ) / (
                           sqrt(reduce(l2 = 0.0, i in range(0, size(end.embedding)-1) | 
                             l2 + end.embedding[i] * end.embedding[i]
                           )) * 
                           sqrt(reduce(l2 = 0.0, i in range(0, size($questionEmbedding)-1) | 
                             l2 + $questionEmbedding[i] * $questionEmbedding[i]
                           ))
                         )
                       ELSE 0
                     END as endRelevance,
                     r1.confidence as conf1,
                     r2.confidence as conf2
                WHERE startRelevance > $minConfidence OR endRelevance > $minConfidence
                RETURN start, middle, end,
                       (startRelevance + endRelevance) / 2 * (conf1 + conf2) / 2 as pathRelevance,
                       [start.text, middle.text, end.text] as reasoningChain
                ORDER BY pathRelevance DESC
                LIMIT 10
            `, {
        questionEmbedding,
        minConfidence: this.config.minConfidence
      });

      return result.records.map(record => ({
        startEntity: record.get('start').properties,
        middleEntity: record.get('middle').properties,
        endEntity: record.get('end').properties,
        relevance: record.get('pathRelevance'),
        chain: record.get('reasoningChain')
      }));
    } finally {
      await session.close();
    }
  }

  async findTemporalContext(targetDate, windowDays = 7, documentFilter = '', documentIds = []) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
                MATCH (d:Document)-[:HAS_CHUNK]->(c:DocumentChunk)-[:HAS_ENTITY]->(e:Entity)
                WHERE e.type = 'DATE' 
                    AND datetime(e.value) >= datetime($targetDate) - duration({days: $windowDays})
                    AND datetime(e.value) <= datetime($targetDate) + duration({days: $windowDays})
                    ${documentFilter}
                WITH c, e, abs(duration.between(datetime(e.value), datetime($targetDate)).days) as dayDiff
                ORDER BY dayDiff
                WITH c, e, dayDiff, 
                     1.0 / (1 + dayDiff) as temporalRelevance
                RETURN c.content as content,
                       e.value as date,
                       dayDiff,
                       temporalRelevance
                ORDER BY temporalRelevance DESC
                LIMIT 10
            `, {
        targetDate: targetDate.toISOString(),
        windowDays,
        documentIds
      });

      return result.records.map(record => ({
        content: record.get('content'),
        date: record.get('date'),
        daysApart: record.get('dayDiff'),
        relevance: record.get('temporalRelevance')
      }));
    } finally {
      await session.close();
    }
  }

  async expandEntityContext(entityName, maxDepth = 2, documentFilter = '', documentIds = []) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
                MATCH (source:Entity {text: $entityName})<-[:HAS_ENTITY]-(c:DocumentChunk)
                WHERE 1=1 ${documentFilter}
                WITH source
                CALL apoc.path.subgraphNodes(source, {
                    relationshipFilter: "RELATES_TO|REFERENCES|APPEARS_WITH",
                    minLevel: 1,
                    maxLevel: $maxDepth
                })
                YIELD node, path
                WITH node, length(path) as pathLength,
                     CASE
                         WHEN node:Entity THEN 1.0
                         ELSE 0.8
                     END as baseScore
                MATCH (node)<-[:HAS_ENTITY]-(chunk:DocumentChunk)
                WHERE 1=1 ${documentFilter}
                WITH node, chunk, baseScore,
                     baseScore * pow($weightDecay, pathLength) as score
                RETURN node, chunk, score
                ORDER BY score DESC
                LIMIT 15
            `, {
        entityName,
        maxDepth,
        weightDecay: this.config.weightDecay,
        documentIds
      });

      return result.records.map(record => ({
        entity: record.get('node').properties,
        chunk: record.get('chunk').properties,
        relevance: record.get('score')
      }));
    } finally {
      await session.close();
    }
  }

  async findWeightedPaths(startEntity, endEntity, documentFilter = '', documentIds = []) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
                MATCH (start:Entity {text: $startEntity})<-[:HAS_ENTITY]-(c1:DocumentChunk)
                WHERE 1=1 ${documentFilter}
                WITH start
                MATCH (end:Entity {text: $endEntity})<-[:HAS_ENTITY]-(c2:DocumentChunk)
                WHERE 1=1 ${documentFilter}
                WITH start, end
                MATCH path = shortestPath((start)-[*..5]-(end))
                WITH path,
                     reduce(weight = 1.0, r in relationships(path) |
                        weight * CASE 
                            WHEN r.confidence >= 0.8 THEN 1.0
                            WHEN r.confidence >= 0.6 THEN 0.8
                            ELSE 0.6
                        END) as pathStrength,
                     [n IN nodes(path) | n.text] as nodeTexts,
                     [r IN relationships(path) | type(r)] as relTypes
                RETURN path, 
                       pathStrength,
                       nodeTexts,
                       relTypes,
                       length(path) as pathLength
                ORDER BY pathStrength DESC
            `, {
        startEntity,
        endEntity,
        documentIds
      });

      return result.records.map(record => ({
        path: record.get('path'),
        strength: record.get('pathStrength'),
        nodes: record.get('nodeTexts'),
        relationships: record.get('relTypes'),
        length: record.get('pathLength')
      }));
    } finally {
      await session.close();
    }
  }

  async mergeContexts(contexts) {
    if (!Array.isArray(contexts)) {
      console.warn('mergeContexts received non-array input:', contexts);
      return [];
    }

    // Combine and normalize results from different algorithms
    const combinedResults = contexts.flatMap(({ results, weight }) => {
      // Handle case where results is a query object
      if (results && typeof results === 'object' && results.query) {
        console.warn('Received query object instead of results array:', { weight });
        return [];
      }

      if (!results || !Array.isArray(results)) {
        console.warn('Invalid results in context:', { results, weight });
        return [];
      }

      return results.map(result => ({
        ...result,
        normalizedScore: (result.relevance || result.similarity || 0) * (weight || 0)
      }));
    });

    // Sort by normalized score and remove duplicates
    return combinedResults
      .sort((a, b) => b.normalizedScore - a.normalizedScore)
      .filter((result, index, self) =>
        index === self.findIndex(r =>
          r.content === result.content
        )
      );
  }
} 