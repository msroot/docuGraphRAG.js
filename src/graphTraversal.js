import { Neo4jConnection } from './neo4j';

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

    this.neo4j = new Neo4jConnection(config);
  }

  async initialize() {
    await this.setupGraphAlgorithms();
  }

  async setupGraphAlgorithms() {
    const session = this.neo4j.session();
    try {
      // Project graph for algorithms
      await session.run(`
                CALL gds.graph.project(
                    'document_knowledge_graph',
                    ['DocumentChunk', 'Entity'],
                    {
                        RELATES_TO: {orientation: 'UNDIRECTED'},
                        HAS_ENTITY: {orientation: 'UNDIRECTED'},
                        REFERENCES: {orientation: 'UNDIRECTED'},
                        APPEARS_WITH: {orientation: 'UNDIRECTED'}
                    },
                    {
                        nodeProperties: ['embedding', 'type', 'confidence'],
                        relationshipProperties: ['weight', 'confidence']
                    }
                )
            `);

      // Create necessary indexes
      await session.run(`
                CREATE INDEX document_temporal IF NOT EXISTS
                FOR (e:Entity)
                ON (e.type, e.value)
                WHERE e.type = 'DATE'
            `);
    } catch (error) {
      console.error('Error setting up graph algorithms:', error);
      throw error;
    } finally {
      await session.close();
    }
  }

  async findPathBasedContext(question, maxHops = 3) {
    const session = this.neo4j.session();
    try {
      const result = await session.run(`
                MATCH path = (start:DocumentChunk)-[*1..${maxHops}]-(related:DocumentChunk)
                WHERE start.content CONTAINS $searchTerm
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
            `, { searchTerm: question });

      return result.records.map(record => ({
        path: record.get('path'),
        relevance: record.get('pathRelevance')
      }));
    } finally {
      await session.close();
    }
  }

  async exploreSemanticSubgraph(startNodeId) {
    const session = this.neo4j.session();
    try {
      const result = await session.run(`
                MATCH (start:DocumentChunk {id: $startNodeId})
                CALL gds.alpha.bfs.stream({
                    nodeQuery: 'MATCH (n) WHERE n:DocumentChunk OR n:Entity RETURN id(n) AS id',
                    relationshipQuery: 'MATCH (n)-[r]->(m) RETURN id(n) AS source, id(m) AS target, type(r) AS type',
                    startNode: start,
                    maxDepth: 3
                })
                YIELD path
                WITH path, 
                     [n IN nodes(path) WHERE n:Entity | n.text] as entityTexts,
                     length(path) as pathLength
                RETURN path, entityTexts, pathLength,
                       1.0 / pathLength as relevanceScore
                ORDER BY relevanceScore DESC
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
    const session = this.neo4j.session();
    try {
      const result = await session.run(`
                MATCH (start:Entity)-[r1:RELATES_TO]->(middle:Entity)-[r2:RELATES_TO]->(end:Entity)
                WHERE start.type = 'CONCEPT' AND end.type = 'CONCEPT'
                WITH start, middle, end,
                     gds.similarity.cosine(start.embedding, $questionEmbedding) as startRelevance,
                     gds.similarity.cosine(end.embedding, $questionEmbedding) as endRelevance,
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

  async findTemporalContext(targetDate, windowDays = 7) {
    const session = this.neo4j.session();
    try {
      const result = await session.run(`
                MATCH (d:Document)-[:HAS_CHUNK]->(c:DocumentChunk)-[:HAS_ENTITY]->(e:Entity)
                WHERE e.type = 'DATE' AND 
                      date(e.value) >= date($targetDate) - duration({days: $windowDays}) AND
                      date(e.value) <= date($targetDate) + duration({days: $windowDays})
                WITH c, e, abs(duration.between(date(e.value), date($targetDate)).days) as dayDiff
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
        windowDays
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

  async expandEntityContext(entityName, maxDepth = 2) {
    const session = this.neo4j.session();
    try {
      const result = await session.run(`
                MATCH (source:Entity {text: $entityName})
                CALL apoc.path.subgraphNodes(source, {
                    relationshipFilter: "RELATES_TO|REFERENCES|APPEARS_WITH",
                    minLevel: 1,
                    maxLevel: $maxDepth
                })
                YIELD node
                WITH node, 
                     CASE
                         WHEN node:Entity THEN 1.0
                         ELSE 0.8
                     END as baseScore
                MATCH (node)<-[:HAS_ENTITY]-(chunk:DocumentChunk)
                WITH node, chunk, baseScore,
                     baseScore * pow($weightDecay, length(path)) as score
                RETURN node, chunk, score
                ORDER BY score DESC
                LIMIT 15
            `, {
        entityName,
        maxDepth,
        weightDecay: this.config.weightDecay
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

  async findWeightedPaths(startEntity, endEntity) {
    const session = this.neo4j.session();
    try {
      const result = await session.run(`
                MATCH path = shortestPath(
                    (start:Entity {text: $startEntity})-[*..5]-(end:Entity {text: $endEntity})
                )
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
            `, { startEntity, endEntity });

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

  async mergeContexts(results) {
    // Combine and normalize results from different algorithms
    const combinedResults = results.flatMap(({ results, weight }) =>
      results.map(result => ({
        ...result,
        normalizedScore: result.relevance * weight
      }))
    );

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