/**
 * GitHub API Service.
 *
 * Provides functions for fetching repositories, issues, and branches from GitHub.
 * Used in the agent creation form.
 *
 * Features:
 * - Pagination support
 * - Rate limit handling with exponential backoff
 * - Simplified DTOs for UI
 */

import { Octokit } from '@octokit/rest'

/**
 * Simplified repository DTO for UI.
 */
export interface RepoDto {
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
}

/**
 * Simplified issue DTO for UI.
 */
export interface IssueDto {
  number: number
  title: string
  state: 'open' | 'closed'
}

/**
 * Simplified branch DTO for UI.
 */
export interface BranchDto {
  name: string
  protected: boolean
}

/**
 * Issue details DTO with full information.
 */
export interface IssueDetailsDto {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: string[]
}

/**
 * Options for listing repositories.
 */
export interface ListReposOptions {
  /** Search query to filter repos */
  search?: string
  /** Maximum number of results */
  limit?: number
  /** Page number (1-indexed) */
  page?: number
  /** Sort by field */
  sort?: 'full_name' | 'created' | 'updated' | 'pushed'
  /** Sort direction */
  direction?: 'asc' | 'desc'
}

/**
 * Creates an Octokit client with the given access token.
 */
function createClient(accessToken: string): Octokit {
  return new Octokit({
    auth: accessToken,
    retry: {
      enabled: true,
      // Use default retry behavior from Octokit
    },
    throttle: {
      enabled: false, // We handle rate limiting manually
    },
  })
}

/**
 * Checks if an error is a GitHub rate limit error by examining
 * the status code and rate limit headers.
 */
function isRateLimitError(error: unknown): boolean {
  const status = (error as { status?: number }).status
  const headers = (error as { response?: { headers?: Record<string, string> } }).response?.headers

  // 429 is always rate limited
  if (status === 429) {
    return true
  }

  // 403 might be rate limited or an auth/permission error
  // Check rate limit headers to distinguish
  if (status === 403 && headers) {
    const remaining = headers['x-ratelimit-remaining']
    // If remaining is '0', it's a rate limit; otherwise it's a permission error
    if (remaining === '0') {
      return true
    }
  }

  return false
}

/**
 * Wraps an API call with exponential backoff retry for rate limits.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Only retry on actual rate limit errors, not auth/permission errors
      if (!isRateLimitError(error) || attempt === maxRetries) {
        throw error
      }

      // Exponential backoff with jitter: 1s, 2s, 4s base + 0-1s jitter
      const baseDelay = 1000 * 2 ** attempt
      const jitter = Math.random() * 1000
      const delay = baseDelay + jitter

      console.warn(
        `GitHub API rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`,
      )
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError || new Error('Retry failed')
}

/**
 * Lists repositories accessible to the user.
 *
 * @param accessToken - GitHub access token
 * @param options - Filtering and pagination options
 * @returns List of repositories
 */
export async function listUserRepos(
  accessToken: string,
  options: ListReposOptions = {},
): Promise<RepoDto[]> {
  const octokit = createClient(accessToken)
  const { limit = 30, page = 1, sort = 'pushed', direction = 'desc' } = options

  // If search is provided, get user info first then use search API
  if (options.search && options.search.trim()) {
    // Get the authenticated user's login for the search query
    const { data: user } = await withRetry(() => octokit.users.getAuthenticated())
    // Search in repos the user has access to using fork:true to include forks
    const searchQuery = `${options.search.trim()} in:name user:${user.login} fork:true`

    const response = await withRetry(() =>
      octokit.search.repos({
        q: searchQuery,
        per_page: limit,
        page,
        sort: 'updated',
        order: direction,
      }),
    )

    return response.data.items.map(repo => ({
      owner: repo.owner?.login || '',
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch || 'main',
    }))
  }

  // Otherwise, list all repos the user has access to
  const response = await withRetry(() =>
    octokit.repos.listForAuthenticatedUser({
      per_page: limit,
      page,
      sort,
      direction,
      affiliation: 'owner,collaborator,organization_member',
    }),
  )

  return response.data.map(repo => ({
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch || 'main',
  }))
}

/**
 * Lists open issues for a repository.
 *
 * @param accessToken - GitHub access token
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param limit - Maximum number of results
 * @returns List of open issues
 */
export async function listRepoIssues(
  accessToken: string,
  owner: string,
  repo: string,
  limit = 30,
): Promise<IssueDto[]> {
  const octokit = createClient(accessToken)

  const response = await withRetry(() =>
    octokit.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      per_page: limit,
      sort: 'updated',
      direction: 'desc',
    }),
  )

  // Filter out pull requests (GitHub API returns PRs as issues)
  return response.data
    .filter(issue => !issue.pull_request)
    .map(issue => ({
      number: issue.number,
      title: issue.title,
      state: issue.state as 'open' | 'closed',
    }))
}

/**
 * Lists branches for a repository.
 *
 * @param accessToken - GitHub access token
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param limit - Maximum number of results
 * @returns List of branches
 */
export async function listRepoBranches(
  accessToken: string,
  owner: string,
  repo: string,
  limit = 100,
): Promise<BranchDto[]> {
  const octokit = createClient(accessToken)

  const response = await withRetry(() =>
    octokit.repos.listBranches({
      owner,
      repo,
      per_page: limit,
    }),
  )

  return response.data.map(branch => ({
    name: branch.name,
    protected: branch.protected,
  }))
}

/**
 * Gets detailed information about a specific issue.
 *
 * @param accessToken - GitHub access token
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param issueNumber - Issue number
 * @returns Issue details
 */
export async function getIssueDetails(
  accessToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueDetailsDto> {
  const octokit = createClient(accessToken)

  const response = await withRetry(() =>
    octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    }),
  )

  return {
    number: response.data.number,
    title: response.data.title,
    body: response.data.body ?? null,
    state: response.data.state as 'open' | 'closed',
    labels: response.data.labels.map((label) => {
      if (typeof label === 'string')
        return label
      return label.name || ''
    }),
  }
}

/**
 * Validates that a repository exists and the user has access.
 *
 * @param accessToken - GitHub access token
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns True if accessible, false otherwise
 */
export async function validateRepoAccess(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  const octokit = createClient(accessToken)

  try {
    await withRetry(() =>
      octokit.repos.get({
        owner,
        repo,
      }),
    )
    return true
  }
  catch (error) {
    if ((error as { status?: number }).status === 404) {
      return false
    }
    throw error
  }
}

/**
 * Validates that a branch exists in a repository.
 *
 * @param accessToken - GitHub access token
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param branch - Branch name
 * @returns True if branch exists, false otherwise
 */
export async function validateBranch(
  accessToken: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const octokit = createClient(accessToken)

  try {
    await withRetry(() =>
      octokit.repos.getBranch({
        owner,
        repo,
        branch,
      }),
    )
    return true
  }
  catch (error) {
    if ((error as { status?: number }).status === 404) {
      return false
    }
    throw error
  }
}
