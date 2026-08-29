import { describe, expect, it } from 'vitest';
import { buildPrPollBatchQuery } from './graphql-batch-builder';

describe('buildPrPollBatchQuery', () => {
  it('builds status aliases and two bounded discovery aliases per branch, plus rateLimit', () => {
    const batch = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: [{ prNumber: 2924 }, { prNumber: 2925 }],
      discoveryTargets: [{ branch: 'feat/x' }],
    });

    expect(batch).not.toBeNull();
    if (!batch) return;

    expect(batch.variables).toEqual({ owner: 'owner', name: 'repo', b0: 'feat/x' });
    expect(batch.statusAliases).toEqual([
      { alias: 'p0', prNumber: 2924 },
      { alias: 'p1', prNumber: 2925 },
    ]);
    expect(batch.discoveryAliases).toEqual([
      { alias: 'd0o', branch: 'feat/x', bucket: 'open' },
      { alias: 'd0t', branch: 'feat/x', bucket: 'terminal' },
    ]);
    expect(batch.truncatedStatusCount).toBe(0);
    expect(batch.truncatedDiscoveryCount).toBe(0);

    expect(batch.query).toContain(
      'query PrPollBatch($owner: String!, $name: String!, $b0: String!)'
    );
    expect(batch.query).toContain('repository(owner: $owner, name: $name)');
    expect(batch.query).toContain('p0: pullRequest(number: 2924)');
    expect(batch.query).toContain('p1: pullRequest(number: 2925)');
    expect(batch.query).toContain('statusCheckRollup {');
    expect(batch.query).toContain('commits(last: 1)');
    expect(batch.query).toContain('headRefName');
    expect(batch.query).toContain('mergeStateStatus');
    expect(batch.query).toContain(
      'd0o: pullRequests(first: 1, states: [OPEN], headRefName: $b0, ' +
        'orderBy: {field: UPDATED_AT, direction: DESC})'
    );
    expect(batch.query).toContain(
      'd0t: pullRequests(first: 1, states: [MERGED, CLOSED], headRefName: $b0, ' +
        'orderBy: {field: UPDATED_AT, direction: DESC})'
    );
    expect(batch.query).toContain('rateLimit {');
    expect(batch.query).toContain('cost');
    expect(batch.query).toContain('remaining');
    expect(batch.query).toContain('resetAt');
  });

  it('never fetches product-level review fields in the background query', () => {
    const batch = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: [{ prNumber: 1 }],
      discoveryTargets: [{ branch: 'feat/x' }],
    });

    expect(batch?.query).not.toContain('reviewDecision');
    expect(batch?.query).not.toContain('reviewThreads');
  });

  it('passes branch names through variables, never string literals', () => {
    const evilBranch = 'x") { __typename } #';
    const batch = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: [],
      discoveryTargets: [{ branch: evilBranch }],
    });

    expect(batch).not.toBeNull();
    if (!batch) return;
    expect(batch.query).not.toContain(evilBranch);
    expect(batch.query).toContain('headRefName: $b0');
    expect(batch.variables['b0']).toBe(evilBranch);
  });

  it('dedupes repeated PR numbers and branches', () => {
    const batch = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: [{ prNumber: 1 }, { prNumber: 1 }, { prNumber: 2 }],
      discoveryTargets: [{ branch: 'a' }, { branch: 'a' }, { branch: 'b' }],
    });

    expect(batch?.statusAliases).toEqual([
      { alias: 'p0', prNumber: 1 },
      { alias: 'p1', prNumber: 2 },
    ]);
    expect(batch?.discoveryAliases.map((alias) => alias.alias)).toEqual([
      'd0o',
      'd0t',
      'd1o',
      'd1t',
    ]);
  });

  it('caps aliases at the budget (a discovery costs two), status targets first', () => {
    const truncated = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: Array.from({ length: 25 }, (_, i) => ({ prNumber: i + 1 })),
      discoveryTargets: [{ branch: 'a' }, { branch: 'b' }, { branch: 'c' }],
      maxAliases: 20,
    });
    expect(truncated?.statusAliases).toHaveLength(20);
    expect(truncated?.discoveryAliases).toHaveLength(0);
    expect(truncated?.truncatedStatusCount).toBe(5);
    expect(truncated?.truncatedDiscoveryCount).toBe(3);

    // A discovery target is never split across the budget boundary.
    const partial = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: Array.from({ length: 17 }, (_, i) => ({ prNumber: i + 1 })),
      discoveryTargets: [{ branch: 'a' }, { branch: 'b' }],
      maxAliases: 20,
    });
    expect(partial?.discoveryAliases.map((alias) => alias.alias)).toEqual(['d0o', 'd0t']);
    expect(partial?.truncatedDiscoveryCount).toBe(1);
  });

  it('skips invalid PR numbers defensively', () => {
    const batch = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: [{ prNumber: 0 }, { prNumber: -3 }, { prNumber: 1.5 }, { prNumber: 7 }],
      discoveryTargets: [],
    });

    expect(batch?.statusAliases).toEqual([{ alias: 'p0', prNumber: 7 }]);
  });

  it('returns null for a malformed repoFullName', () => {
    expect(
      buildPrPollBatchQuery({ repoFullName: 'not-a-repo', statusTargets: [], discoveryTargets: [] })
    ).toBeNull();
    expect(
      buildPrPollBatchQuery({
        repoFullName: 'a/b/c',
        statusTargets: [],
        discoveryTargets: [],
      })
    ).toBeNull();
  });

  it('omits discovery variable declarations when there are no discovery targets', () => {
    const batch = buildPrPollBatchQuery({
      repoFullName: 'owner/repo',
      statusTargets: [{ prNumber: 5 }],
      discoveryTargets: [],
    });

    expect(batch?.query).toContain('query PrPollBatch($owner: String!, $name: String!)');
    expect(batch?.variables).toEqual({ owner: 'owner', name: 'repo' });
  });
});
